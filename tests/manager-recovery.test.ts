import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { TaskManager, type TaskManagerOptions } from '../runtime/manager.ts';
import { ModelProfiles } from '../runtime/model-profiles.ts';
import { createPiSession } from '../runtime/pi.ts';
import { ProviderManager } from '../runtime/provider-manager.ts';
import { openLocalCredentials } from '../runtime/local-credentials.ts';

type Wire = { model: string; messages: { role: string; content: unknown }[];
  tools: { function: { name: string } }[] };
type Call = { name: string; args: object };
type Snapshot = ReturnType<TaskManager['getSnapshot']>;
type Hit = { wire: Wire; route: string };
type Handler = (wire: Wire, res: ServerResponse, req: IncomingMessage) => void | Promise<void>;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function messageText(value: unknown): string {
  if (!record(value)) return '';
  if (typeof value.content === 'string') return value.content;
  return Array.isArray(value.content) ? value.content.filter(record).filter(part => part.type === 'text').map(part => part.text).join('\n') : '';
}

function completion(res: ServerResponse, value: string | Call) {
  const tool = typeof value !== 'string';
  const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call_' + randomUUID(),
    type: 'function', function: { name: value.name, arguments: JSON.stringify(value.args) } }] }
    : { role: 'assistant', content: value };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [chunk, reason] of [[delta, null], [{}, tool ? 'tool_calls' : 'stop']]) {
    res.write('data: ' + JSON.stringify({ id: 'recovery', object: 'chat.completion.chunk', created: 1,
      model: 'recovery', choices: [{ index: 0, delta: chunk, finish_reason: reason }] }) + '\n\n');
  }
  res.end('data: [DONE]\n\n');
}
function failure(res: ServerResponse) {
  res.writeHead(401, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { type: 'authentication_error', message: 'Controlled worker failure 82741' } }));
}
function parent(wire: Wire) { return wire.tools.some(tool => tool.function.name === 'spawn_agent'); }
function users(wire: Wire) { return wire.messages.filter(message => message.role === 'user'); }
function input(wire: Wire) { return JSON.stringify(users(wire).at(-1)?.content); }
function outputs(wire: Wire): string[] {
  const latestUser = wire.messages.findLastIndex(message => message.role === 'user');
  return wire.messages.slice(latestUser + 1).filter(message => message.role === 'tool').map(message => String(message.content));
}
function task(snapshot: Snapshot, title: string) {
  const value = snapshot.tasks.find(task => task.title === title); assert.ok(value, 'Missing task: ' + title); return value;
}
function attempt(snapshot: Snapshot, id: string) {
  const value = snapshot.attempts.find(attempt => attempt.id === id); assert.ok(value, 'Missing attempt'); return value;
}
function when(manager: TaskManager, predicate: (snapshot: Snapshot) => boolean): Promise<Snapshot> {
  if (predicate(manager.getSnapshot())) return Promise.resolve(manager.getSnapshot());
  return new Promise(resolve => {
    let off = () => {};
    off = manager.subscribe(() => { const snapshot = manager.getSnapshot(); if (predicate(snapshot)) { off(); resolve(snapshot); } });
  });
}
function terminal(manager: TaskManager) {
  return when(manager, s => ['succeeded', 'failed', 'cancelled', 'paused'].includes(s.run.status));
}

