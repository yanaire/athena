#!/usr/bin/env node
'use strict';
// Contract checks only: no live model, storage service, network or browser.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const sourceRoot = path.resolve(__dirname, '..');
const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

function load(name) {
  const context = vm.createContext({ window: {}, setTimeout, clearTimeout, Date });
  vm.runInContext(fs.readFileSync(path.join(sourceRoot, 'ui', name + '.js'), 'utf8'), context);
  return context.window;
}
function host(options = {}) {
  const listeners = new Set(), calls = [], responses = [];
  const connection = { mode: 'host', capabilities: options.capabilities || ['prompt', 'steer', 'follow_up', 'get_messages', 'get_commands'], calls, responses,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    emit(event) { for (const fn of listeners) fn(event); },
    async request(wire) { calls.push(wire); return { id: wire.id, type: 'response', command: wire.type, success: true, data: await options.request?.(wire) }; },
    async send(response) { responses.push(response); return options.send ? options.send(response) : true; }
  };
  return Object.assign(connection, options.properties || {});
}
function setup(t, connection) {
  const runtime = load('pi-runtime').AthenaPiRuntime.create();
  runtime.attach(connection, { refresh: false });
  t.after(() => runtime.destroy());
  return runtime;
}

test('message limits reject intact before sending; valid long messages and slash arguments are never sliced', async t => {
  const body = '  ' + '한'.repeat(100000) + '\nend\n';
  const connection = host({ request: wire => wire.type === 'get_commands' ? { commands: [{ name: 'review' }] } : wire.type === 'get_messages' ? { messages: [{ role: 'user', content: body }] } : { disposition: 'started' } });
  const runtime = setup(t, connection);
  await runtime.execute('prompt', { message: body });
  assert.equal(connection.calls[0].message, body);
  await runtime.execute('get_messages');
  assert.equal(runtime.getState().messages[0].content, body, 'History string projection preserves the full confirmed text.');
  const before = connection.calls.length;
  await assert.rejects(runtime.execute('prompt', { message: 'x'.repeat(262145) }), error => error.code === 'INPUT_TOO_LARGE' && error.actual === 262145 && error.limit === 262144);
  assert.equal(connection.calls.length, before);
  await runtime.execute('get_commands');
  const args = 'x'.repeat(40000);
  await runtime.execute('invoke_command', { name: 'review', arguments: args });
  assert.equal(connection.calls.at(-1).message, '/review ' + args);
  const count = connection.calls.length;
  await assert.rejects(runtime.execute('invoke_command', { name: 'review', arguments: 'x'.repeat(262144) }), error => error.code === 'INPUT_TOO_LARGE');
  assert.equal(connection.calls.length, count);
});

test('file references require explicit host support and complete staging acknowledgement', async t => {
  const reference = { id: 'stored-1', projectId: 'p1', name: 'full.pdf', mimeType: 'application/pdf', size: 1234, versionId: 'v1' };
  const raw = host(), runtime = setup(t, raw);
  await assert.rejects(runtime.execute('prompt', { message: 'Read', fileReferences: [reference] }), error => error.code === 'FILES_UNSUPPORTED');
  assert.equal(raw.calls.length, 0);
  const files = [{ name: 'full.pdf', size: 1234 }];
  let staged;
  const supported = host({ properties: { supportsFileReferences: true, inputContract: { maxMessageCharacters: 20 }, async stageFiles(given, context) { staged = { given, context }; return { fileReferences: [reference] }; } } });
  const binding = runtime.attach(supported, { refresh: false });
  const result = await binding.session.stageFiles(files, { projectId: 'p1', sessionId: 's1' });
  assert.equal(staged.given, files);
  assert.deepEqual(plain(result.fileReferences), [reference]);
  await binding.session.prompt('Read the entire file', result);
  assert.deepEqual(plain(supported.calls.at(-1).fileReferences), [reference]);
  assert.equal(runtime.getInputContract().maxMessageCharacters, 20);
  await assert.rejects(binding.session.prompt('x'.repeat(21)), error => error.code === 'INPUT_TOO_LARGE');
  supported.stageFiles = async () => ({ fileReferences: [] });
  await assert.rejects(binding.session.stageFiles(files, { projectId: 'p1' }), /every attachment/);
});

test('all extension requests and all offered options survive display-sized queues', async t => {
  const connection = host(), runtime = setup(t, connection);
  const options = Array.from({ length: 350 }, (_, index) => 'Choice ' + index);
  for (let index = 0; index < 55; index++) connection.emit({ type: 'extension_ui_request', id: 'request-' + index, method: 'select', title: 'Choose ' + index, options });
  assert.equal(runtime.getPendingUIRequests().length, 55);
  assert.equal(runtime.getState().ui.pendingRequestCount, 55);
  assert.equal(runtime.getState().ui.requests[0].options.length, 350);
  await runtime.respondUI('request-0', { value: 'Choice 349' });
  assert.equal(connection.responses[0].value, 'Choice 349');
  assert.equal(runtime.getState().ui.pendingRequestCount, 54);
  await runtime.respondUI('request-54', { cancelled: true });
  assert.deepEqual(plain(connection.responses.at(-1)), { type: 'extension_ui_response', id: 'request-54', cancelled: true });
  assert.equal(runtime.getState().ui.pendingRequestCount, 53);
});

