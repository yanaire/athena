import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { chmod, link, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
  let pauseResponse: Promise<void> | undefined;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(body);
    notifyRequest?.();
    await pauseResponse;
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
    pauseResponses() {
      const gate = Promise.withResolvers<void>();
      pauseResponse = gate.promise;
      return () => { pauseResponse = undefined; gate.resolve(); };
    },
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

test('attachment transport stays in the Pi dispatch while live and restored user messages retain exact input', { timeout: 20000 }, async t => {
  const wire = await fixture(t);
  const secret = 'attachment-redaction-fixture-79163';
  process.env.ATHENA_API_KEY = secret;
  let manager = await wire.manager();
  const {sessionId} = await session(manager);
  const {fileReferences} = await manager.stageFiles(sessionId, ['scores.csv', `units-${secret}.txt`].map(name => ({
    name, mimeType: 'text/plain', data: Buffer.from('score\n32\n').toString('base64'),
  })));
  const attachment = (file: typeof fileReferences[number]) => `\n\nInput attachment (never a result): ${JSON.stringify({fileId:file.id,name:file.name})}. ` +
    'Children receive this input by fileId. Only report output locations returned in verified artifact references.\nFor direct input inspection only: ' +
    `Call read with these exact arguments: ${JSON.stringify({path:`uploads/${file.id}.txt`})}`;
  const message = '  사용자 입력 😀\n' + attachment(fileReferences[0]!) + '\n  ';
  const wireMessage = message + fileReferences.map(attachment).join('');
  const publicWireMessage = wireMessage.replaceAll(secret, '[redacted]');
  const bodyText = (value: unknown) => {
    assert.ok(object(value) && value.role === 'user');
    if (typeof value.content === 'string') return value.content;
    assert.ok(Array.isArray(value.content) && object(value.content[0]));
    return value.content[0].text;
  };
  const users = (messages: readonly unknown[]) => messages.filter(object).filter(item => item.role === 'user').map(bodyText);
  const forwarded: Record<string, unknown>[] = [];
  manager.subscribePi(sessionId, event => forwarded.push(event));
  const command = {type:'prompt',id:'with-files',message,fileReferences};
  const send = async (input: typeof command | {type: string; id: string; message: string}, whileStreaming?: () => Promise<void>) => {
    const done = Promise.withResolvers<void>();
    const detach = manager.subscribePi(sessionId, event => { if (event.type === 'agent_settled') done.resolve(); });
    try {
      const accepted = await manager.pi(sessionId, input);
      if (whileStreaming) {
        assert.deepEqual(await manager.pi(sessionId, input), accepted);
        await whileStreaming();
      }
      await done.promise;
      return accepted;
    } finally { detach(); }
  };

  wire.mode('read_attachment');
  const resume = wire.pauseResponses();
  const dispatched = wire.nextRequest();
  const receipt = await send(command, async () => {
    try {
      await dispatched;
      assert.deepEqual(forwarded.filter(event => event.type === 'message_start' && object(event.message) && event.message.role === 'user')
        .map(event => bodyText(event.message)), [message]);
      const response = await manager.pi(sessionId, {type:'get_messages'});
      assert.ok(object(response) && object(response.data) && Array.isArray(response.data.messages));
      assert.deepEqual(users(response.data.messages), [message]);
    } finally { resume(); }
  });
  assert.ok(object(wire.requests[0]) && Array.isArray(wire.requests[0].messages));
  assert.deepEqual(users(wire.requests[0].messages), [wireMessage]);
  assert.equal(wire.requests.length, 2);
  assert.ok(manager.getSnapshot().tools.some(tool => tool.status === 'succeeded' && tool.name === 'read' &&
    tool.logs.some(log => log.text.includes('32'))));
  assert.deepEqual(forwarded.filter(event => event.type === 'message_end' && object(event.message) && event.message.role === 'user')
    .map(event => bodyText(event.message)), [message]);
  assert.deepEqual(forwarded.filter(event => event.type === 'agent_end')
    .flatMap(event => Array.isArray(event.messages) ? users(event.messages) : []), [message]);

  wire.mode('answer');
  // An independently submitted copy of the full former wire message is ordinary input.
  await send({type:'prompt',id:'literal-user-copy',message:wireMessage});
  const checkHistory = async () => {
    const response = await manager.pi(sessionId, {type:'get_messages'});
    assert.ok(object(response) && object(response.data) && Array.isArray(response.data.messages));
    assert.deepEqual(users(response.data.messages), [message, publicWireMessage]);
    assert.deepEqual(users((await manager.getAgentHistory(sessionId, sessionId)).messages), [message, publicWireMessage]);
    const entries = await manager.pi(sessionId, {type:'get_entries'});
    assert.ok(object(entries) && object(entries.data) && Array.isArray(entries.data.entries));
    assert.deepEqual(users(entries.data.entries.filter(object).map(entry => entry.message)), [message, publicWireMessage]);
    const first = entries.data.entries.find(entry => object(entry) && object(entry.message) && entry.message.role === 'user');
    assert.ok(object(first) && typeof first.id === 'string');
    const subsequent = await manager.pi(sessionId, {type:'get_entries', since:first.id});
    assert.ok(object(subsequent) && object(subsequent.data) && Array.isArray(subsequent.data.entries));
    assert.deepEqual(users(subsequent.data.entries.filter(object).map(entry => entry.message)), [publicWireMessage]);
    const missing = await manager.pi(sessionId, {type:'get_entries', since:'unknown-entry'});
    assert.ok(object(missing));
    assert.equal(missing.success, false);
    assert.equal(missing.error, 'Entry not found: unknown-entry');
    assert.equal(missing.data, undefined);
  };
  await checkHistory();
  // Persisted Pi entries have exactly the same raw format as earlier builds.
  // Opening the conversation projects existing entries without a migration.
  const current = await manager.pi(sessionId, {type:'get_state'});
  assert.ok(object(current) && object(current.data) && typeof current.data.sessionFile === 'string');
  const path = current.data.sessionFile;
  const persisted = await readFile(path, 'utf8');
  assert.deepEqual(users(persisted.trimEnd().split('\n').map(line => JSON.parse(line).message)), [wireMessage, wireMessage]);
  await manager.close();
  manager = await wire.manager();
  await checkHistory();
  assert.equal(await readFile(path, 'utf8'), persisted);
  assert.deepEqual(await manager.pi(sessionId, command), receipt);
  assert.equal(wire.requests.length, 3);
});

test('attachment grants reject replacement files, links and excess permissions before invocation', { timeout: 20000 }, async t => {
  const wire = await fixture(t);
  const manager = await wire.manager();
  const activation = await session(manager);
  const data = 'A synthetic grant';
  const { fileReferences } = await manager.stageFiles(activation.sessionId, [{ name: 'input.txt',
    mimeType: 'text/plain', data: Buffer.from(data).toString('base64') }]);
  const ref = fileReferences[0];
  assert.ok(ref);
  const path = join(wire.directory, 'projects', String(activation.projectId), 'uploads', `${ref.id}.txt`);
  const other = join(wire.directory, 'other.txt');
  await writeFile(other, data, { mode: 0o600 });
  const cases: readonly [string, () => Promise<unknown>][] = [
    ['symbolic', () => symlink(other, path)],
    ['hard', () => link(other, path)],
    ['public', async () => { await writeFile(path, data); await chmod(path, 0o644); }],
    ['changed', () => writeFile(path, 'B' + data.slice(1), { mode: 0o600 })],
    ['oversized', () => writeFile(path, Buffer.alloc(256 * 1024 + 1), { mode: 0o600 })],
  ];
  for (const [id, replace] of cases) {
    await rm(path);
    await replace();
    await assert.rejects(manager.pi(activation.sessionId, { type: 'prompt', id,
      message: 'Read the input', fileReferences }), { code: 'FILE_CHANGED' });
  }
  assert.equal(wire.requests.length, 0);
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
