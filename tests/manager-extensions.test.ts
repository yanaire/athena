import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile, realpath, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { privateTestDirectory } from './platform-test-helpers.ts';
import { TaskManager } from '../runtime/manager.ts';
import { openLocalCredentials } from '../runtime/local-credentials.ts';
import type { PluginManifest } from '../runtime/extensions.ts';
import type { ExternalServerDefinition } from '../runtime/external-mcp-client.ts';

type Wire = { messages: { role: string; content: unknown }[]; tools: { function: { name: string } }[] };
type Call = { name: string; args: object; id?: string };
type Snapshot = ReturnType<TaskManager['getSnapshot']>;
type Handler = (wire: Wire, response: ServerResponse) => void | Promise<void>;
const oldBody = 'PINNED_PROCEDURE_47186: report only the measured remote result.';
const newBody = 'REPLACEMENT_PROCEDURE_38147: a different future procedure.';
const unusedBody = 'UNSELECTED_PROCEDURE_94713: this body must not enter the conversation.';
const tokenA = 'external-credential-a-681437';
const tokenB = 'external-credential-b-193867';

function completion(res: ServerResponse, value: string | Call) {
  const tool = typeof value !== 'string';
  const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: value.id ?? 'call_' + randomUUID(),
    type: 'function', function: { name: value.name, arguments: JSON.stringify(value.args) } }] }
    : { role: 'assistant', content: value };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [chunk, reason] of [[delta, null], [{}, tool ? 'tool_calls' : 'stop']]) {
    res.write('data: ' + JSON.stringify({ id: 'extensions', object: 'chat.completion.chunk', created: 1,
      model: 'extensions', choices: [{ index: 0, delta: chunk, finish_reason: reason }] }) + '\n\n');
  }
  res.end('data: [DONE]\n\n');
}
function failure(res: ServerResponse) {
  res.writeHead(401, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { type: 'authentication_error', message: 'Controlled child failure after successful external computation.' } }));
}
function parent(wire: Wire) { return wire.tools.some(tool => tool.function.name === 'spawn_agent'); }
function users(wire: Wire) { return wire.messages.filter(message => message.role === 'user'); }
function input(wire: Wire) { return JSON.stringify(users(wire).at(-1)?.content); }
function outputs(wire: Wire): string[] {
  const last = wire.messages.findLastIndex(message => message.role === 'user');
  return wire.messages.slice(last + 1).filter(message => message.role === 'tool').map(message => String(message.content));
}
function task(snapshot: Snapshot, title: string) {
  const item = snapshot.tasks.find(row => row.title === title); assert.ok(item, 'Missing task: ' + title); return item;
}
function when(manager: TaskManager, predicate: (snapshot: Snapshot) => boolean): Promise<Snapshot> {
  if (predicate(manager.getSnapshot())) return Promise.resolve(manager.getSnapshot());
  return new Promise(resolve => {
    let off = () => {};
    off = manager.subscribe(() => { const value = manager.getSnapshot(); if (predicate(value)) { off(); resolve(value); } });
  });
}
function terminal(manager: TaskManager) {
  return when(manager, state => ['succeeded', 'failed', 'cancelled', 'paused'].includes(state.run.status));
}
async function body(req: IncomingMessage) {
  const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString());
}