// Control only the provider. Pi transcripts, TaskManager, SQLite, the scheduler and CSV MCP are real.
async function fixture(t: TestContext, handler: Handler) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'athena-manager-recovery-')));
  const hits: Hit[] = [];
  const server = createServer(async (req, res) => {
    if (req.url?.endsWith('/models')) {
      res.end(JSON.stringify({ data: [{ id: req.url.startsWith('/a/') ? 'fixture-a' : 'fixture-b' }] })); return;
    }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const wire: Wire = JSON.parse(Buffer.concat(chunks).toString());
    hits.push({ wire, route: req.url ?? '' });
    await handler(wire, res, req);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = 'http://127.0.0.1:' + address.port;
  const values = { ATHENA_ENDPOINT: origin + '/v1', ATHENA_MODEL: 'recovery', ATHENA_PROVIDER: '',
    ATHENA_API_KEY: '', ATHENA_MODEL_CONCURRENCY: '2', ATHENA_MAX_CHILDREN: '3', ATHENA_MAX_DEPTH: '1' };
  const previous = Object.entries(values).map(([key, value]) => {
    const old = process.env[key]; process.env[key] = value; return { key, old };
  });
  const managers: TaskManager[] = [];
  t.after(async () => {
    try { for (const manager of managers) await manager.close(); }
    finally {
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      for (const { key, old } of previous) { if (old === undefined) delete process.env[key]; else process.env[key] = old; }
      await rm(directory, { recursive: true, force: true });
    }
  });
  return { directory, origin, hits, async manager(options: Pick<TaskManagerOptions, 'models' | 'createPiSession'> = {}) {
    const manager = new TaskManager({ dataDir: directory, ...options }); managers.push(manager); await manager.initialize(); return manager;
  } };
}
async function session(manager: TaskManager) {
  const { project } = await manager.createProject({ name: 'Recovery fixtures' });
  return manager.createSession({ projectId: project.id, title: 'Recovery' });
}
function coordinator(wire: Wire, res: ServerResponse, names: string[], grants?: Record<string, string[]>) {
  const results = outputs(wire);
  if (users(wire).length > 1) {
    completion(res, results.length ? 'Reconciled the preserved and recovered results.' : { name: 'list_tasks', args: {} }); return;
  }
  const name = names[results.length];
  if (name) completion(res, { name: 'spawn_agent', args: { title: name, prompt: name, fileIds: grants?.[name] } });
  else if (results.length === names.length) completion(res, { name: 'wait_for_agents', args: {} });
  else completion(res, 'Reported the original child outcomes.');
}

test('one failed child gets a new attempt; duplicate retries preserve completed work, receipts, grants and artifact versions', { timeout: 30_000 }, async t => {
  let recovering = false, foreign = '';
  const grants: Record<string, string[]> = {};
  const fixtureState = await fixture(t, (wire, res) => {
    if (parent(wire)) { coordinator(wire, res, ['Stable worker', 'Broken worker'], grants); return; }
    const results = outputs(wire);
    if (input(wire).includes('Stable worker')) {
      completion(res, results.length ? 'Stable output remains 9.' : { name: 'calculate_csv', args: {} }); return;
    }
    if (!recovering) {
      if (!results.length) completion(res, { name: 'calculate_rc_response', args: {} }); else failure(res);
      return;
    }
    if (!results.length) completion(res, { name: 'calculate_rc_response', args: { fileId: foreign } });
    else if (results.length === 1) { assert.match(results[0]!, /grant/i); completion(res, { name: 'calculate_rc_response', args: {} }); }
    else completion(res, 'Recovered RC time constant is ' + JSON.parse(results[1]!).response.timeConstantSeconds + ' s.');
  });
  let manager = await fixtureState.manager(); const activation = await session(manager);
  const extra = await manager.stageFiles(activation.sessionId, [{ name: 'private.csv', mimeType: 'text/csv',
    data: Buffer.from('private\nsecret-value-92654\n').toString('base64') }]);
  foreign = extra.fileReferences[0]!.id;
  const { fileReferences } = await manager.stageFiles(activation.sessionId, [{ name: 'scores.csv', mimeType: 'text/csv',
    data: Buffer.from('score\n7\n11\n').toString('base64') }, { name: 'circuit.json', mimeType: 'application/json',
    data: Buffer.from(JSON.stringify({ schemaVersion: 1, resistanceOhm: 10000, capacitanceFarad: 1e-7,
      inputVolt: 1, sampleTimesSeconds: [0, 0.001, 0.005] })).toString('base64') }]);
  grants['Stable worker'] = [fileReferences[0]!.id];
  grants['Broken worker'] = [fileReferences[1]!.id];
  const prompt = { type: 'prompt', id: 'original-results', message: 'Delegate once and keep all outputs.', fileReferences };
  await manager.pi(activation.sessionId, prompt); const before = await terminal(manager);
  const stable = task(before, 'Stable worker'), broken = task(before, 'Broken worker');
  assert.equal(stable.status, 'succeeded'); assert.equal(broken.status, 'failed'); assert.ok(broken.attemptId);
  assert.equal(before.artifacts.length, 2);
  const originalReceipt = await manager.pi(activation.sessionId, prompt);
  const originalAttempt = attempt(before, broken.attemptId);
  const rootAttempt = before.attempts.find(a => !a.parentTaskId); assert.ok(rootAttempt);
  const existingDownloads = await Promise.all(before.artifacts.map(async a => ({ id: a.id,
    bytes: (await manager.artifactDownload(activation.sessionId, a.id)).bytes })));
  const stableHits = fixtureState.hits.filter(h => !parent(h.wire) && input(h.wire).includes('Stable worker')).length;
  await assert.rejects(manager.retryTask(stable.id, { requestId: 'success-is-not-retryable', expectedAttemptId: stable.attemptId! }), { code: 'TASK_NOT_RETRYABLE' });
  recovering = true;
  const retry = { requestId: 'retry-results-once', expectedAttemptId: broken.attemptId };
  const [accepted, duplicate] = await Promise.all([manager.retryTask(broken.id, retry), manager.retryTask(broken.id, retry)]);
  assert.deepEqual(duplicate, accepted); assert.notEqual(accepted.attemptId, originalAttempt.id);
  assert.equal(accepted.taskId, broken.id); assert.equal(accepted.runId, before.run.id);
  assert.equal(accepted.agentSessionId, broken.agentSessionId);
  assert.equal(accepted.status, 'queued');
  await assert.rejects(manager.retryTask(broken.id, { ...retry, expectedAttemptId: accepted.attemptId }), { code: 'REQUEST_ID_CONFLICT' });
  await assert.rejects(manager.retryTask(broken.id, { ...retry, requestId: 'stale-source' }), { code: 'STALE_ATTEMPT' });
  const after = await terminal(manager);
  assert.equal(after.run.status, 'succeeded'); assert.equal(task(after, 'Broken worker').status, 'succeeded');
  assert.deepEqual(task(after, 'Stable worker'), stable);
  for (const old of before.attempts) assert.deepEqual(attempt(after, old.id), old);
  for (const old of before.tools) assert.deepEqual(after.tools.find(t => t.id === old.id), old);
  for (const old of before.artifacts) assert.deepEqual(after.artifacts.find(a => a.id === old.id), old);
  assert.deepEqual(attempt(after, accepted.attemptId).fileIds, originalAttempt.fileIds);
  assert.deepEqual(attempt(after, accepted.attemptId).artifactGrants, originalAttempt.artifactGrants);
  assert.deepEqual(attempt(after, accepted.attemptId).model, originalAttempt.model ?? before.run.model);
  assert.deepEqual(after.attempts.filter(a => a.taskId === broken.id).map(a => a.id), [originalAttempt.id, accepted.attemptId]);
  assert.equal(after.attempts.filter(a => !a.parentTaskId).length, 2);
  assert.notEqual(attempt(after, accepted.reconciliationAttemptId).prompt, rootAttempt.prompt);
  assert.equal(fixtureState.hits.filter(h => !parent(h.wire) && input(h.wire).includes('Stable worker')).length, stableHits);
  assert.equal(fixtureState.hits.filter(h => parent(h.wire) && users(h.wire).length === 1).length, 4);
  assert.equal(after.artifacts.length, 3);
  assert.equal(task(after, 'Broken worker').result, 'Recovered RC time constant is 0.001 s.');
  const published = after.artifacts.find(row => row.attemptId === accepted.attemptId);
  assert.ok(published);
  assert.equal(published.title, 'rc-response.json');
  assert.equal(published.evidence[0]?.id, fileReferences[1]!.id);
  const process = after.processes.find(row => row.id === published.processId);
  assert.equal(process?.job.mcp?.alias, 'calculate_rc_response');
  assert.equal(process?.toolId, published.toolId);
  assert.equal(process?.status, 'succeeded');
  for (const old of existingDownloads) {
    const saved = await manager.artifactDownload(activation.sessionId, old.id);
    assert.deepEqual(saved.bytes, old.bytes);
    assert.equal(createHash('sha256').update(saved.bytes).digest('hex'), after.artifacts.find(a => a.id === old.id)!.file.sha256);
  }
  assert.doesNotMatch(JSON.stringify(fixtureState.hits), /secret-value-92654/);
  assert.deepEqual(await manager.pi(activation.sessionId, prompt), originalReceipt);
  assert.deepEqual(await manager.retryTask(broken.id, retry), accepted);
  await manager.close(); manager = await fixtureState.manager();
  assert.deepEqual(manager.getSnapshot().processes, after.processes);
  const restoredRC = await manager.artifactDownload(activation.sessionId, published.id);
  assert.equal(createHash('sha256').update(restoredRC.bytes).digest('hex'), published.file.sha256);
  const calls = fixtureState.hits.length;
  assert.deepEqual(await manager.retryTask(broken.id, retry), accepted);
  assert.deepEqual(await manager.pi(activation.sessionId, prompt), originalReceipt);
  assert.equal(fixtureState.hits.length, calls);
  assert.deepEqual(manager.getSnapshot().attempts, after.attempts);
});

test('recovery rejects root, active, foreign-session and stale work; an accepted receipt survives a later run', { timeout: 20_000 }, async t => {
  let recovering = false;
  const laterArrived = Promise.withResolvers<ServerResponse>();
  const state = await fixture(t, (wire, res) => {
    if (parent(wire)) {
      if (input(wire).includes('A different active run')) { laterArrived.resolve(res); return; }
      coordinator(wire, res, ['Broken worker']); return;
    }
    if (recovering) completion(res, 'Recovered.'); else failure(res);
  });
  const manager = await state.manager(); const activation = await session(manager);
  const other = await manager.createSession({ projectId: activation.projectId!, title: 'Other conversation' });
  await manager.openSession(activation.sessionId);
  await manager.pi(activation.sessionId, { type: 'prompt', id: 'scope-source', message: 'Delegate.' });
  const before = await terminal(manager), broken = task(before, 'Broken worker'); assert.ok(broken.attemptId);
  const root = before.tasks.find(t => !t.parentTaskId); assert.ok(root?.attemptId);
  await assert.rejects(manager.retryTask(root.id, { requestId: 'root', expectedAttemptId: root.attemptId }), { code: 'TASK_NOT_RETRYABLE' });
  await manager.openSession(other.sessionId);
  await assert.rejects(manager.retryTask(broken.id, { requestId: 'foreign', expectedAttemptId: broken.attemptId }), { code: 'TASK_SCOPE_MISMATCH' });
  await manager.openSession(activation.sessionId);
  recovering = true;
  const request = { requestId: 'accepted-before-next-run', expectedAttemptId: broken.attemptId };
  const accepted = await manager.retryTask(broken.id, request); await terminal(manager);
  await manager.pi(activation.sessionId, { type: 'prompt', id: 'later-run', message: 'A different active run' });
  const held = await laterArrived.promise;
  const activeRoot = manager.getSnapshot().tasks.find(t => t.runId === manager.getSnapshot().run.id && !t.parentTaskId); assert.ok(activeRoot?.attemptId);
  await assert.rejects(manager.retryTask(activeRoot.id, { requestId: 'active-root', expectedAttemptId: activeRoot.attemptId }), { code: 'TASK_NOT_RETRYABLE' });
  await assert.rejects(manager.retryTask(broken.id, { requestId: 'busy-old', expectedAttemptId: accepted.attemptId }), { code: 'RUN_BUSY' });
  assert.deepEqual(await manager.retryTask(broken.id, request), accepted);
  completion(held, 'Later run complete.'); await terminal(manager);
  await assert.rejects(manager.retryTask(broken.id, { requestId: 'old-run', expectedAttemptId: accepted.attemptId }), { code: 'STALE_RUN' });
  assert.deepEqual(await manager.retryTask(broken.id, request), accepted);
});

test('retry accepted at cancellation settlement cannot overlap or be overwritten by the old child response', { timeout: 20_000 }, async t => {
  const first = Promise.withResolvers<ServerResponse>(), second = Promise.withResolvers<ServerResponse>();
  const disconnected = Promise.withResolvers<void>(); let childCalls = 0;
  const state = await fixture(t, (wire, res) => {
    if (parent(wire)) { coordinator(wire, res, ['Held worker']); return; }
    childCalls++;
    if (childCalls === 1) {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': first held turn\n\n');
      res.once('close', () => { if (!res.writableEnded) disconnected.resolve(); }); first.resolve(res);
    } else second.resolve(res);
  });
  const manager = await state.manager(), activation = await session(manager);
  await manager.pi(activation.sessionId, { type: 'prompt', id: 'cancel-at-settlement', message: 'Delegate then wait.' });
  const oldResponse = await first.promise;
  const child = task(manager.getSnapshot(), 'Held worker'); assert.ok(child.attemptId && child.agentSessionId);
  await assert.rejects(manager.retryTask(child.id, { requestId: 'still-active', expectedAttemptId: child.attemptId }), { code: 'TASK_NOT_RETRYABLE' });
  const retry = Promise.withResolvers<Awaited<ReturnType<TaskManager['retryTask']>>>(); let requested = false, peak = 0;
  const off = manager.subscribeAllPi((agentSessionId, event) => {
    if (!requested && agentSessionId === child.agentSessionId && event.type === 'agent_settled') {
      requested = true;
      manager.retryTask(child.id, { requestId: 'settlement-boundary', expectedAttemptId: child.attemptId! }).then(retry.resolve, retry.reject);
    }
  });
  const snapshots = manager.subscribe(() => { peak = Math.max(peak, manager.getSnapshot().attempts.filter(a => a.taskId === child.id && a.status === 'running').length); });
  t.after(off); t.after(snapshots);
  await manager.cancelTask(child.id);
  const accepted = await retry.promise;
  const response = await second.promise; await disconnected.promise;
  const cancelled = attempt(manager.getSnapshot(), child.attemptId); assert.equal(cancelled.status, 'cancelled');
  assert.equal(attempt(manager.getSnapshot(), accepted.attemptId).status, 'running');
  // The provider may finish an old response after the abort; its closed stream cannot change either attempt.
  oldResponse.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'STALE RESPONSE MUST NOT WIN' } }] }) + '\n\n'); oldResponse.end();
  completion(response, 'The new attempt owns this result.');
  const after = await terminal(manager);
  assert.equal(after.run.status, 'succeeded'); assert.equal(peak, 1); assert.equal(childCalls, 2);
  assert.deepEqual(attempt(after, child.attemptId), cancelled);
  assert.equal(attempt(after, accepted.attemptId).result, 'The new attempt owns this result.');
  assert.doesNotMatch(JSON.stringify(after.attempts), /STALE RESPONSE MUST NOT WIN/);
});

