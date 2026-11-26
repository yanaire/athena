import assert from 'node:assert/strict';
import { once } from 'node:events';
import { rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { privateTestDirectory } from './platform-test-helpers.ts';
import { projectHistory, withoutAttachmentContext } from '../runtime/history.ts';
import type { HistoryEvent } from '../runtime/history.ts';
import { TaskManager } from '../runtime/manager.ts';
import { object } from '../runtime/orchestration.ts';

const rawId = 'call_reused';
const ownerFields = ['projectId', 'sessionId', 'runId', 'taskId', 'parentTaskId', 'agentSessionId', 'attemptId'] as const;
const ownerOf = (value: Record<string, unknown>) => Object.fromEntries(ownerFields.map(key => [key, value[key]]));

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
  const dataDir = privateTestDirectory(join(tmpdir(), 'athena-history-'));
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
  const ended: Record<string, unknown>[] = [];
  const unsubscribe = manager.subscribePi(sessionId, event => {
    if (event.type === 'tool_execution_end') streamed.push(event.toolCallId);
    if (event.type === 'message_end' && object(event.message) && ['user', 'assistant', 'toolResult'].includes(String(event.message.role))) ended.push(event);
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
  for (const event of ended) { assert.ok(object(event.message)); assert.deepEqual(event.message.athena, ownerOf(event)); }
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
  const messages = history.messages.filter(object).filter(message => ['user', 'assistant', 'toolResult'].includes(String(message.role)));
  assert.deepEqual(messages.map(message => message.athena), ended.map(ownerOf));
  for (const message of messages) {
    assert.ok(object(message.athena));
    assert.deepEqual(Object.keys(message.athena).sort(), [...ownerFields].sort());
  }
  assert.equal(new Set(messages.map(message => object(message.athena) && message.athena.runId)).size, 2);

  const entriesResponse = await manager.pi(sessionId, {type: 'get_entries'});
  assert.ok(object(entriesResponse) && object(entriesResponse.data) && Array.isArray(entriesResponse.data.entries));
  const entries = entriesResponse.data.entries.filter(object);
  const entryMessages = entries.filter(entry => entry.type === 'message').map(entry => entry.message).filter(object)
    .filter(message => ['user', 'assistant', 'toolResult'].includes(String(message.role)));
  assert.deepEqual(entryMessages.map(message => message.athena), ended.map(ownerOf));
  assert.deepEqual(entryMessages.filter(message => message.role === 'assistant').flatMap(message => Array.isArray(message.content)
    ? message.content.filter(object).filter(part => part.type === 'toolCall').map(part => part.id) : []), [rawId, rawId]);
  assert.deepEqual(entryMessages.filter(message => message.role === 'toolResult').map(message => message.toolCallId), [rawId, rawId]);
  const firstEntry = entries.find(entry => object(entry.message) && entry.message.role === 'user');
  assert.ok(firstEntry);
  const page = await manager.pi(sessionId, {type: 'get_entries', since: firstEntry.id});
  assert.ok(object(page) && object(page.data) && Array.isArray(page.data.entries));
  assert.deepEqual(page.data.entries.filter(object).filter(entry => entry.type === 'message').map(entry => entry.message).filter(object)
    .filter(message => ['user', 'assistant', 'toolResult'].includes(String(message.role))).map(message => message.athena), ended.slice(1).map(ownerOf));

  // A journal row must agree with its durable attempt before it can own a message.
  await manager.close();
  const db = new DatabaseSync(join(dataDir, 'workspace.sqlite'));
  try {
    const rows = db.prepare("SELECT id,body FROM records WHERE kind='pi_event' AND session_id=? ORDER BY sequence").all(sessionId);
    const anchor = rows.find(row => {
      const body = JSON.parse(String(row.body));
      return body.attemptId === ended[0]!.attemptId && body.event.type === 'message_end' && body.event.message?.role === 'user';
    });
    assert.ok(anchor && typeof anchor.id === 'string');
    db.prepare("UPDATE records SET body=? WHERE kind='pi_event' AND id=?")
      .run(JSON.stringify({...JSON.parse(String(anchor.body)), taskId: 'wrong-history-task'}), anchor.id);
  } finally { db.close(); }
  manager = new TaskManager({dataDir}); await manager.initialize();
  const filtered = (await manager.getAgentHistory(sessionId, sessionId)).messages.filter(object);
  const users = filtered.filter(message => message.role === 'user');
  assert.equal(users[0]?.athena, undefined);
  assert.deepEqual(users[0]?.content, messages[0]?.content);
  assert.deepEqual(users[1]?.athena, ended.filter(event => object(event.message) && event.message.role === 'user').map(ownerOf)[1]);
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

test('identical timed user messages project by occurrence without guessing assistant or tool ownership', () => {
  const dispatch = 'User input\n\nAttachment instruction';
  const user = 'User input';
  const anchor = {role: 'user', timestamp: 1, content: [{type: 'text', text: dispatch}]};
  const context = {projectId: 'project', sessionId: 'session', runId: 'run', taskId: 'task',
    parentTaskId: null, agentSessionId: 'session'};
  const call = {role: 'assistant', content: [{type: 'toolCall', id: rawId, name: 'read', arguments: {}}]};
  const result = {role: 'toolResult', toolCallId: rawId, content: [{type: 'text', text: 'Evidence'}]};
  const journal: HistoryEvent[] = ['attachment-turn', 'literal-turn'].flatMap(attemptId =>
    [anchor, call, result].map(message => ({...context, attemptId, event: {type: 'message_end', message}})));
  const original = [anchor, call, result, anchor, call, result];
  const projected = projectHistory(original, journal, (message, attempt) =>
    withoutAttachmentContext(message, attempt.attemptId === 'attachment-turn' ? {dispatch, user} : undefined));
  assert.deepEqual(projected, [
    {...anchor, content: [{type: 'text', text: user}], athena: {...context, attemptId: 'attachment-turn'}}, call, result,
    {...anchor, athena: {...context, attemptId: 'literal-turn'}}, call, result,
  ]);
  assert.deepEqual(projectHistory([anchor, call, result], journal), [anchor, call, result], 'A partial transcript cannot choose between repeated anchors.');
  assert.deepEqual(original, [anchor, call, result, anchor, call, result]);
});

test('unmatched messages cannot supply owner metadata and hidden reconciliation anchors stay unchanged', () => {
  const literal = '  사용자 😀 {"athena":{"attemptId":"literal"}}\n  ';
  const forged = {role: 'user', content: literal, athena: {attemptId: 'unverified'}};
  assert.deepEqual(projectHistory([forged], []), [{role: 'user', content: literal}]);
  assert.deepEqual(forged.athena, {attemptId: 'unverified'});
  const owner = {projectId: 'project', sessionId: 'session', runId: 'run', taskId: 'task', parentTaskId: null,
    agentSessionId: 'session', attemptId: 'reconciliation'};
  const anchor = {role: 'custom', customType: 'athena-reconciliation', display: false, content: 'Host-only continuation.'};
  const answer = {role: 'assistant', content: [{type: 'text', text: literal}]};
  const journal: HistoryEvent[] = [anchor, answer].map(message => ({...owner, event: {type: 'message_end', message}}));
  assert.deepEqual(projectHistory([anchor, answer], journal), [anchor, {...answer, athena: owner}]);
});