// The provider is controlled; the Pi SDK, tool routing, HTTP MCP, queue, credentials,
// SQLite, artifact downloads and manual retry are real. This requires no WASI binary.
async function fixture(t: TestContext, handler: Handler) {
  const directory = await realpath(privateTestDirectory(join(tmpdir(), 'athena-manager-extensions-')));
  const hits: Wire[] = [], calls: { authorization: string | undefined; args: unknown }[] = [];
  const connection = { available: true, authorizations: [] as (string | undefined)[] };
  const provider = createServer(async (req, res) => {
    try { const wire = await body(req) as Wire; hits.push(wire); await handler(wire, res); }
    catch (error) { res.writeHead(500).end(JSON.stringify({ error: String(error) })); }
  });
  const mcp = createServer(async (req, res) => {
    if (req.method === 'DELETE') { res.writeHead(202).end(); return; }
    const message = await body(req);
    if (message.method === 'initialize') {
      connection.authorizations.push(req.headers.authorization);
      if (!connection.available) { req.socket.destroy(); return; }
    }
    if (String(message.method).startsWith('notifications/')) { res.writeHead(202).end(); return; }
    res.setHeader('content-type', 'application/json');
    let result: unknown;
    if (message.method === 'initialize') {
      res.setHeader('Mcp-Session-Id', 'manager-fixture');
      result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'manager-fixture', version: '1.0.0' } };
    } else if (message.method === 'tools/list') result = { tools: [{ name: 'double', description: 'Double an explicitly supplied number.', inputSchema: {
      type: 'object', properties: { value: { type: 'number' } }, required: ['value'], additionalProperties: false,
    } }] };
    else {
      calls.push({ authorization: req.headers.authorization, args: message.params.arguments });
      const credential = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
      result = { content: [{ type: 'text', text: String(message.params.arguments.value * 2) }],
        structuredContent: { doubled: message.params.arguments.value * 2, credentialEcho: credential } };
    }
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  provider.listen(0, '127.0.0.1'); mcp.listen(0, '127.0.0.1');
  await Promise.all([once(provider, 'listening'), once(mcp, 'listening')]);
  const providerAddress = provider.address(), mcpAddress = mcp.address();
  assert.ok(providerAddress && typeof providerAddress !== 'string' && mcpAddress && typeof mcpAddress !== 'string');
  const values = { ATHENA_ENDPOINT: `http://127.0.0.1:${providerAddress.port}/v1`, ATHENA_MODEL: 'extensions', ATHENA_PROVIDER: '',
    ATHENA_API_KEY: '', ATHENA_MODEL_CONCURRENCY: '2', ATHENA_MAX_CHILDREN: '3', ATHENA_MAX_DEPTH: '1' };
  const previous = Object.entries(values).map(([key, value]) => { const old = process.env[key]; process.env[key] = value; return { key, old }; });
  const definition: ExternalServerDefinition = { id: 'remote', name: 'External lab', transport: 'streamable-http',
    url: `http://127.0.0.1:${mcpAddress.port}/mcp`, allowedTools: ['double'], auth: 'bearer', timeoutMs: 2000 };
  const manifest: PluginManifest = { schemaVersion: 1, id: 'laboratory', name: 'Laboratory', description: 'Explicit research resources.', version: '1.0.0',
    skills: [{ id: 'inspect', name: 'Inspect remote measurement', description: 'Verify a remote measurement.', version: '1.0.0', body: oldBody,
      roles: ['child'], requiredCapabilities: ['call_external_mcp'] },
    { id: 'unused', name: 'Unused procedure', description: 'An unrelated optional procedure.', version: '1.0.0', body: unusedBody,
      roles: ['parent', 'child'], requiredCapabilities: [] }], mcpServers: [definition] };
  const managers: TaskManager[] = [];
  t.after(async () => {
    try { for (const manager of managers) await manager.close(); }
    finally {
      for (const server of [provider, mcp]) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
      for (const { key, old } of previous) { if (old === undefined) delete process.env[key]; else process.env[key] = old; }
      await rm(directory, { recursive: true, force: true });
    }
  });
  return { directory, manifest, hits, calls, connection,
    async manager() {
      const credentials = await openLocalCredentials(join(directory, 'external-auth'));
      const manager = new TaskManager({ dataDir: directory, externalCredentials: credentials });
      managers.push(manager); await manager.initialize(); return { manager, credentials };
    },
    async install(manager: TaskManager, projectId: string) {
      let state = manager.installPlugin(projectId, manifest);
      assert.equal(state.plugins.find(row => row.id === manifest.id)?.enabled, false);
      state = await manager.checkMcpServer(projectId, 'laboratory', 'remote', state.revision, { token: tokenA });
      return manager.setPluginEnabled(projectId, 'laboratory', true, state.revision);
    },
  };
}