test('manual recovery of a cancelled run clears its cancellation decision without changing the original receipt', { timeout: 20_000 }, async t => {
  const held = Promise.withResolvers<void>(); let recovering = false;
  const state = await fixture(t, (wire, res) => {
    if (parent(wire)) { coordinator(wire, res, ['Cancelled worker']); return; }
    if (recovering) completion(res, 'Explicitly recovered.');
    else { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': held\n\n'); held.resolve(); }
  });
  const manager = await state.manager(), activation = await session(manager);
  const prompt = { type: 'prompt', id: 'cancelled-run', message: 'Delegate then wait.' };
  await manager.pi(activation.sessionId, prompt); await held.promise;
  const before = manager.getSnapshot(), child = task(before, 'Cancelled worker'); assert.ok(before.run.id && child.attemptId);
  await manager.cancelRun(before.run.id);
  const cancelled = manager.getSnapshot(); assert.equal(cancelled.run.status, 'cancelled');
  const receipt = await manager.pi(activation.sessionId, prompt);
  assert.ok(receipt !== null && typeof receipt === 'object' && 'success' in receipt); assert.equal(receipt.success, false);
  recovering = true;
  const accepted = await manager.retryTask(child.id, { requestId: 'recover-cancelled', expectedAttemptId: child.attemptId });
  const after = await terminal(manager); assert.equal(after.run.status, 'succeeded');
  assert.equal(attempt(after, accepted.attemptId).status, 'succeeded');
  for (const old of cancelled.attempts) assert.deepEqual(attempt(after, old.id), old);
  assert.deepEqual(await manager.pi(activation.sessionId, prompt), receipt);
});

