import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { privateTestDirectory } from './platform-test-helpers.ts';
import type { WorkspaceSnapshot } from '../athena-backend-handoff/athena-codex-ui/integrations/task-manager.d.ts';

function complete(res: ServerResponse, value: string | { name: string; args: object }) {
  const tool = typeof value !== 'string';
  const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function',
    function: { name: value.name, arguments: JSON.stringify(value.args) } }] } : { role: 'assistant', content: value };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [part, reason] of [[delta, null], [{}, tool ? 'tool_calls' : 'stop']]) {
    res.write('data: ' + JSON.stringify({ id: 'recovery-http', object: 'chat.completion.chunk', created: 1, model: 'fixture',
      choices: [{ index: 0, delta: part, finish_reason: reason }] }) + '\n\n');
  }
  res.end('data: [DONE]\n\n');
}

test('HTTP host retries its original endpoint without a saved profile and durably replays one receipt', { timeout: 20_000 }, async t => {
  let workerCalls = 0, coordinatorRecoveries = 0, providerCalls = 0;
  const provider = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const wire: { messages: { role: string; content: unknown }[]; tools: { function: { name: string } }[] } = JSON.parse(Buffer.concat(chunks).toString());
    providerCalls++;
    if (wire.tools.some(tool => tool.function.name === 'spawn_agent')) {
      const userTurns = wire.messages.filter(message => message.role === 'user');
      if (userTurns.length > 1) { coordinatorRecoveries++; complete(res, 'The worker recovered.'); return; }
      const results = wire.messages.filter(message => message.role === 'tool');
      if (!results.length) complete(res, { name: 'spawn_agent', args: { title: 'Endpoint worker', prompt: 'Perform the selected work.' } });
      else if (results.length === 1) complete(res, { name: 'wait_for_agents', args: {} });
      else complete(res, 'The worker failed; a manual retry is available.');
    } else if (++workerCalls === 1) {
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Synthetic first-attempt failure', type: 'authentication_error' } }));
    } else complete(res, 'Recovered worker output.');
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  const address = provider.address(); assert.ok(address && typeof address !== 'string');
  const directory = privateTestDirectory(join(tmpdir(), 'athena-recovery-http-'));
  const stops: (() => Promise<void>)[] = [];
  t.after(async () => {
    for (const stop of stops) await stop();
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const credentialKey = randomBytes(32).toString('hex');
  const start = async () => {
    const child = spawn(process.execPath, ['runtime/server.ts'], { env: { ...process.env,
      ATHENA_DATA_DIR: directory, ATHENA_PORT: '0', ATHENA_CREDENTIAL_KEY: credentialKey,
      ATHENA_ENDPOINT: `http://127.0.0.1:${address.port}/v1`, ATHENA_MODEL: 'fixture', ATHENA_API_KEY: '',
      ATHENA_MODEL_CONCURRENCY: '2', ATHENA_EXECUTION_PROJECTS: '' }, stdio: ['ignore', 'pipe', 'inherit'] });
    const exited = once(child, 'exit');
    const stop = async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await exited;
    };
    stops.push(stop);
    for await (const line of createInterface({ input: child.stdout })) if (line.startsWith('Athena listening at ')) {
      const base = line.slice('Athena listening at '.length);
      const rpc = async (method: string, ...args: unknown[]) => {
        const response = await fetch(base + '/api/rpc', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ method, args }) });
        return { status: response.status, body: await response.json() };
      };
      const bootstrap = async () => await fetch(base + '/api/bootstrap').then(response => response.json()) as {
        capabilities: string[]; snapshot: WorkspaceSnapshot;
      };
      const settled = async () => {
        const deadline = Date.now() + 8_000;
        while (Date.now() < deadline) {
          const { snapshot } = await bootstrap();
          if (snapshot.run.id && !['queued', 'running', 'blocked'].includes(snapshot.run.status)) return snapshot;
          await delay(10);
        }
        throw new Error('Host run did not settle.');
      };
      return { rpc, bootstrap, settled, stop };
    }
    throw new Error('Host exited before listening.');
  };
  const first = await start();
  assert.ok((await first.bootstrap()).capabilities.includes('retry_task'));
  const project = await first.rpc('createProject', { name: 'HTTP recovery' });
  assert.equal(project.status, 200);
  const created = await first.rpc('createSession', { projectId: project.body.result.project.id, title: 'Manual retry' });
  assert.equal(created.status, 200);
  const sessionId = created.body.result.sessionId;
  const command = { type: 'prompt', id: 'original-request', message: 'Delegate once and report.' };
  const prompted = await first.rpc('pi', sessionId, command);
  assert.equal(prompted.status, 200);
  const before = await first.settled();
  const task = before.tasks.find(task => task.parentTaskId); assert.ok(task?.attemptId);
  assert.equal(task.status, 'failed'); assert.equal(task.retryable, true);
  const originalReceipt = await first.rpc('pi', sessionId, command);
  const request = { requestId: 'manual-retry', expectedAttemptId: task.attemptId };
  const [one, duplicate] = await Promise.all([first.rpc('retryTask', task.id, request), first.rpc('retryTask', task.id, request)]);
  assert.equal(one.status, 200, JSON.stringify(one.body));
  assert.deepEqual(duplicate, one);
  assert.equal(one.body.result.runId, before.run.id);
  assert.notEqual(one.body.result.attemptId, task.attemptId);
  const after = await first.settled();
  assert.equal(after.tasks.find(value => value.id === task.id)?.status, 'succeeded');
  assert.equal(after.attempts?.filter(attempt => attempt.taskId === task.id).length, 2);
  assert.deepEqual(after.attempts?.find(attempt => attempt.id === task.attemptId), before.attempts?.find(attempt => attempt.id === task.attemptId));
  assert.equal(workerCalls, 2); assert.equal(coordinatorRecoveries, 1);
  assert.deepEqual(await first.rpc('pi', sessionId, command), originalReceipt);
  await first.stop();
  const callsAtRestart = providerCalls;
  const second = await start();
  const replay = await second.rpc('retryTask', task.id, request);
  assert.deepEqual(replay, one);
  assert.equal(providerCalls, callsAtRestart, 'restoring and replaying the receipt must not dispatch a model request');
  assert.equal((await second.bootstrap()).snapshot.attempts?.length, after.attempts?.length);
});