test('a failed MCP recheck preserves the saved credential across restart without restoring verification or permission', { timeout: 30000 }, async t => {
  const f = await fixture(t, () => assert.fail('Checking an MCP connection must not call a model.'));
  let { manager, credentials } = await f.manager();
  const { project } = await manager.createProject({ name: 'Connection recovery' });
  let state = await f.install(manager, project.id);
  const saved = await credentials.list();
  assert.equal(saved.length, 1);
  const reference = saved[0]!.providerId;
  const publicViews: unknown[] = [state];
  f.connection.available = false;
  await assert.rejects(manager.checkMcpServer(project.id, 'laboratory', 'remote', state.revision), { code: 'MCP_CONNECTION_FAILED' });
  const failed = manager.getExtensions(project.id);
  const failedPlugin = failed.plugins.find(plugin => plugin.id === 'laboratory')!;
  assert.equal(failedPlugin.enabled, false);
  assert.equal(failedPlugin.servers[0]?.status, 'failed');
  assert.equal(failedPlugin.servers[0]?.verification, undefined);
  assert.throws(() => manager.setPluginEnabled(project.id, 'laboratory', true, failed.revision), /verification/);
  await manager.close();
  ({ manager, credentials } = await f.manager());
  const reopened = manager.getExtensions(project.id);
  assert.deepEqual(await credentials.list(), saved, 'A failed probe does not delete or rotate the stored token.');
  f.connection.available = true;
  state = await manager.checkMcpServer(project.id, 'laboratory', 'remote', reopened.revision, {});
  assert.equal(failedPlugin.servers[0]?.credentialConfigured, true);
  assert.equal(reopened.plugins.find(plugin => plugin.id === 'laboratory')?.servers[0]?.credentialConfigured, true);
  const recovered = state.plugins.find(plugin => plugin.id === 'laboratory')!;
  assert.equal(recovered.servers[0]?.status, 'verified');
  assert.equal(recovered.enabled, false, 'A successful recheck still requires explicit reenablement.');
  assert.deepEqual(await credentials.list(), saved, 'Blank-token rechecks reuse the same immutable reference.');
  assert.ok(f.connection.authorizations.every(value => value === 'Bearer ' + tokenA));
  publicViews.push(failed, reopened, state);
  state = manager.setPluginEnabled(project.id, 'laboratory', true, state.revision);

  // Revocation stays authoritative: an orphaned reference cannot recreate a key.
  await credentials.delete(reference);
  const beforeRevokedCheck = f.connection.authorizations.length;
  await assert.rejects(manager.checkMcpServer(project.id, 'laboratory', 'remote', state.revision), /credential is unavailable/);
  assert.equal(f.connection.authorizations.length, beforeRevokedCheck);
  assert.equal((await credentials.list()).length, 0);
  state = manager.getExtensions(project.id);
  assert.equal(state.plugins.find(plugin => plugin.id === 'laboratory')?.enabled, false);
  state = await manager.checkMcpServer(project.id, 'laboratory', 'remote', state.revision, { token: tokenB });
  const replacement = (await credentials.list())[0]!.providerId;
  assert.notEqual(replacement, reference);

  // A changed endpoint and a fresh installation must never inherit that token.
  const changed: PluginManifest = { ...f.manifest, version: '2.0.0', mcpServers: [{ ...f.manifest.mcpServers![0]!,
    url: f.manifest.mcpServers![0]!.url + '/changed' }] };
  state = manager.installPlugin(project.id, changed, state.revision);
  assert.equal(state.plugins.find(plugin => plugin.id === 'laboratory')?.servers[0]?.credentialConfigured, false);
  const beforeChangedCheck = f.connection.authorizations.length;
  await assert.rejects(manager.checkMcpServer(project.id, 'laboratory', 'remote', state.revision), /credential/);
  assert.equal(f.connection.authorizations.length, beforeChangedCheck);
  state = manager.removePlugin(project.id, 'laboratory', manager.getExtensions(project.id).revision);
  state = manager.installPlugin(project.id, f.manifest, state.revision);
  assert.equal(state.plugins.find(plugin => plugin.id === 'laboratory')?.servers[0]?.credentialConfigured, false);
  await assert.rejects(manager.checkMcpServer(project.id, 'laboratory', 'remote', state.revision), /credential/);
  assert.equal(f.connection.authorizations.length, beforeChangedCheck);
  assert.equal((await credentials.list())[0]?.providerId, replacement, 'Removing current configuration preserves credentials owned by historical pins.');
  publicViews.push(state, manager.getExtensions(project.id), manager.getSnapshot());
  const publicText = JSON.stringify(publicViews);
  for (const privateValue of [tokenA, tokenB, reference, replacement]) assert.ok(!publicText.includes(privateValue));
  assert.equal(f.hits.length, 0);
});