test('cancelTask from the retry acceptance snapshot cancels the durable child before any provider dispatch', { timeout: 20_000 }, async t => {
  let recovering = false, childCalls = 0;
  const state = await fixture(t, (wire, res) => {
    if (parent(wire)) { coordinator(wire, res, ['Immediately cancelled worker']); return; }
    childCalls++;
    if (recovering) completion(res, 'This retry must never be dispatched.'); else failure(res);
  });
  const manager = await state.manager(), activation = await session(manager);
  await manager.pi(activation.sessionId, { type: 'prompt', id: 'cancel-before-dispatch', message: 'Delegate.' });
  const before = await terminal(manager), child = task(before, 'Immediately cancelled worker'); assert.ok(child.attemptId);
  const cancellation = Promise.withResolvers<unknown>(); let requested = false;
  const off = manager.subscribe(snapshot => {
    if (!requested && snapshot.events.some(event => event.type === 'task_retry_accepted' && event.taskId === child.id)) {
      requested = true; manager.cancelTask(child.id).then(cancellation.resolve, cancellation.reject);
    }
  }); t.after(off);
  recovering = true;
  const request = { requestId: 'cancel-on-accept', expectedAttemptId: child.attemptId };
  const accepted = await manager.retryTask(child.id, request); await cancellation.promise;
  const after = await terminal(manager);
  assert.equal(after.run.status, 'succeeded'); assert.equal(childCalls, 1);
  assert.equal(attempt(after, accepted.attemptId).status, 'cancelled');
  assert.equal(attempt(after, accepted.attemptId).startedAt, null);
  assert.deepEqual(attempt(after, child.attemptId), attempt(before, child.attemptId));
  const reconciliation = attempt(after, accepted.reconciliationAttemptId);
  assert.equal(reconciliation.status, 'succeeded');
  assert.match(reconciliation.prompt, /"status":"cancelled"/);
  assert.equal(after.tools.filter(tool => tool.attemptId === accepted.attemptId).length, 0);
  const calls = state.hits.length; assert.deepEqual(await manager.retryTask(child.id, request), accepted); assert.equal(state.hits.length, calls);
});

