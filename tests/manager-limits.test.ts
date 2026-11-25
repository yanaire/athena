import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { TaskManager } from '../runtime/manager.ts';
import { assertKilled, posixSignalsOnly } from './platform-test-helpers.ts';

type Wire = {
  messages: { role: string; content: unknown }[];
  tools: { function: { name: string } }[];
};

function completion(res: ServerResponse, text: string | { name: string; args: object }) {
  const tool = typeof text !== 'string';
  const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call_' + crypto.randomUUID(),
    type: 'function', function: { name: text.name, arguments: JSON.stringify(text.args) } }] } : { role: 'assistant', content: text };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [chunk, reason] of [[delta, null], [{}, tool ? 'tool_calls' : 'stop']]) {
    res.write('data: ' + JSON.stringify({ id: 'completion', object: 'chat.completion.chunk', created: 1, model: 'limits',
      choices: [{ index: 0, delta: chunk, finish_reason: reason }] }) + '\n\n');
  }
  res.end('data: [DONE]\n\n');
}

// Only the provider is controlled. Every delegation, join, abort and CSV execution goes through Pi and TaskManager.
async function fixture(t: TestContext, names: readonly string[], child: (name: string, res: ServerResponse) => void, joinChildren = true) {
  const joined = Promise.withResolvers<string>();
  let requests = 0;
  const server = createServer(async (req, res) => {
    requests++;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const wire: Wire = JSON.parse(Buffer.concat(chunks).toString());
    if (wire.tools.some(tool => tool.function.name === 'spawn_agent')) {
      const results = wire.messages.filter(m => m.role === 'tool');
      const next = names[results.length];
      if (next) completion(res, { name: 'spawn_agent', args: { title: next, prompt: next } });
      else if (joinChildren && results.length === names.length) completion(res, { name: 'wait_for_agents', args: {} });
      else { joined.resolve(String(results.at(-1)?.content)); completion(res, 'Received outcomes.'); }
    } else {
      const input = JSON.stringify(wire.messages.filter(m => m.role === 'user'));
      const name = names.find(n => input.includes(n));
      if (name) child(name, res);
      else res.writeHead(400).end('Unrecognized child request');
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const directory = await mkdtemp(join(tmpdir(), 'athena-manager-limits-'));
  const settings = { ATHENA_ENDPOINT: `http://127.0.0.1:${address.port}/v1`, ATHENA_MODEL: 'limits', ATHENA_API_KEY: '',
    ATHENA_MODEL_CONCURRENCY: '2', ATHENA_MAX_CHILDREN: String(names.length), ATHENA_MAX_DEPTH: '1', ATHENA_PROCESS_CONCURRENCY: '1' };
  const previous = Object.entries(settings).map(([key, value]) => {
    const old = process.env[key]; process.env[key] = value; return { key, old };
  });
  const manager = new TaskManager({ dataDir: directory });
  t.after(async () => {
    try { await manager.close(); } finally {
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      previous.forEach(({ key, old }) => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
      await rm(directory, { recursive: true, force: true });
    }
  });
  await manager.initialize();
  const { project } = await manager.createProject({ name: 'Limits' });
  const { sessionId } = await manager.createSession({ projectId: project.id, title: 'Delegate' });
  return { manager, sessionId, joined: joined.promise, directory, requests: () => requests };
}

test('two child provider requests overlap at limit two; a queued third enters on release and the parent receives the failed child outcome', { timeout: 15000 }, async t => {
  const names = ['Worker Alpha', 'Worker Beta', 'Worker Gamma'];
  const held = new Map<string, ServerResponse>();
  const two = Promise.withResolvers<void>(), third = Promise.withResolvers<void>();
  let peak = 0;
  const { manager, sessionId, joined } = await fixture(t, names, (name, res) => {
    held.set(name, res); peak = Math.max(peak, held.size);
    if (held.size === 2) two.resolve();
    if (name === 'Worker Gamma') third.resolve();
  });
  const settled = Promise.withResolvers<void>();
  const blocked = Promise.withResolvers<void>();
  let peakRunningChildren = 0;
  const unsubscribe = manager.subscribe(s => {
    peakRunningChildren = Math.max(peakRunningChildren, s.tasks.filter(t => t.parentTaskId && t.status === 'running').length);
    if (s.run.status === 'blocked') blocked.resolve();
    if (s.run.status === 'succeeded') settled.resolve();
  });
  t.after(unsubscribe);
  await manager.pi(sessionId, { type: 'prompt', id: 'overlap', message: 'Delegate then join.' });
  await Promise.all([two.promise, blocked.promise]);
  assert.deepEqual([...held.keys()].sort(), ['Worker Alpha', 'Worker Beta']);
  const release = (name: string) => {
    const res = held.get(name); assert.ok(res); assert.equal(res.destroyed, false);
    held.delete(name); return res;
  };
  assert.equal(manager.getSnapshot().tasks.find(t => t.title === 'Worker Gamma')?.status, 'queued');
  completion(release('Worker Alpha'), 'Alpha finished.');
  await third.promise;
  assert.deepEqual([...held.keys()].sort(), ['Worker Beta', 'Worker Gamma']);
  release('Worker Beta').writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({
    error: { type: 'authentication_error', message: 'Beta endpoint rejection 62573' },
  }));
  completion(release('Worker Gamma'), 'Gamma finished.');
  const [report] = await Promise.all([joined, settled.promise]);
  const { tasks }: { tasks: { taskId: string; status: string; result: string | null; error?: string }[] } = JSON.parse(report);
  const children = manager.getSnapshot().tasks.filter(t => t.parentTaskId);
  assert.equal(peak, 2); assert.equal(peakRunningChildren, 2);
  assert.deepEqual(tasks.map(t => t.taskId).sort(), children.map(t => t.id).sort());
  for (const child of children) {
    const outcome = tasks.find(t => t.taskId === child.id); assert.ok(outcome);
    if (child.title === 'Worker Beta') {
      assert.equal(outcome.status, 'failed'); assert.equal(child.status, 'failed');
      assert.match(outcome.error ?? '', /Beta endpoint rejection 62573/);
    } else { assert.equal(outcome.status, 'succeeded'); assert.equal(outcome.result, child.title === 'Worker Alpha' ? 'Alpha finished.' : 'Gamma finished.'); }
  }
});

test('cancelRun aborts both children, closes the held model request and terminates the active CSV process group', { timeout: 15000, skip: posixSignalsOnly }, async t => {
  const names = ['CSV worker', 'Streaming worker'];
  const streaming = Promise.withResolvers<void>(), disconnected = Promise.withResolvers<void>();
  const { manager, sessionId } = await fixture(t, names, (name, res) => {
    if (name === 'CSV worker') completion(res, { name: 'calculate_csv', args: {} });
    else {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': held\n\n');
      res.once('close', () => { if (!res.writableEnded) disconnected.resolve(); });
      streaming.resolve();
    }
  });
  const started = Promise.withResolvers<number>();
  let stopped = false;
  const unsubscribe = manager.subscribe(s => {
    if (!stopped && s.processes?.some(p => p.status === 'running')) {
      const pid = manager.getSnapshot().processes.find(p => p.status === 'running')?.job.pid;
      if (pid) {
        stopped = true;
        // Use the runner suite's live-PID witness: a stopped worker cannot finish the CSV before cancellation.
        process.kill(pid, 'SIGSTOP'); started.resolve(pid);
      }
    }
  });
  t.after(unsubscribe);
  const { fileReferences } = await manager.stageFiles(sessionId, [{ name: 'scores.csv', mimeType: 'text/csv',
    data: Buffer.from('score\n' + '4\n'.repeat(99000)).toString('base64') }]);
  await manager.pi(sessionId, { type: 'prompt', id: 'cancel-tree', message: 'Delegate and join.', fileReferences });
  const [pid] = await Promise.all([started.promise, streaming.promise]);
  const before = manager.getSnapshot(); assert.ok(before.run.id);
  assert.equal(before.run.status, 'blocked');
  assert.deepEqual(before.tasks.filter(t => t.parentTaskId).map(t => t.status), ['running', 'running']);
  assert.equal(process.kill(-pid, 0), true);
  await manager.cancelRun(before.run.id); await disconnected.promise;
  const after = manager.getSnapshot();
  assert.equal(after.run.status, 'cancelled');
  assert.deepEqual(after.tasks.map(t => t.status), ['cancelled', 'cancelled', 'cancelled']);
  assert.deepEqual(after.attempts.map(a => a.status), ['cancelled', 'cancelled', 'cancelled']);
  const [proc] = after.processes; assert.ok(proc);
  assert.equal(proc.taskId, before.tasks.find(t => t.title === 'CSV worker')?.id);
  assert.equal(proc.job.pid, pid); assert.equal(proc.status, 'cancelled');
  assert.equal(proc.job.cancellation, 'confirmed'); assert.equal(proc.job.signal, 'SIGKILL');
  assert.throws(() => process.kill(-pid, 0), { code: 'ESRCH' });
  assert.deepEqual(after.artifacts, []);
});

for (const action of ['cancel', 'crash'] as const) {
  test(`${action} after coordinator success preserves the completed attempt and records the run's own outcome`, { timeout: 15000 }, async t => {
    const held = Promise.withResolvers<void>();
    const { manager, directory, sessionId, requests } = await fixture(t, ['Held worker'], (_, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': held\n\n'); held.resolve();
    }, false);
    const prompt = { type: 'prompt', id: 'detached-child', message: 'Delegate without waiting.' };
    type Snapshot = ReturnType<TaskManager['getSnapshot']>;
    let before: Snapshot;
    if (action === 'cancel') {
      const blocked = Promise.withResolvers<void>();
      const statuses: string[] = [];
      const off = manager.subscribe(s => {
        statuses.push(s.run.status);
        if (s.run.status === 'blocked' && s.tasks.some(t => t.parentTaskId && t.status === 'running')) blocked.resolve();
      });
      await manager.pi(sessionId, prompt); await Promise.all([held.promise, blocked.promise]);
      before = manager.getSnapshot(); assert.ok(before.run.id);
      await manager.cancelRun(before.run.id);
      assert.equal(manager.getSnapshot().run.status, 'cancelled');
      assert.ok(!statuses.includes('succeeded')); off(); await manager.close();
    } else {
      await manager.close();
      const script = `
        import { TaskManager } from ${JSON.stringify(new URL('../runtime/manager.ts', import.meta.url).href)};
        const m = new TaskManager({dataDir:${JSON.stringify(directory)}}); await m.initialize();
        let sent = false;
        m.subscribe(s => { if (!sent && s.run.status === 'blocked' && s.tasks.some(t => t.parentTaskId && t.status === 'running')) {
          sent = true; process.send(s);
        } });
        await m.pi(${JSON.stringify(sessionId)}, ${JSON.stringify(prompt)});
      `;
      const host = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
      t.after(() => { if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL'); });
      const [[snapshot]] = await Promise.all([once(host, 'message'), held.promise]); before = snapshot;
      const exited = once(host, 'exit'); assert.equal(host.kill('SIGKILL'), true);
      const [code, signal] = await exited; assertKilled(code, signal);
    }
    assert.equal(before.run.status, 'blocked');
    const root = before.attempts.find(a => !a.parentTaskId), child = before.attempts.find(a => a.parentTaskId);
    assert.ok(root && child); assert.equal(root.status, 'succeeded'); assert.equal(root.result, 'Received outcomes.');
    assert.equal(child.status, 'running'); assert.equal(requests(), 3);

    const reopened = new TaskManager({ dataDir: directory });
    try {
      await reopened.initialize(); const after = reopened.getSnapshot();
      const status = action === 'cancel' ? 'cancelled' : 'paused';
      assert.equal(after.run.status, status);
      assert.deepEqual(after.attempts.find(a => a.id === root.id), root);
      assert.deepEqual(after.tasks.find(t => t.id === root.taskId), before.tasks.find(t => t.id === root.taskId));
      assert.equal(after.attempts.find(a => a.id === child.id)?.status, status);
      assert.equal(after.tasks.find(t => t.id === child.taskId)?.status, status);
      const terminal = after.events.filter(e => e.taskId === root.taskId && ['run_succeeded', 'run_failed', 'run_cancelled', 'interrupted'].includes(e.type));
      assert.deepEqual(terminal.map(e => e.type), [action === 'cancel' ? 'run_cancelled' : 'interrupted']);
      const reason = terminal[0]?.summary; assert.match(reason ?? '', action === 'cancel' ? /cancel/i : /restart/i);
      const replay = await reopened.pi(sessionId, prompt);
      assert.deepEqual(replay, { type: 'response', command: 'prompt', id: prompt.id, success: false, error: reason,
        data: { runId: before.run.id, taskId: root.taskId, status } });
      const db = new DatabaseSync(join(directory, 'workspace.sqlite'), { readOnly: true });
      try {
        assert.equal(db.prepare('SELECT state FROM receipts WHERE session_id=? AND request_id=?').get(sessionId, prompt.id)?.state,
          action === 'cancel' ? 'failed' : 'interrupted');
      } finally { db.close(); }
      assert.deepEqual(after.attempts.map(a => a.id), before.attempts.map(a => a.id)); assert.equal(requests(), 3);
    } finally { await reopened.close(); }
  });
}