test('actual Pi uses selected skill bodies and pinned external credentials across update, removal, restart and child retry', { timeout: 45000 }, async t => {
  let recovering = false, csvId = '';
  const paused = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const f = await fixture(t, async (wire, res) => {
    const results = outputs(wire);
    if (parent(wire)) {
      if (users(wire).length > 1) { completion(res, results.length ? 'Reconciled original CSV and recovered external results.' : { name: 'list_tasks', args: {} }); return; }
      const sequence: Call[] = [
        { name: 'load_skill', args: { id: 'athena-research-intake', reason: 'Clarify the delegated measurement checks.', mode: 'automatic' } },
        { name: 'spawn_agent', args: { title: 'Stable CSV', prompt: 'Stable CSV', fileIds: [csvId] } },
        { name: 'spawn_agent', args: { title: 'External worker', prompt: 'External worker; explicitly use laboratory/inspect.', fileIds: [] } },
        { name: 'wait_for_agents', args: {} },
      ];
      completion(res, sequence[results.length] ?? 'Reported the original child outcomes.'); return;
    }
    if (input(wire).includes('Stable CSV')) { completion(res, results.length ? 'CSV mean is 19 mV.' : { name: 'calculate_csv', args: {} }); return; }
    if (!results.length) { completion(res, { name: 'load_skill', args: { id: 'laboratory/inspect', reason: 'The user explicitly selected the remote measurement procedure.' } }); return; }
    if (results.length === 1) {
      if (!recovering) { paused.resolve(); await release.promise; }
      completion(res, { name: 'call_external_mcp', args: { serverId: 'laboratory/remote', tool: 'double', arguments: { value: 7 } } }); return;
    }
    if (!recovering) failure(res); else completion(res, 'Recovered external value is ' + JSON.parse(results[1]!).result.result.structuredContent.doubled + '.');
  });
  let { manager, credentials } = await f.manager();
  const { project } = await manager.createProject({ name: 'Versioned extensions' });
  await f.install(manager, project.id);
  const originalCredential = (await credentials.list()).find(row => row.providerId.startsWith('athena.external-mcp/'));
  assert.ok(originalCredential); assert.match(originalCredential.providerId, /^athena\.external-mcp\/[a-f0-9-]{36}$/);
  assert.equal((await credentials.read(originalCredential.providerId))?.type, 'api_key');
  const activation = await manager.createSession({ projectId: project.id, title: 'Pinned external study' });
  const { fileReferences } = await manager.stageFiles(activation.sessionId, [{ name: 'voltage.csv', mimeType: 'text/csv',
    data: Buffer.from('voltage\n7\n13\n21\n35\n\n').toString('base64') }]);
  csvId = fileReferences[0]!.id;
  const events: unknown[] = [];
  manager.subscribe(snapshot => events.push(snapshot));
  manager.subscribePi(activation.sessionId, event => events.push(event));
  await manager.pi(activation.sessionId, { type: 'prompt', id: 'pinned-study', message: 'Delegate CSV and remote measurements.', fileReferences });
  await paused.promise;
  const firstWorkerRequest = f.hits.find(wire => !parent(wire) && input(wire).includes('External worker'));
  assert.ok(firstWorkerRequest); assert.doesNotMatch(JSON.stringify(firstWorkerRequest), /PINNED_PROCEDURE_47186|UNSELECTED_PROCEDURE_94713/);
  assert.ok(f.hits.some(wire => outputs(wire).some(result => result.includes(oldBody))), 'Only the selected tool result injects the skill body');
  let state = await manager.checkMcpServer(project.id, 'laboratory', 'remote', manager.getExtensions(project.id).revision, { token: tokenB });
  assert.equal(state.plugins.find(row => row.id === 'laboratory')?.enabled, false, 'Credential replacement requires explicit reenablement');
  state = manager.setPluginEnabled(project.id, 'laboratory', true, state.revision);
  state = manager.setPluginEnabled(project.id, 'laboratory', false, state.revision);
  state = manager.installPlugin(project.id, { ...f.manifest, version: '2.0.0', skills: f.manifest.skills!.map(skill =>
    skill.id === 'inspect' ? { ...skill, version: '2.0.0', body: newBody } : skill) }, state.revision);
  state = manager.removePlugin(project.id, 'laboratory', state.revision);
  assert.ok(!state.plugins.some(row => row.id === 'laboratory'));
  release.resolve();
  const before = await terminal(manager), stable = task(before, 'Stable CSV'), broken = task(before, 'External worker');
  assert.equal(stable.status, 'succeeded'); assert.equal(broken.status, 'failed'); assert.ok(broken.attemptId);
  assert.equal(before.artifacts.length, 2, 'A child model failure preserves its already-published successful computation');
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0]!.authorization, 'Bearer ' + tokenA);
  const existing = await Promise.all(before.artifacts.map(async artifact => ({ artifact,
    bytes: (await manager.artifactDownload(activation.sessionId, artifact.id)).bytes })));
  const csv = existing.find(row => row.artifact.title === 'statistics.json'); assert.ok(csv);
  assert.equal(JSON.parse(Buffer.from(csv.bytes).toString()).statistics[0].mean, 19);
  const remote = existing.find(row => row.artifact.title === 'mcp-result.json'); assert.ok(remote);
  assert.equal(JSON.parse(Buffer.from(remote.bytes).toString()).result.structuredContent.credentialEcho, '[redacted]');
  assert.equal(createHash('sha256').update(remote.bytes).digest('hex'), remote.artifact.file.sha256);
  await manager.close();
  ({ manager, credentials } = await f.manager());
  assert.ok(!manager.getExtensions(project.id).plugins.some(row => row.id === 'laboratory'));
  assert.equal((await credentials.list()).filter(row => row.providerId.startsWith('athena.external-mcp/')).length, 2);
  const originalSecret = await credentials.read(originalCredential.providerId); assert.ok(originalSecret);
  await credentials.delete(originalCredential.providerId);
  const priorAttempts = manager.getSnapshot().attempts, priorCalls = f.calls.length, priorProviderRequests = f.hits.length;
  await assert.rejects(manager.retryTask(broken.id, { requestId: 'missing-original-credential', expectedAttemptId: broken.attemptId }), { code: 'MCP_CREDENTIAL_UNAVAILABLE' });
  assert.deepEqual(manager.getSnapshot().attempts, priorAttempts);
  assert.equal(f.calls.length, priorCalls); assert.equal(f.hits.length, priorProviderRequests);
  assert.equal((await credentials.list()).length, 1, 'The newer credential remains but cannot replace the pinned credential');
  await credentials.modify(originalCredential.providerId, async () => originalSecret);
  const stableRequests = f.hits.filter(wire => !parent(wire) && input(wire).includes('Stable CSV')).length;
  recovering = true;
  const retryRequest = { requestId: 'retry-pinned-study', expectedAttemptId: broken.attemptId };
  const accepted = await manager.retryTask(broken.id, retryRequest);
  const after = await terminal(manager);
  assert.equal(task(after, 'External worker').status, 'succeeded'); assert.equal(after.run.status, 'succeeded');
  assert.equal(task(after, 'External worker').result, 'Recovered external value is 14.');
  assert.deepEqual(task(after, 'Stable CSV'), stable);
  assert.equal(f.hits.filter(wire => !parent(wire) && input(wire).includes('Stable CSV')).length, stableRequests);
  assert.deepEqual(f.calls.map(call => call.authorization), ['Bearer ' + tokenA, 'Bearer ' + tokenA]);
  assert.deepEqual(f.calls.map(call => call.args), [{ value: 7 }, { value: 7 }]);
  assert.equal(after.artifacts.length, 3);
  for (const old of existing) {
    assert.deepEqual(after.artifacts.find(row => row.id === old.artifact.id), old.artifact);
    assert.deepEqual((await manager.artifactDownload(activation.sessionId, old.artifact.id)).bytes, old.bytes);
  }
  const uses = manager.getExtensions(project.id).skillUses.filter(use => use.skillId === 'laboratory/inspect');
  assert.equal(uses.length, 2); assert.equal(uses[0]!.sha256, createHash('sha256').update(oldBody).digest('hex'));
  assert.equal(uses[1]!.sha256, uses[0]!.sha256); assert.equal(uses[1]!.pluginRevision, uses[0]!.pluginRevision);
  assert.equal(uses[1]!.attemptId, accepted.attemptId); assert.equal(uses[1]!.status, 'loaded');
  assert.deepEqual(uses[1]!.missingCapabilities, []); assert.ok(uses[1]!.effectiveCapabilities.includes('call_external_mcp'));
  assert.equal(uses[0]!.pinRevision, uses[1]!.pinRevision);
  assert.ok(uses.every(use => use.reason.includes('explicitly selected')));
  assert.doesNotMatch(JSON.stringify(f.hits), /REPLACEMENT_PROCEDURE_38147|UNSELECTED_PROCEDURE_94713/);
  const publicText = JSON.stringify([f.hits, events, manager.getSnapshot(), manager.getExtensions(project.id), existing.map(row => Buffer.from(row.bytes).toString())]);
  assert.ok(!publicText.includes(tokenA) && !publicText.includes(tokenB));
  assert.ok(!JSON.stringify(manager.getExtensions(project.id)).includes(originalCredential.providerId));
  assert.ok(!(await readFile(join(f.directory, 'workspace.sqlite'))).includes(Buffer.from(tokenA)), 'Secrets are stored outside the run database');
  const requestCount = f.hits.length;
  assert.deepEqual(await manager.retryTask(broken.id, retryRequest), accepted);
  assert.equal(f.hits.length, requestCount); assert.equal(f.calls.length, 2);
});