test('cancelRun during retry preparation wins over the pending acceptance; a later explicit retry still works', { timeout: 20_000 }, async t => {
  const draining = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), held = Promise.withResolvers<void>();
  let delayCompletion = true, recovering = false;
  t.after(() => { release.resolve(); });
  const state = await fixture(t, (wire, res) => {
    if (parent(wire)) { coordinator(wire, res, ['Broken worker', 'Held sibling']); return; }
    if (input(wire).includes('Held sibling')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': held sibling\n\n'); held.resolve(); return;
    }
    if (recovering) completion(res, 'Explicit recovery after the cancellation.'); else failure(res);
  });
  const manager = await state.manager({ createPiSession: async options => {
    const real = await createPiSession(options);
    return { ...real, async prompt(message: string, runOptions?: Parameters<typeof real.prompt>[1]) {
      await real.prompt(message, runOptions);
      // Delay only the SDK completion promise, keeping its real terminal events and history.
      if (delayCompletion && options.orchestration?.role === 'child' && message.includes('Broken worker')) {
        delayCompletion = false; draining.resolve(); await release.promise;
      }
    } };
  } });
  const activation = await session(manager);
  await manager.pi(activation.sessionId, { type: 'prompt', id: 'cancel-preparing-retry', message: 'Delegate then wait.' });
  await Promise.all([draining.promise, held.promise]);
  const before = manager.getSnapshot(), child = task(before, 'Broken worker'); assert.ok(child.attemptId && before.run.id);
  assert.equal(child.status, 'failed'); assert.equal(before.run.status, 'blocked');
  const retry = manager.retryTask(child.id, { requestId: 'must-not-resurrect', expectedAttemptId: child.attemptId });
  const cancelling = manager.cancelRun(before.run.id);
  const results = Promise.allSettled([retry, cancelling]); release.resolve();
  const [retryResult, cancelResult] = await results;
  assert.equal(retryResult.status, 'rejected');
  if (retryResult.status === 'rejected') assert.equal(retryResult.reason.code, 'RUN_CANCELLED');
  assert.equal(cancelResult.status, 'fulfilled');
  const cancelled = manager.getSnapshot(); assert.equal(cancelled.run.status, 'cancelled');
  assert.deepEqual(cancelled.attempts.map(a => a.id), before.attempts.map(a => a.id));
  assert.equal(cancelled.events.filter(e => e.type === 'task_retry_accepted').length, 0);
  const saved = new DatabaseSync(join(state.directory, 'workspace.sqlite'), { readOnly: true });
  try { assert.equal(saved.prepare("SELECT count(*) AS count FROM records WHERE kind='retry' AND session_id=?").get(activation.sessionId)?.count, 0); }
  finally { saved.close(); }
  assert.equal(state.hits.filter(h => !parent(h.wire) && input(h.wire).includes('Broken worker')).length, 1);
  recovering = true;
  const accepted = await manager.retryTask(child.id, { requestId: 'later-explicit-retry', expectedAttemptId: child.attemptId });
  const after = await terminal(manager);
  assert.equal(after.run.status, 'succeeded'); assert.equal(attempt(after, accepted.attemptId).status, 'succeeded');
  assert.deepEqual(task(after, 'Held sibling'), task(cancelled, 'Held sibling'));
});

test('host death after retry acceptance restores paused attempts and replays neither prompt nor retry receipt', { timeout: 30_000 }, async t => {
  const retryArrived = Promise.withResolvers<void>(); let mode: 'fail' | 'hold' | 'recover' = 'fail';
  const state = await fixture(t, (wire, res) => {
    if (parent(wire)) { coordinator(wire, res, ['Interrupted worker']); return; }
    if (mode === 'fail') failure(res);
    else if (mode === 'hold') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': held retry\n\n'); retryArrived.resolve(); }
    else completion(res, 'Recovered only after the new manual request.');
  });
  let manager = await state.manager(); const activation = await session(manager);
  const prompt = { type: 'prompt', id: 'crash-source', message: 'Delegate.' };
  await manager.pi(activation.sessionId, prompt); const before = await terminal(manager);
  const child = task(before, 'Interrupted worker'); assert.ok(child.attemptId);
  const receipt = await manager.pi(activation.sessionId, prompt);
  await manager.close(); mode = 'hold';
  const request = { requestId: 'crashed-retry', expectedAttemptId: child.attemptId };
  const source = `
    import { TaskManager } from ${JSON.stringify(new URL('../runtime/manager.ts', import.meta.url).href)};
    const manager = new TaskManager({dataDir:${JSON.stringify(state.directory)}}); await manager.initialize();
    const accepted = await manager.retryTask(${JSON.stringify(child.id)}, ${JSON.stringify(request)});
    process.send(accepted);
  `;
  const host = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = ''; assert.ok(host.stderr); host.stderr.on('data', value => { errors += String(value); });
  t.after(() => { if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL'); });
  const [[accepted]]: [[Awaited<ReturnType<TaskManager['retryTask']>>], void] = await Promise.all([once(host, 'message'), retryArrived.promise]) as [[Awaited<ReturnType<TaskManager['retryTask']>>], void];
  const exit = once(host, 'exit'); host.kill('SIGKILL'); assert.deepEqual(await exit, [null, 'SIGKILL'], errors);
  const calls = state.hits.length;
  manager = await state.manager(); const restored = manager.getSnapshot();
  assert.equal(restored.run.status, 'paused');
  assert.equal(attempt(restored, accepted.attemptId).status, 'paused');
  assert.equal(attempt(restored, accepted.reconciliationAttemptId).status, 'paused');
  for (const old of before.attempts) assert.deepEqual(attempt(restored, old.id), old);
  assert.equal(state.hits.length, calls);
  assert.deepEqual(await manager.retryTask(child.id, request), accepted);
  assert.deepEqual(await manager.pi(activation.sessionId, prompt), receipt);
  assert.equal(state.hits.length, calls);
  assert.deepEqual(manager.getSnapshot().attempts, restored.attempts);
  mode = 'recover';
  const recovered = await manager.retryTask(child.id, { requestId: 'manual-after-restart', expectedAttemptId: accepted.attemptId });
  const after = await terminal(manager); assert.equal(after.run.status, 'succeeded');
  assert.notEqual(recovered.attemptId, accepted.attemptId);
  assert.equal(attempt(after, recovered.attemptId).status, 'succeeded');
  for (const old of restored.attempts) assert.deepEqual(attempt(after, old.id), old);
  const settledCalls = state.hits.length;
  assert.deepEqual(await manager.retryTask(child.id, request), accepted);
  assert.deepEqual(await manager.pi(activation.sessionId, prompt), receipt);
  assert.equal(state.hits.length, settledCalls);
});