test('timeouts send cancellation; rejected cancellations remain pending across detach and request-ID reuse', async t => {
  let reject = true;
  const first = host({ send: () => !reject }), runtime = setup(t, first);
  first.emit({ type: 'extension_ui_request', id: 'shared-id', method: 'input', title: 'Original', timeout: 1 });
  await tick();
  assert.equal(first.responses[0].cancelled, true);
  assert.equal(runtime.getState().ui.pendingRequestCount, 1);
  assert.match(runtime.getState().ui.requests[0].responseError, /did not accept/);
  const originalKey = runtime.getState().ui.requests[0].requestKey;
  runtime.detach(); await tick();
  assert.equal(runtime.getState().ui.requests[0].detached, true);
  const second = host(); runtime.attach(second, { refresh: false });
  second.emit({ type: 'extension_ui_request', id: 'shared-id', method: 'input', title: 'New session' });
  assert.equal(runtime.getState().ui.pendingRequestCount, 2);
  await assert.rejects(runtime.respondUI(originalKey, { value: 'wrong session' }), /earlier connection/);
  reject = false;
  await runtime.respondUI(originalKey, { cancelled: true });
  assert.equal(runtime.getState().ui.pendingRequestCount, 1);
  assert.equal(second.responses.length, 0, 'An old cancellation is sent only to its origin.');
  await runtime.respondUI('shared-id', { value: 'new answer' });
  assert.equal(second.responses.at(-1).value, 'new answer');
  assert.equal(runtime.getState().ui.pendingRequestCount, 0);
  second.emit({ type: 'extension_ui_request', id: 'expire-success', method: 'confirm', timeout: 1 });
  await tick();
  assert.deepEqual(plain(second.responses.at(-1)), { type: 'extension_ui_response', id: 'expire-success', cancelled: true });
  assert.equal(runtime.getState().ui.pendingRequestCount, 0);
});

test('done and message_end finalize one message without merging distinct equal-text messages', () => {
  const activity = load('pi-activity').AthenaPiActivity.create();
  const message = id => ({ ...(id ? { id } : {}), role: 'assistant', content: [{ type: 'text', text: 'The same answer' }], stopReason: 'stop' });
  activity.receive({ type: 'agent_start' });
  activity.receive({ type: 'message_start', message: message() });
  activity.receive({ type: 'message_update', assistantMessageEvent: { type: 'done', message: message() } });
  const revision = activity.getState().textRevision;
  activity.receive({ type: 'message_end', message: message() });
  assert.equal(activity.getState().messages.length, 1);
  assert.equal(activity.getState().textRevision, revision);
  activity.receive({ type: 'message_start', message: message('different') });
  activity.receive({ type: 'message_end', message: message('different') });
  activity.receive({ type: 'message_update', assistantMessageEvent: { type: 'done', message: message('different') } });
  assert.equal(activity.getState().messages.length, 2);
  assert.equal(activity.getState().text, 'The same answer\n\nThe same answer');
  activity.destroy();
});

test('assistant text stays complete while bounded tool previews expose full-length metadata', () => {
  const activity = load('pi-activity').AthenaPiActivity.create();
  activity.receive({ type: 'agent_start' });
  const long = 'response '.repeat(40000);
  const message = { role: 'assistant', content: [{ type: 'text', text: long }], stopReason: 'stop' };
  activity.receive({ type: 'message_start', message });
  activity.receive({ type: 'message_update', assistantMessageEvent: { type: 'done', message } });
  activity.receive({ type: 'message_end', message });
  assert.equal(activity.getState().text, long); assert.equal(activity.getState().messages.length, 1);
  const args = { command: 'x'.repeat(5000), structured: { keep: true } };
  activity.receive({ type: 'tool_execution_start', toolCallId: 'actual-tool', toolName: 'bash', args });
  activity.receive({ type: 'tool_execution_update', toolCallId: 'actual-tool', toolName: 'bash', partialResult: { output: 'y'.repeat(70000) } });
  const tool = activity.getState().tools[0];
  assert.equal(tool.inputTruncated, true); assert.equal(tool.inputCharacters, JSON.stringify(args).length); assert.equal(tool.inputPreviewCharacters, JSON.stringify(tool.args).length);
  assert.equal(tool.outputTruncated, true); assert.equal(tool.outputCharacters, 70000); assert.equal(tool.outputPreviewCharacters, 65536); assert.equal(tool.output.length, 65536);
  activity.receive({ type: 'bash_execution_update', id: 'shell-1', delta: 'a'.repeat(70000) });
  activity.receive({ type: 'bash_execution_update', id: 'shell-1', delta: 'bc' });
  const shell = activity.getState().tools.find(item => item.toolCallId === 'rpc-bash:shell-1');
  assert.equal(shell.outputCharacters, 70002); assert.equal(shell.outputPreviewCharacters, 65536); assert.ok(shell.output.endsWith('bc'));
  activity.destroy();
});
