import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { TaskManager } from '../runtime/manager.ts';
import type { WorkspaceSnapshot } from '../athena-backend-handoff/athena-codex-ui/integrations/task-manager.d.ts';

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'athena-manager-'));
  const requests: unknown[] = [];
  let mode: 'answer' | 'read' | 'read_attachment' | 'fail' | 'hold' = 'answer';
  let notifyRequest: (() => void) | undefined;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(body);
    notifyRequest?.();
    if (mode === 'fail') {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Deliberate endpoint rejection', type: 'authentication_error' } }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = (delta: unknown, finish_reason: string | null = null) => response.write(`data: ${JSON.stringify({
      id: 'wire-response', object: 'chat.completion.chunk', created: 1, model: 'manager-model',
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`);
    if (mode === 'hold') { emit({ role: 'assistant', content: 'Working' }); return; }
    const hasTool = object(body) && Array.isArray(body.messages) &&
      body.messages.some(message => object(message) && message.role === 'tool');
    if ((mode === 'read' || mode === 'read_attachment') && !hasTool) {
      let argumentsText = '{"path":"paper.txt"}';
      if (mode === 'read_attachment' && object(body) && Array.isArray(body.messages)) {
        const serialized = body.messages.filter(object).filter(message => message.role === 'user')
          .map(message => typeof message.content === 'string' ? message.content :
            Array.isArray(message.content) ? message.content.filter(object).map(item => String(item.text ?? '')).join('\n') : '').join('\n');
        const exact = serialized.match(/Call read with these exact arguments: (\{[^\n]+\})/);
        if (!exact?.[1]) { response.end('data: [DONE]\n\n'); return; }
        argumentsText = exact[1];
      }
      emit({ role: 'assistant', tool_calls: [{ index: 0, id: 'same_raw_tool', type: 'function',
        function: { name: 'read', arguments: argumentsText } }] });
      emit({}, 'tool_calls');
    } else {
      emit({ role: 'assistant' });
      for (const content of ['The ', 'actual ', 'wire ', 'answer ', 'is ', '47291.']) emit({ content });
      emit({}, 'stop');
    }
    response.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const variables = { ATHENA_ENDPOINT: `http://127.0.0.1:${address.port}/v1`, ATHENA_MODEL: 'manager-model', ATHENA_API_KEY: '', ATHENA_PROVIDER: '' };
  const previous = Object.fromEntries(Object.keys(variables).map(key => [key, process.env[key]]));
  Object.assign(process.env, variables);
  const managers: TaskManager[] = [];
  t.after(async () => {
    for (const manager of managers) await manager.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  async function manager() {
    const value = new TaskManager({ dataDir: directory });
    managers.push(value);
    await value.initialize();
    return value;
  }
  return { directory, requests, manager,
    mode(value: typeof mode) { mode = value; },
    nextRequest() { return new Promise<void>(resolve => { notifyRequest = resolve; }); },
  };
}

function snapshotWhen(manager: TaskManager, predicate: (snapshot: WorkspaceSnapshot) => boolean) {
  return new Promise<WorkspaceSnapshot>(resolve => {
    let unsubscribe = () => {};
    unsubscribe = manager.subscribe(snapshot => {
      if (predicate(snapshot)) { unsubscribe(); resolve(snapshot); }
    });
    if (predicate(manager.getSnapshot())) unsubscribe();
  });
}
async function session(manager: TaskManager, title = 'First session') {
  const { project } = await manager.createProject({ name: 'Research project' });
  return manager.createSession({ projectId: project.id, title });
}

test('one durable prompt receipt owns the real Pi run, task, tool and transcript across restart', { timeout: 20000 }, async t => {
  const wire = await fixture(t);
  wire.mode('read');
  let manager = await wire.manager();
  const activation = await session(manager);
  const state = await manager.pi(activation.sessionId, { type: 'get_state', id: 'identity' });
  assert.ok(object(state) && object(state.data));
  assert.equal(state.data.sessionId, activation.sessionId);
  const projectId = activation.projectId;
  assert.ok(projectId);
  await writeFile(join(wire.directory, 'projects', projectId, 'paper.txt'), 'Evidence from disk: 47291.');
  const forwarded: unknown[] = [];
  const revisions: number[] = [];
  manager.subscribe(snapshot => revisions.push(snapshot.revision));
  manager.subscribeAllPi((id, event) => { assert.equal(id, activation.sessionId); forwarded.push(event); });
  const settled = snapshotWhen(manager, snapshot => snapshot.run.status === 'succeeded');
  const command = { type: 'prompt', id: 'durable-request', message: 'Read paper.txt and report the evidence.' };

  const accepted = await manager.pi(activation.sessionId, command);
  const duplicate = await manager.pi(activation.sessionId, { message: command.message, id: command.id, type: command.type });
  const snapshot = await settled;

  assert.deepEqual(duplicate, accepted);
  assert.equal(snapshot.tasks.length, 1);
  assert.equal(snapshot.tools.length, 1);
  const task = snapshot.tasks[0];
  const tool = snapshot.tools[0];
  assert.ok(task && tool);
  assert.equal(task.status, 'succeeded');
  assert.equal(tool.status, 'succeeded');
  assert.equal(task.runId, snapshot.run.id);
  assert.equal(tool.taskId, task.id);
  assert.deepEqual(task.toolIds, [tool.id]);
  assert.ok(tool.logs.some(log => log.text.includes('Evidence from disk: 47291.')));
  assert.ok(forwarded.some(event => object(event) && event.type === 'tool_execution_end' && event.toolCallId === tool.id));
  assert.ok(forwarded.some(event => object(event) && object(event.assistantMessageEvent) &&
    event.assistantMessageEvent.type === 'toolcall_end' && object(event.assistantMessageEvent.toolCall) &&
    event.assistantMessageEvent.toolCall.id === tool.id), 'The chat tool row must use the same ID as the workspace tool.');
  assert.ok(revisions.every((revision, index) => index === 0 || revision > Number(revisions[index - 1])));
  assert.equal(wire.requests.length, 2); // One dispatch; a real read result triggers its second model turn.
  const messages = await manager.pi(activation.sessionId, { type: 'get_messages', id: 'history' });
  await manager.close();
  manager = await wire.manager();
  const restored = manager.getSnapshot();
  assert.equal(restored.sessionId, activation.sessionId);
  assert.equal(restored.run.id, snapshot.run.id);
  assert.deepEqual(restored.tools, snapshot.tools);
  assert.ok(restored.revision > snapshot.revision);
  assert.deepEqual(JSON.parse(JSON.stringify(await manager.pi(activation.sessionId, { type: 'get_messages', id: 'history' }))),
    JSON.parse(JSON.stringify(messages))); // Undefined SDK fields are absent on the HTTP wire and in JSONL.
  assert.deepEqual(await manager.pi(activation.sessionId, command), accepted);
  assert.equal(wire.requests.length, 2);
  await assert.rejects(manager.pi(activation.sessionId, { ...command, message: 'Different message' }), { code: 'REQUEST_ID_CONFLICT' });
});

test('session switches isolate snapshots, reject stale RPC and preserve staged UTF-8 bytes', { timeout: 20000 }, async t => {
  const wire = await fixture(t);
  const manager = await wire.manager();
  const first = await session(manager);
  const contents = 'Exact staged evidence\nUnicode: 한글 😀\n';
  const staged = await manager.stageFiles(first.sessionId, [{ name: '../paper.txt', mimeType: 'text/plain', data: Buffer.from(contents).toString('base64') }]);
  const ref = staged.fileReferences[0];
  assert.ok(ref);
  const onDisk = join(wire.directory, 'projects', String(first.projectId), 'uploads', `${ref.id}.txt`);
  assert.equal(await readFile(onDisk, 'utf8'), contents);
  const second = await manager.createSession({ projectId: String(first.projectId), title: 'Other conversation' });
  const revision = manager.getSnapshot().revision;
  await assert.rejects(manager.pi(first.sessionId, { type: 'get_messages' }), { code: 'SESSION_MISMATCH' });
  assert.throws(() => manager.stageFiles(first.sessionId, [{ name: 'stale.txt', mimeType: 'text/plain', data: '' }]), { code: 'SESSION_MISMATCH' });
  await assert.rejects(manager.pi(second.sessionId, { type: 'prompt', id: 'wrong-scope', message: 'Read attached text', fileReferences: [ref] }), { code: 'FILE_SCOPE_MISMATCH' });
  assert.deepEqual(manager.getSnapshot().tasks, []);
  await manager.openSession(first.sessionId);
  assert.ok(manager.getSnapshot().revision > revision);
  wire.mode('read_attachment');
  const completed = snapshotWhen(manager, snapshot => snapshot.run.status === 'succeeded');
  await manager.pi(first.sessionId, { type: 'prompt', id: 'file-prompt', message: 'Use this exact attachment', fileReferences: [ref] });
  const result = await completed;
  assert.equal(JSON.stringify(wire.requests[0]).includes('Exact staged evidence'), false);
  assert.ok(result.tools.some(tool => object(tool.args) && tool.args.path === `uploads/${ref.id}.txt` &&
    tool.status === 'succeeded' && tool.logs.some(log => log.text.includes(contents))));
  await manager.openSession(second.sessionId);
  assert.deepEqual(manager.getSnapshot().tasks, []);
  assert.deepEqual(manager.getSnapshot().tools, []);
  assert.deepEqual(manager.getSnapshot().events, []);
  assert.throws(() => manager.stageFiles(second.sessionId, [{ name: 'binary.pdf', mimeType: 'application/pdf', data: 'JVBERg==' }]), { code: 'UNSUPPORTED_FILE' });
});

test('adding a project durably selects it before the first conversation is created', { timeout: 20000 }, async t => {
  const wire = await fixture(t);
  let manager = await wire.manager();
  const previous = await session(manager);
  const { project, snapshot } = await manager.createProject({ name: 'New selected project' });
  assert.equal(snapshot.projectId, project.id);
  assert.equal(snapshot.sessionId, null);
  assert.deepEqual(snapshot.tasks, []);
  await assert.rejects(manager.pi(previous.sessionId, { type: 'get_state' }), { code: 'SESSION_MISMATCH' });
  await manager.close();
  manager = await wire.manager();
  assert.equal(manager.getSnapshot().projectId, project.id);
  assert.equal(manager.getSnapshot().sessionId, null);
  const created = await manager.createSession({ projectId: manager.getSnapshot().projectId, title: 'First conversation' });
  const state = await manager.pi(created.sessionId, { type: 'get_state' });
  assert.ok(object(state) && object(state.data));
  assert.equal(state.data.sessionId, created.sessionId);
});

test('live text deltas reach Pi subscribers without republishing full workspace snapshots', { timeout: 20000 }, async t => {
  const wire = await fixture(t);
  const manager = await wire.manager();
  const activation = await session(manager);
  const revisions: number[] = [];
  let forwardedText = '';
  manager.subscribePi(activation.sessionId, event => {
    if (event.type === 'message_update' && object(event.assistantMessageEvent) &&
        event.assistantMessageEvent.type === 'text_delta') {
      revisions.push(manager.getSnapshot().revision);
      forwardedText += String(event.assistantMessageEvent.delta);
    }
  });
  const settled = snapshotWhen(manager, snapshot => snapshot.run.status === 'succeeded');
  await manager.pi(activation.sessionId, { type: 'prompt', id: 'live-deltas', message: 'Stream the answer.' });
  await settled;
  assert.equal(forwardedText, 'The actual wire answer is 47291.');
  assert.ok(revisions.length >= 2);
  assert.equal(new Set(revisions).size, 1);
});

test('actual provider failure settles failed and accepted cancellation waits for SDK settlement', { timeout: 20000 }, async t => {
  const wire = await fixture(t);
  const manager = await wire.manager();
  const activation = await session(manager);
  wire.mode('fail');
  const failed = snapshotWhen(manager, snapshot => snapshot.run.status === 'failed');
  await manager.pi(activation.sessionId, { type: 'prompt', id: 'failure', message: 'Reject this request' });
  const failure = await failed;
  assert.equal(failure.tasks[0]?.status, 'failed');
  assert.ok(failure.events.some(event => event.type === 'run_failed' && event.summary.includes('Deliberate endpoint rejection')));
  wire.mode('hold');
  const requested = wire.nextRequest();
  await manager.pi(activation.sessionId, { type: 'prompt', id: 'cancel', message: 'Hold this stream' });
  await requested;
  await assert.rejects(manager.createProject({ name: 'Cannot detach an active run' }), { code: 'SESSION_BUSY' });
  await assert.rejects(manager.createSession({ projectId: String(activation.projectId), title: 'Cannot switch' }), { code: 'SESSION_BUSY' });
  const cancelled = snapshotWhen(manager, snapshot => snapshot.run.status === 'cancelled');
  const runId = manager.getSnapshot().run.id;
  assert.ok(runId);
  await manager.cancelRun(runId);
  assert.equal((await cancelled).tasks.at(-1)?.status, 'cancelled');
  assert.equal(wire.requests.length, 2);
});

test('a killed host restores interrupted acceptance without automatically redispatching', { timeout: 25000 }, async t => {
  const wire = await fixture(t);
  wire.mode('hold');
  const requested = wire.nextRequest();
  const source = `
    import { TaskManager } from ${JSON.stringify(new URL('../runtime/manager.ts', import.meta.url).href)};
    const manager = new TaskManager({ dataDir: ${JSON.stringify(wire.directory)} });
    await manager.initialize();
    const { project } = await manager.createProject({name:'Crash project'});
    const session = await manager.createSession({projectId:project.id,title:'Interrupted session'});
    await manager.pi(session.sessionId,{type:'prompt',id:'crash-request',message:'Hold across host death'});
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let childErrors = '';
  child.stderr.on('data', chunk => { childErrors += String(chunk); });
  child.on('error', error => { throw error; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await requested;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;

  const manager = await wire.manager();
  const snapshot = manager.getSnapshot();
  assert.equal(snapshot.run.status, 'paused', childErrors);
  assert.equal(snapshot.tasks[0]?.status, 'paused');
  assert.ok(snapshot.events.some(event => event.type === 'interrupted'));
  assert.ok(snapshot.sessionId);
  const receipt = await manager.pi(snapshot.sessionId, { type: 'prompt', id: 'crash-request', message: 'Hold across host death' });
  assert.ok(object(receipt));
  assert.equal(receipt.success, false);
  assert.equal(wire.requests.length, 1);
});