test('reconciliation cannot spawn, resend or cancel a worker even if the provider asks it to', { timeout: 20_000 }, async t => {
  let recovering = false, childId = ''; const denials: string[] = [];
  const state = await fixture(t, (wire, res) => {
    if (!parent(wire)) { if (recovering) completion(res, 'Worker recovered.'); else failure(res); return; }
    if (users(wire).length === 1) { coordinator(wire, res, ['Protected worker']); return; }
    const results = outputs(wire);
    if (results.length) denials.push(results.at(-1)!);
    const mutations: Call[] = [
      { name: 'spawn_agent', args: { title: 'Unrequested worker', prompt: 'This must not execute.' } },
      { name: 'send_to_agent', args: { taskId: childId, message: 'This must not execute.' } },
      { name: 'cancel_task', args: { taskId: childId } },
    ];
    completion(res, mutations[results.length] ?? 'Only the recovered results were summarized.');
  });
  const manager = await state.manager(), activation = await session(manager);
  await manager.pi(activation.sessionId, { type: 'prompt', id: 'read-only-recovery', message: 'Delegate.' });
  const before = await terminal(manager), child = task(before, 'Protected worker'); childId = child.id; assert.ok(child.attemptId);
  recovering = true;
  const accepted = await manager.retryTask(child.id, { requestId: 'protected-retry', expectedAttemptId: child.attemptId });
  const after = await terminal(manager);
  assert.equal(after.run.status, 'succeeded'); assert.equal(after.tasks.length, before.tasks.length);
  assert.equal(after.attempts.filter(a => a.taskId === child.id).length, 2);
  assert.equal(attempt(after, accepted.attemptId).status, 'succeeded');
  assert.equal(denials.length, 3);
  for (const denial of denials) assert.match(denial, /reconcil|read.only|recovery|not available|unavailable/i);
  assert.equal(after.tools.filter(t => t.attemptId === accepted.reconciliationAttemptId && t.status === 'failed').length, 3);
});

test('reconciliation context stays hidden in live and restored Pi history while identical user text remains ordinary input', { timeout: 20_000 }, async t => {
  let recovering = false;
  const state = await fixture(t, (wire, res) => {
    if (parent(wire)) { coordinator(wire, res, ['History worker']); return; }
    if (recovering) completion(res, 'Recovered worker report.'); else failure(res);
  });
  let manager = await state.manager(); const activation = await session(manager);
  const events: Record<string, unknown>[] = [];
  const off = manager.subscribePi(activation.sessionId, event => { events.push(structuredClone(event)); }); t.after(off);
  await manager.pi(activation.sessionId, { type: 'prompt', id: 'hidden-context-source', message: 'Delegate once.' });
  const before = await terminal(manager), child = task(before, 'History worker'); assert.ok(child.attemptId);
  const beforeHistory = await manager.getAgentHistory(activation.sessionId, activation.sessionId);
  const originalUsers = beforeHistory.messages.filter(record).filter(message => message.role === 'user');
  assert.equal(originalUsers.length, 1);
  recovering = true;
  const accepted = await manager.retryTask(child.id, { requestId: 'hidden-context-retry', expectedAttemptId: child.attemptId });
  const recovered = await terminal(manager); assert.equal(recovered.run.status, 'succeeded');
  const history = await manager.getAgentHistory(activation.sessionId, activation.sessionId);
  const messages = history.messages.filter(record);
  assert.deepEqual(messages.filter(message => message.role === 'user'), originalUsers);
  const hidden = messages.filter(message => message.role === 'custom'); assert.equal(hidden.length, 1);
  const context = hidden[0]!;
  assert.equal(context.customType, 'athena-reconciliation'); assert.equal(context.display, false);
  assert.equal(messageText(context), attempt(recovered, accepted.reconciliationAttemptId).prompt);
  assert.ok(messageText(context).includes(child.id), 'The model retains the real orchestration context.');
  const liveContext = events.filter(event => event.type === 'message_end' && record(event.message) && event.message.role === 'custom');
  assert.equal(liveContext.length, 1); assert.deepEqual(liveContext[0]!.message, context);
  assert.deepEqual(events.filter(event => event.type === 'message_end' && record(event.message) && event.message.role === 'user').map(event => event.message), originalUsers);
  const tool = recovered.tools.find(tool => tool.attemptId === accepted.reconciliationAttemptId && tool.name === 'list_tasks'); assert.ok(tool);
  const savedResult = messages.find(message => message.role === 'toolResult' && message.toolCallId === tool.id);
  assert.ok(savedResult); assert.equal(typeof savedResult.rawToolCallId, 'string'); assert.notEqual(savedResult.rawToolCallId, tool.id);
  assert.ok(events.some(event => event.type === 'tool_execution_end' && event.toolCallId === tool.id));
  assert.ok(messages.some(message => message.role === 'assistant' && Array.isArray(message.content) && message.content.some(part =>
    record(part) && part.type === 'toolCall' && part.id === tool.id && part.rawToolCallId === savedResult.rawToolCallId)));

  // Visibility is metadata-driven: the exact same bytes sent by the user remain a real user turn.
  const identicalUserText = messageText(context);
  await manager.pi(activation.sessionId, { type: 'prompt', id: 'literal-user-context', message: identicalUserText });
  assert.equal((await terminal(manager)).run.status, 'succeeded');
  const completeHistory = await manager.getAgentHistory(activation.sessionId, activation.sessionId);
  const completeMessages = completeHistory.messages.filter(record);
  const actualUsers = completeMessages.filter(message => message.role === 'user'); assert.equal(actualUsers.length, 2);
  assert.deepEqual(actualUsers[0], originalUsers[0]); assert.equal(messageText(actualUsers[1]), identicalUserText);
  assert.equal(actualUsers[1]!.display, undefined); assert.equal(actualUsers[1]!.customType, undefined);
  assert.equal(completeMessages.filter(message => message.role === 'custom').length, 1);
  const lastUserEvent = events.findLast(event => event.type === 'message_end' && record(event.message) && event.message.role === 'user');
  assert.ok(lastUserEvent); assert.deepEqual(lastUserEvent.message, actualUsers[1]);
  await manager.close(); manager = await state.manager();
  assert.deepEqual(await manager.getAgentHistory(activation.sessionId, activation.sessionId), completeHistory);
});

