import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { projectHistory, withoutAttachmentContext } from '../runtime/history.ts';
import type { HistoryEvent } from '../runtime/history.ts';
import { TaskManager } from '../runtime/manager.ts';
import { object } from '../runtime/orchestration.ts';

const rawId = 'call_reused';

test('both public history endpoints link a reused provider ID to each persisted attempt after reopening', {timeout: 15000}, async t => {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const wire: unknown = JSON.parse(Buffer.concat(chunks).toString());
    assert.ok(object(wire) && Array.isArray(wire.messages));
    const last: unknown = wire.messages.at(-1);
    const callTool = object(last) && last.role === 'user';
    const delta = callTool ? {role: 'assistant', tool_calls: [{index: 0, id: rawId, type: 'function',
      function: {name: 'read', arguments: '{"path":"paper.txt"}'}}]} : {role: 'assistant', content: 'Finished.'};
    response.writeHead(200, {'Content-Type': 'text/event-stream'});
    for (const [chunk, finish] of [[delta, null], [{}, callTool ? 'tool_calls' : 'stop']]) {
      response.write(`data: ${JSON.stringify({id: 'completion', object: 'chat.completion.chunk', created: 1,
        model: 'fixture', choices: [{index: 0, delta: chunk, finish_reason: finish}]})}\n\n`);
    }
    response.end('data: [DONE]\n\n');
  });
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const env = {ATHENA_ENDPOINT: `http://127.0.0.1:${address.port}/v1`, ATHENA_MODEL: 'fixture', ATHENA_API_KEY: ''};
  for (const [key, value] of Object.entries(env)) {
    const prior = process.env[key];
    process.env[key] = value;
    t.after(() => { if (prior === undefined) delete process.env[key]; else process.env[key] = prior; });
  }
  const dataDir = await mkdtemp(join(tmpdir(), 'athena-history-'));
  let manager = new TaskManager({dataDir});
  t.after(async () => {
    await manager.close();
    await rm(dataDir, {recursive: true, force: true});
  });
  await manager.initialize();
  const {project} = await manager.createProject({name: 'History'});
  const {sessionId} = await manager.createSession({projectId: project.id, title: 'Repeated call IDs'});
  await writeFile(join(dataDir, 'projects', project.id, 'paper.txt'), 'Read from disk.');
  const streamed: unknown[] = [];
  const unsubscribe = manager.subscribePi(sessionId, event => {
    if (event.type === 'tool_execution_end') streamed.push(event.toolCallId);
  });
  for (const id of ['first', 'second']) {
    const done = Promise.withResolvers<void>();
    const detach = manager.subscribePi(sessionId, event => { if (event.type === 'agent_settled') done.resolve(); });
    try {
      await manager.pi(sessionId, {type: 'prompt', id, message: 'Read the paper.'});
      await done.promise;
    } finally { detach(); }
  }
  unsubscribe();
  assert.equal(streamed.length, 2);
  assert.notEqual(streamed[0], streamed[1]);
  await manager.close();
  manager = new TaskManager({dataDir});
  await manager.initialize();

  const history = await manager.getAgentHistory(sessionId, sessionId);
  const response = await manager.pi(sessionId, {type: 'get_messages'});
  assert.ok(object(response) && object(response.data));
  assert.deepEqual(response.data.messages, history.messages);
  const calls = history.messages.filter(object).filter(m => m.role === 'assistant')
    .flatMap(m => Array.isArray(m.content) ? m.content.filter(object).filter(p => p.type === 'toolCall') : []);
  const results = history.messages.filter(object).filter(m => m.role === 'toolResult');
  assert.deepEqual(calls.map(p => [p.id, p.rawToolCallId]), streamed.map(id => [id, rawId]));
  assert.deepEqual(results.map(m => [m.toolCallId, m.rawToolCallId]), streamed.map(id => [id, rawId]));
  assert.deepEqual(manager.getSnapshot().tools.map(tool => tool.id), streamed);
});

test('legacy and unmatched messages keep their raw IDs even when a journaled turn reuses them', () => {
  const legacy = {role: 'user', timestamp: 1, content: 'Read.'};
  const current = {...legacy, timestamp: 2};
  const call = {role: 'assistant', content: [{type: 'toolCall', id: rawId, name: 'read', arguments: {}}]};
  const result = {role: 'toolResult', toolCallId: rawId, content: [{type: 'text', text: 'Evidence'}]};
  const context = {projectId: 'project', sessionId: 'session', runId: 'run', taskId: 'task', parentTaskId: null,
    agentSessionId: 'session', attemptId: 'attempt'};
  const journal: HistoryEvent[] = [current, call, result].map(message => ({...context, event: {type: 'message_end', message}}));

  const projected = projectHistory([legacy, call, result, current, call, result, result], journal);

  assert.deepEqual(projected.slice(0, 3), [legacy, call, result]);
  assert.deepEqual(projected.at(-1), result);
  assert.notDeepEqual(projected.slice(4, 6), [call, result]);
  assert.deepEqual(projectHistory([legacy, call, result], []), [legacy, call, result]);
});

test('identical timed user messages project by attempt occurrence', () => {
  const dispatch = 'User input\n\nAttachment instruction';
  const user = 'User input';
  const anchor = {role: 'user', timestamp: 1, content: [{type: 'text', text: dispatch}]};
  const context = {projectId: 'project', sessionId: 'session', runId: 'run', taskId: 'task',
    parentTaskId: null, agentSessionId: 'session'};
  const journal: HistoryEvent[] = ['attachment-turn', 'literal-turn'].map(attemptId =>
    ({...context, attemptId, event: {type: 'message_end', message: anchor}}));
  const projected = projectHistory([anchor, anchor], journal, (message, attempt) =>
    withoutAttachmentContext(message, attempt.attemptId === 'attachment-turn' ? {dispatch, user} : undefined));
  assert.deepEqual(projected, [{...anchor, content: [{type: 'text', text: user}]}, anchor]);
});