test('actual child tool routing rejects foreign-project resources and duplicate external request IDs never execute twice', { timeout: 30000 }, async t => {
  const f = await fixture(t, (wire, res) => {
    const results = outputs(wire);
    if (parent(wire)) {
      const sequence: Call[] = [{ name: 'spawn_agent', args: { title: 'Scoped worker', prompt: 'Check explicitly supplied external resource IDs.', fileIds: [] } },
        { name: 'wait_for_agents', args: {} }];
      completion(res, sequence[results.length] ?? 'The permitted tool executed once.'); return;
    }
    const sequence: Call[] = [
      { name: 'load_skill', args: { id: 'laboratory/inspect', reason: 'Attempt to access a skill enabled only in another project.' } },
      { name: 'call_external_mcp', args: { serverId: 'laboratory/remote', tool: 'double', arguments: { value: 4 } } },
      { name: 'call_external_mcp', id: 'call_same_external_request', args: { serverId: 'owned-lab/remote', tool: 'double', arguments: { value: 4 } } },
      { name: 'call_external_mcp', id: 'call_same_external_request', args: { serverId: 'owned-lab/remote', tool: 'double', arguments: { value: 4 } } },
      { name: 'call_external_mcp', id: 'call_same_external_request', args: { serverId: 'owned-lab/remote', tool: 'double', arguments: { value: 9 } } },
    ];
    completion(res, sequence[results.length] ?? 'Reported denied foreign resources, one measured result, and a conflicting duplicate.');
  });
  const { manager } = await f.manager();
  const { project: foreign } = await manager.createProject({ name: 'Foreign resources' });
  await f.install(manager, foreign.id);
  const { project: own } = await manager.createProject({ name: 'Own resources' });
  let extensions = manager.installPlugin(own.id, { ...f.manifest, id: 'owned-lab', skills: [] });
  extensions = await manager.checkMcpServer(own.id, 'owned-lab', 'remote', extensions.revision, { token: tokenB });
  manager.setPluginEnabled(own.id, 'owned-lab', true, extensions.revision);
  const { sessionId } = await manager.createSession({ projectId: own.id, title: 'Cross-project boundary' });
  await manager.pi(sessionId, { type: 'prompt', id: 'scope-check', message: 'Delegate a scope and request identity check.' });
  const result = await terminal(manager), worker = task(result, 'Scoped worker');
  assert.equal(worker.status, 'succeeded', worker.error);
  const workerRequests = f.hits.filter(wire => !parent(wire));
  const returned = outputs(workerRequests.at(-1)!);
  assert.match(returned[0]!, /not enabled/); assert.match(returned[1]!, /did not enable/);
  const first = JSON.parse(returned[2]!), duplicate = JSON.parse(returned[3]!);
  assert.deepEqual(duplicate, first, 'Identical tool call identity returns the original validated receipt');
  assert.match(returned[4]!, /already used with other arguments/);
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0], { authorization: 'Bearer ' + tokenB, args: { value: 4 } });
  assert.equal(result.processes.length, 1); assert.equal(result.artifacts.length, 1);
  assert.equal(result.processes[0]!.job.externalMcp?.serverId, 'owned-lab/remote');
  assert.equal(manager.getExtensions(own.id).skillUses.length, 0);
  assert.equal(manager.getExtensions(foreign.id).skillUses.length, 0);
  const saved = await manager.artifactDownload(sessionId, result.artifacts[0]!.id);
  assert.equal(JSON.parse(Buffer.from(saved.bytes).toString()).result.structuredContent.doubled, 8);
  assert.ok(!JSON.stringify(workerRequests).includes(tokenA) && !JSON.stringify(workerRequests).includes(tokenB));
});