test('recovery pins the original model revision after profile edits and a host restart', { timeout: 30_000 }, async t => {
  let recovering = false;
  const state = await fixture(t, (wire, res) => {
    if (parent(wire)) { coordinator(wire, res, ['Pinned worker']); return; }
    if (recovering) completion(res, 'Original pinned model recovered.'); else failure(res);
  });
  const providers = await ProviderManager.create(new InMemoryCredentialStore());
  await providers.registerCompatible({ id: 'recovery-a', name: 'A', endpoint: state.origin + '/a/v1' });
  await providers.registerCompatible({ id: 'recovery-b', name: 'B', endpoint: state.origin + '/b/v1' });
  const profiles = new ModelProfiles(state.directory, (provider, id) => providers.model(provider, id), provider => providers.endpoint(provider));
  t.after(async () => { profiles.close(); await providers.close(); });
  const models = { resolve: (conversation: string | null | undefined, project: string | null | undefined) => profiles.resolve(conversation, project),
    pin: (model: Parameters<ProviderManager['pin']>[0]) => providers.pin(model), requireProfile: (id: string) => { profiles.get(id); } };
  let manager = await state.manager({ models });
  const a = profiles.save({ name: 'A', provider: 'recovery-a', modelId: 'fixture-a' });
  const b = profiles.save({ name: 'B', provider: 'recovery-b', modelId: 'fixture-b' });
  const activation = await session(manager); manager.setProjectProfile(activation.projectId!, a.id);
  await manager.pi(activation.sessionId, { type: 'prompt', id: 'pinned-source', message: 'Delegate.' });
  const before = await terminal(manager), child = task(before, 'Pinned worker'); assert.ok(child.attemptId);
  const sourceAttempt = attempt(before, child.attemptId); assert.equal(sourceAttempt.model?.configurationRevision, 1);
  profiles.save({ ...a, name: 'A changed to B', provider: 'recovery-b', modelId: 'fixture-b' });
  manager.setConversationProfile(activation.sessionId, b.id);
  await manager.close(); manager = await state.manager({ models });
  const count = state.hits.length; recovering = true;
  const accepted = await manager.retryTask(child.id, { requestId: 'pin-original', expectedAttemptId: child.attemptId });
  const after = await terminal(manager); assert.equal(after.run.status, 'succeeded');
  assert.deepEqual(attempt(after, accepted.attemptId).model, sourceAttempt.model);
  assert.deepEqual(attempt(after, accepted.reconciliationAttemptId).model, sourceAttempt.model);
  const retried = state.hits.slice(count); assert.ok(retried.some(h => !parent(h.wire)));
  assert.ok(retried.every(h => h.route === '/a/v1/chat/completions' && h.wire.model === 'fixture-a'));
});

test('API-key retries survive reopening the same credential but reject replacements before acceptance or dispatch', { timeout: 30_000 }, async t => {
  const keyA = 'recovery-binding-fixture-A', keyB = 'recovery-binding-fixture-B';
  const headers: (string | undefined)[] = [];
  const state = await fixture(t, (wire, res, req) => {
    headers.push(req.headers.authorization);
    if (parent(wire)) {
      if (input(wire).includes('Start a new request')) completion(res, 'New request uses the current credential.');
      else coordinator(wire, res, ['Bound worker']);
    } else failure(res);
  });
  const authDir = join(state.directory, 'auth');
  let credentials = await openLocalCredentials(authDir);
  let providers = await ProviderManager.create(credentials, state.directory);
  const compatible = await providers.registerCompatible({ id: 'bound-provider', name: 'Bound', endpoint: state.origin + '/a/v1' }, keyA);
  const profileStore = () => new ModelProfiles(state.directory, (provider, id) => providers.model(provider, id), provider => providers.endpoint(provider));
  let profiles = profileStore(); profiles.saveEndpoint(compatible);
  const models = { resolve: (conversation: string | null | undefined, project: string | null | undefined) => profiles.resolve(conversation, project),
    pin: (model: Parameters<ProviderManager['pin']>[0]) => providers.pin(model), requireProfile: (id: string) => { profiles.get(id); } };
  let manager = await state.manager({ models });
  t.after(async () => { profiles.close(); await providers.close(); });
  const profile = profiles.save({ name: 'Bound', provider: compatible.id, modelId: 'fixture-a' });
  const activation = await session(manager); manager.setProjectProfile(activation.projectId!, profile.id);
  await manager.pi(activation.sessionId, { type: 'prompt', id: 'bound-source', message: 'Delegate.' });
  const before = await terminal(manager), original = task(before, 'Bound worker'); assert.ok(original.attemptId);
  const reference = attempt(before, original.attemptId).model!;
  assert.match(reference.authRef!, /^credential:v1:[a-f0-9]{64}$/u);
  const reopen = async () => {
    await manager.close(); profiles.close(); await providers.close();
    credentials = await openLocalCredentials(authDir);
    providers = await ProviderManager.create(credentials, state.directory);
    profiles = profileStore();
    for (const entry of profiles.compatibleProviders()) await providers.mountCompatible(entry);
    manager = await state.manager({ models });
  };
  await reopen();
  const same = await manager.retryTask(original.id, { requestId: 'same-credential', expectedAttemptId: original.attemptId });
  const retried = await terminal(manager), child = task(retried, 'Bound worker');
  assert.equal(child.status, 'failed'); assert.equal(child.attemptId, same.attemptId);
  assert.equal(attempt(retried, same.attemptId).model?.authRef, reference.authRef);
  assert.ok(headers.length); assert.ok(headers.every(value => value === 'Bearer ' + keyA));

  await providers.saveApiKey(compatible.id, keyB); await reopen();
  const current = manager.getSnapshot(), count = headers.length;
  await assert.rejects(manager.retryTask(child.id, { requestId: 'replacement-rejected', expectedAttemptId: same.attemptId }), { code: 'MODEL_UNAVAILABLE' });
  assert.equal(headers.length, count);
  assert.deepEqual(manager.getSnapshot().attempts, current.attempts);
  assert.equal(manager.getSnapshot().events.filter(e => e.type === 'task_retry_accepted').length,
    current.events.filter(e => e.type === 'task_retry_accepted').length);

  // Upgrade fixture: old records named a provider/type without identifying its key.
  await manager.close();
  const db = new DatabaseSync(join(state.directory, 'workspace.sqlite'));
  try {
    const row = db.prepare("SELECT body FROM records WHERE kind='attempt' AND id=?").get(same.attemptId);
    assert.ok(row && typeof row.body === 'string');
    const legacy = JSON.parse(row.body);
    legacy.model.authRef = compatible.id + ':api_key';
    db.prepare("UPDATE records SET body=? WHERE kind='attempt' AND id=?").run(JSON.stringify(legacy), same.attemptId);
  } finally { db.close(); }
  manager = await state.manager({ models });
  await assert.rejects(manager.retryTask(child.id, { requestId: 'legacy-rejected', expectedAttemptId: same.attemptId }), { code: 'MODEL_UNAVAILABLE' });
  assert.equal(headers.length, count);

  await manager.pi(activation.sessionId, { type: 'prompt', id: 'new-current-credential', message: 'Start a new request.' });
  const next = await terminal(manager); assert.equal(next.run.status, 'succeeded');
  assert.notEqual(next.run.model?.authRef, reference.authRef);
  assert.ok(headers.slice(count).length); assert.ok(headers.slice(count).every(value => value === 'Bearer ' + keyB));
  const history = await manager.getAgentHistory(activation.sessionId, activation.sessionId);
  const publicText = JSON.stringify({ snapshot: next, history });
  const privateKey = (await readFile(join(state.directory, 'provider-bindings', 'key.v1'), 'utf8')).trim();
  for (const secret of [keyA, keyB, privateKey]) assert.equal(publicText.includes(secret), false);
});

test('an in-flight API pin keeps its original key while a new run uses the replacement', { timeout: 30_000 }, async t => {
  const arrived = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const keyA = 'pin-binding-fixture-A', keyB = 'pin-binding-fixture-B';
  const headers: (string | undefined)[] = []; let held = false;
  t.after(() => release.resolve());
  const state = await fixture(t, async (wire, res, req) => {
    headers.push(req.headers.authorization);
    if (parent(wire)) {
      if (input(wire).includes('New run')) { completion(res, 'Current credential.'); return; }
      if (!held) { held = true; arrived.resolve(); await release.promise; }
      coordinator(wire, res, ['Pinned child']);
    } else completion(res, 'Original credential.');
  });
  const providers = await ProviderManager.create(new InMemoryCredentialStore());
  await providers.registerCompatible({ id: 'pinned-api', name: 'Pinned', endpoint: state.origin + '/a/v1' }, keyA);
  const profiles = new ModelProfiles(state.directory, (provider, id) => providers.model(provider, id), provider => providers.endpoint(provider));
  t.after(async () => { profiles.close(); await providers.close(); });
  const models = { resolve: (conversation: string | null | undefined, project: string | null | undefined) => profiles.resolve(conversation, project),
    pin: (model: Parameters<ProviderManager['pin']>[0]) => providers.pin(model), requireProfile: (id: string) => { profiles.get(id); } };
  const manager = await state.manager({ models });
  const profile = profiles.save({ name: 'Pinned', provider: 'pinned-api', modelId: 'fixture-a' });
  const activation = await session(manager); manager.setProjectProfile(activation.projectId!, profile.id);
  await manager.pi(activation.sessionId, { type: 'prompt', id: 'inflight-key', message: 'Delegate.' });
  await arrived.promise;
  await providers.saveApiKey('pinned-api', keyB); release.resolve();
  const original = await terminal(manager); assert.equal(original.run.status, 'succeeded');
  assert.equal(task(original, 'Pinned child').status, 'succeeded');
  assert.ok(headers.length > 1 && headers.every(value => value === 'Bearer ' + keyA));
  const count = headers.length;
  await manager.pi(activation.sessionId, { type: 'prompt', id: 'new-key', message: 'New run.' });
  const next = await terminal(manager); assert.equal(next.run.status, 'succeeded');
  assert.notEqual(next.run.model?.authRef, original.run.model?.authRef);
  assert.ok(headers.slice(count).length && headers.slice(count).every(value => value === 'Bearer ' + keyB));
});

test('three identical tool failures stop the actual Pi attempt; manual retry starts a fresh budget', { timeout: 30_000 }, async t => {
  let recovering = false;
  const state = await fixture(t, (wire, res) => {
    if (parent(wire)) { coordinator(wire, res, ['Stable worker', 'Loop worker']); return; }
    const results = outputs(wire);
    if (input(wire).includes('Stable worker')) {
      completion(res, results.length ? 'Preserved statistics.' : { name: 'calculate_csv', args: {} }); return;
    }
    if (!recovering || results.length < 2) completion(res, { name: 'read', args: { fileId: 'not-granted' } });
    else if (results.length === 2) completion(res, { name: 'read', args: {} });
    else completion(res, 'Recovered after correcting the tool input.');
  });
  const manager = await state.manager(), activation = await session(manager);
  const { fileReferences } = await manager.stageFiles(activation.sessionId, [{ name: 'scores.csv', mimeType: 'text/csv',
    data: Buffer.from('score\n12\n').toString('base64') }]);
  await manager.pi(activation.sessionId, { type: 'prompt', id: 'bounded-tool-loop', message: 'Delegate.', fileReferences });
  const before = await terminal(manager), child = task(before, 'Loop worker'); assert.ok(child.attemptId);
  assert.equal(child.status, 'failed'); assert.match(attempt(before, child.attemptId).error ?? '', /Stopped after 3 failures/);
  assert.equal(before.tools.filter(t => t.attemptId === child.attemptId && t.status === 'failed').length, 3);
  assert.equal(state.hits.filter(h => !parent(h.wire) && input(h.wire).includes('Loop worker')).length, 3);
  assert.equal(before.artifacts.length, 1);
  recovering = true;
  const accepted = await manager.retryTask(child.id, { requestId: 'fresh-budget', expectedAttemptId: child.attemptId });
  const after = await terminal(manager); assert.equal(after.run.status, 'succeeded');
  assert.equal(attempt(after, accepted.attemptId).status, 'succeeded');
  assert.equal(after.tools.filter(t => t.attemptId === accepted.attemptId && t.status === 'failed').length, 2);
  assert.deepEqual(attempt(after, child.attemptId), attempt(before, child.attemptId));
  assert.deepEqual(task(after, 'Stable worker'), task(before, 'Stable worker'));
  assert.deepEqual(after.artifacts, before.artifacts);
});
