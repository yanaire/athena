'use strict';
// Deterministic source + DOM checks with synthetic identities. No real model,
// desktop app, rendered CSS, or transport is exercised here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const dependencyPaths = [__dirname, ...(process.env.ATHENA_QA_DEPENDENCIES ? [process.env.ATHENA_QA_DEPENDENCIES] : [])];
const { parseHTML } = require(require.resolve('linkedom', { paths: dependencyPaths }));
const sourceRoot = path.resolve(__dirname, '..');
const ids = Object.freeze({
  session: 'session-5ad4ef39-676b-4208-b739-6ef45c2c4318',
  run: 'run-5b2641e5-7551-4b55-a823-8db4d052e644',
  task: 'task-6b57d6e6-843b-4b2d-a5f6-cf7ed21fcb57',
  agent: 'agent-a2bcbf04-cd0f-46f7-b28c-0eb3e653cae4',
  agentSession: 'agent-session-37aaafae-e9f6-4ad1-bee8-dc0d9343ec11',
  attempt: 'attempt-a70cbcd2-de39-44f1-bccd-b405c7ac363c',
  process: 'process-3a583e42-1125-4627-9d85-60ae52a73873',
  tool: 'tool-09bfc16c-5465-40d8-ae89-d98e1154be4a'
});

function environment(files) {
  const { window, document } = parseHTML('<html><body><main id="root"><section id="aw-activity"></section><section id="pi-tools"></section></main></body></html>');
  // LinkeDOM lacks native details reflection and browser focus/layout behavior.
  Object.defineProperty(window.HTMLElement.prototype, 'open', { configurable: true, get() { return this.hasAttribute('open'); }, set(value) { this.toggleAttribute('open', Boolean(value)); } });
  const copied = [];
  const context = vm.createContext({ window, document, AbortController, URL, Date, Blob, setTimeout, clearTimeout, navigator: { clipboard: { writeText: async text => copied.push(text) } } });
  for (const file of files) vm.runInContext(fs.readFileSync(path.join(sourceRoot, 'ui', file + '.js'), 'utf8'), context, { filename: file + '.js' });
  const click = node => { assert.ok(node); node.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true })); };
  return { window, document, copied, click };
}

function displayedText(node) {
  if (node.nodeType === 3) return node.textContent;
  if (node.nodeType !== 1 || node.hasAttribute('hidden')) return '';
  const attrs = [node.getAttribute('aria-label'), node.getAttribute('title')].filter(Boolean).join(' ');
  const children = node.localName === 'details' && !node.hasAttribute('open') ? [node.querySelector('summary')].filter(Boolean) : [...node.childNodes];
  return attrs + ' ' + children.map(displayedText).join(' ');
}

function hidesIds(node) {
  const shown = displayedText(node);
  for (const id of Object.values(ids)) assert.equal(shown.includes(id), false, 'Unexpected visible identity: ' + id);
}

test('display labels handle missing metadata without changing identifiers or authored titles', () => {
  const e = environment(['activity-labels']);
  const labels = e.window.AthenaActivityLabels;
  const tasks = [{ id: ids.task, title: ids.task }];
  const before = JSON.stringify(tasks);
  assert.ok(labels.task(tasks[0], tasks));
  assert.equal(labels.task(tasks[0], tasks).includes(ids.task), false);
  assert.equal(labels.task({ id: ids.task, title: 'Review task-driven neural control' }, tasks), 'Review task-driven neural control');
  assert.equal(labels.task({ id: ids.task, title: '생체 신호 분석' }, tasks), '생체 신호 분석');
  assert.equal(labels.agent({ id: ids.agent, name: ids.agent, taskId: ids.task }, tasks).includes(ids.agent), false);
  assert.equal(labels.text('Waiting for ' + ids.task, 'Waiting for the agent', [ids.task]), 'Waiting for the agent');
  assert.equal(labels.text('Started task-1', 'Working', ['task-1']), 'Working', 'Short known identifiers are hidden in sentences.');
  assert.equal(labels.text('Started (task-1).', 'Working', ['task-1']), 'Working');
  assert.equal(labels.text('Started task-10', 'Working', ['task-1']), 'Started task-10', 'Identifier matching respects token boundaries.');
  const shortTask = { id: 'task-1', title: 'Started task-1' };
  assert.equal(labels.task(shortTask, [shortTask]), 'Task 1');
  assert.equal(labels.attempt('attempt-current', { attemptId: 'attempt-current' }), 'Current attempt');
  assert.equal(labels.attempt('attempt-earlier', { attemptId: 'attempt-current' }), 'Attempt', 'An unknown historical attempt is not called current.');
  assert.equal(JSON.stringify(tasks), before, 'Presentation does not rewrite state identities.');
  const host = e.document.querySelector('#pi-tools');
  host.innerHTML = labels.diagnostics([['Task', ids.task], ['Literal', '<script>bad()</script>']], ids.task);
  assert.equal(host.querySelector('details').open, false);
  assert.equal(host.querySelector('script'), null);
  assert.ok(host.textContent.includes(ids.task));
  assert.ok(host.textContent.includes('<script>bad()</script>'));
  hidesIds(host);
});

test('file and command activity keeps legitimate task-like names in both presentation and workspace summaries', () => {
  const e = environment(['activity-labels', 'pi-activity', 'workspace-chrome']);
  const cases = [
    ['read', { path: 'task-list.js' }, 'task-list.js'],
    ['read', { path: '/work/task-2026.csv' }, '/work/task-2026.csv'],
    ['bash', { command: 'run-analysis' }, 'run-analysis'],
    ['read_file', { name: 'task-results.json' }, 'task-results.json']
  ];
  const task = { id: 'task-2026', title: 'Inspect measurements', status: 'running' };
  for (const [name, args, expected] of cases) {
    assert.equal(e.window.AthenaPiActivity.toolPresentation(name, args, 'running', [task]).detail, expected);
  }
  const snapshot = { mode: 'runtime', revision: 1, sessionId: ids.session, run: { id: ids.run, status: 'running' }, tasks: [task], agents: [], tools: cases.map(([name, args], index) => ({ id: 'tool-file-' + index, taskId: task.id, name, sdkToolName: name, args, source: 'host', status: 'running', logs: [], command: args.command || '', cwd: '/work' })), processes: [], artifacts: [], events: [], approvals: [], capabilities: {} };
  const store = { getState: () => snapshot, subscribe(fn) { fn(snapshot); return () => {}; } };
  const root = e.document.querySelector('#root');
  const view = e.window.AthenaWorkspaceChrome.mount(root, { store });
  try {
    assert.deepEqual([...root.querySelectorAll('.aw-tool-target')].map(node => node.textContent), cases.map(([, , expected]) => expected), 'Workspace chrome does not filter legitimate file or command targets a second time.');
  } finally { view.destroy(); }
});

test('coordination tools use readable activity summaries and retain exact raw input, output, and copies', async () => {
  const e = environment(['activity-labels', 'pi-activity', 'pi-session-view']);
  const pi = e.window.AthenaPiActivity.create();
  const host = e.document.querySelector('#pi-tools');
  let workspace = { tasks: [{ id: ids.task, title: 'Analyze voltage' }] };
  const view = e.window.AthenaPiSessionView.mount(host, { getWorkspace: () => workspace });
  const unsubscribe = pi.subscribe(view.render);
  try {
    pi.receive({ type: 'agent_start' });
    for (const toolName of ['spawn_agent', 'send_to_agent', 'wait_for_agents', 'get_task', 'list_tasks', 'cancel_task']) {
      const args = toolName === 'spawn_agent' ? { title: 'Inspect the measurement file', prompt: 'Check its columns.' } : { taskId: ids.task, taskIds: [ids.task], message: 'Continue checking.' };
      const call = ids.tool + '-' + toolName;
      pi.receive({ type: 'tool_execution_start', toolCallId: call, toolName, args });
      const row = [...host.querySelectorAll('[data-ap-tool]')].find(node => node.dataset.apTool === call);
      assert.ok(row);
      assert.notEqual(row.querySelector('.ap-tool-label').textContent, 'Running tool', 'Coordination has a meaningful label: ' + toolName);
      hidesIds(row);
      if (toolName === 'spawn_agent') assert.match(row.querySelector('summary').textContent, /Inspect the measurement file/);
      const raw = JSON.stringify({ taskId: ids.task, agentSessionId: ids.agentSession, state: 'running' });
      pi.receive({ type: 'tool_execution_end', toolCallId: call, toolName, result: { content: [{ type: 'text', text: raw }] } });
      assert.equal(row.dataset.toolId, call);
      row.open = true;
      const diagnostics = row.querySelector('[data-aw-diagnostics]');
      assert.ok(diagnostics, 'Raw coordination payload has an explicit diagnostic disclosure.');
      assert.equal(diagnostics.open, false);
      hidesIds(row);
      assert.equal(row.querySelector('[data-ap-output]').textContent, raw);
      assert.deepEqual(JSON.parse(row.querySelector('[data-ap-input]').textContent), args, 'String taskIds arrays remain intact in input previews and copies.');
      diagnostics.open = true;
      e.click(row.querySelector('[data-ap-copy="output"]'));
      await Promise.resolve();
      assert.equal(e.copied.at(-1), raw);
      e.click(row.querySelector('[data-ap-copy="input"]'));
      await Promise.resolve();
      assert.equal(e.copied.at(-1), row.querySelector('[data-ap-input]').textContent);
      // Updating a row preserves the user's expanded diagnostic state.
      pi.receive({ type: 'queue_update', steering: [], followUp: [] });
      assert.equal(row.querySelector('[data-aw-diagnostics]').open, true);
      if (toolName === 'wait_for_agents') {
        assert.equal(row.querySelector('.ap-tool-target').textContent, 'Analyze voltage');
        workspace = { tasks: [{ id: ids.task, title: 'Validate voltage' }] };
        view.refresh();
        assert.equal(row.querySelector('.ap-tool-target').textContent, 'Validate voltage', 'Task metadata can arrive after the tool event.');
        assert.equal(row.querySelector('[data-aw-diagnostics]').open, true);
        assert.deepEqual(JSON.parse(row.querySelector('[data-ap-input]').textContent), args);
      }
      row.open = false;
    }
  } finally { unsubscribe(); pi.destroy(); view.destroy(); }
});

test('workspace activity hides runtime identities in summaries and preserves agent navigation and raw logs', async () => {
  const e = environment(['activity-labels', 'pi-activity', 'workspace-chrome']);
  e.window.AthenaAvatars = { html: () => '<span aria-hidden="true">●</span>' };
  const task = { id: ids.task, title: ids.task, role: 'analyst', status: 'running', attemptId: ids.attempt, agentSessionId: ids.agentSession };
  const rawLog = 'Waiting for ' + ids.task;
  let snapshot = { mode: 'runtime', revision: 1, sessionId: ids.session, sessions: [{ id: ids.session, title: 'Measurement study' }], run: { id: ids.run, status: 'running' }, tasks: [task], attempts: [{ id: 'attempt-earlier', taskId: ids.task, status: 'failed' }, { id: ids.attempt, taskId: ids.task, status: 'running' }], agents: [{ id: ids.agent, name: ids.agent, role: 'analyst', taskId: ids.task, agentSessionId: ids.agentSession, status: 'running' }], tools: [{ id: ids.tool, taskId: ids.task, name: 'Wait for agents', sdkToolName: 'wait_for_agents', args: { taskIds: [ids.task] }, source: 'host', status: 'running', logs: [{ at: 1, text: rawLog }], command: 'wait_for_agents', cwd: '/work' }], processes: [{ id: ids.process, processId: ids.process, taskId: ids.task, attemptId: ids.attempt, toolId: ids.tool, status: 'running', job: { program: 'python3', args: ['measurements.py'], stdout: 'Reading measurements', stderr: '' } }], artifacts: [], events: [], approvals: [], capabilities: { agentHistory: true } };
  let update;
  const nav = [];
  const store = { getState: () => snapshot, subscribe(fn) { update = fn; fn(snapshot); return () => {}; } };
  const root = e.document.querySelector('#root');
  const view = e.window.AthenaWorkspaceChrome.mount(root, { store, onNavigate: (target, selection) => nav.push({ target, ...selection }) });
  const host = root.querySelector('#aw-activity');
  try {
    hidesIds(host);
    assert.ok(host.querySelector('[data-aw-agent-reveal]'));
    e.click(host.querySelector('[data-aw-agent-reveal]'));
    assert.deepEqual(nav.pop(), { target: 'timeline', taskId: ids.task, agentSessionId: ids.agentSession });
    const diagnostics = [...host.querySelectorAll('[data-aw-diagnostics]')];
    assert.ok(diagnostics.some(node => node.textContent.includes(ids.session)));
    assert.ok(diagnostics.some(node => node.textContent.includes(ids.run)));
    assert.ok(diagnostics.every(node => !node.open));
    assert.equal(host.querySelector('[data-aw-event-tool]').dataset.awEventTool, ids.tool);
    assert.ok(host.querySelector('[data-aw-log]').textContent.includes(rawLog), 'Raw execution log is preserved.');
    view.revealTool({ toolId: ids.tool });
    e.click(host.querySelector('[data-aw-tool-action="copy-log"]'));
    await Promise.resolve();
    assert.ok(e.copied.at(-1).includes(rawLog));
    snapshot = { ...snapshot, revision: 2, tasks: [{ ...task, title: 'Inspect measurements' }] };
    update(snapshot);
    assert.match(host.querySelector('.aw-tool-task').textContent, /Inspect measurements/);
    assert.equal(host.querySelector('.aw-tool-task').textContent.includes(ids.task), false);
    assert.equal(view.revealTool({ processId: ids.process }), true);
    const process = host.querySelector('[data-aw-process]');
    assert.match(process.querySelector('.aw-tool-task').textContent, /Attempt 2/, 'Process attempt numbering comes from the matching task history.');
    assert.ok(process.querySelector('[data-aw-diagnostics]').textContent.includes(ids.process));
    assert.equal(process.querySelector('[data-aw-diagnostics]').open, false);
    hidesIds(process);
  } finally { view.destroy(); }
});

test('registered RC tools and process phases use readable labels without exposing file or execution IDs', async () => {
  const { circuits } = await import(path.resolve(sourceRoot, '../../runtime/mcp-contract.mjs'));
  const e = environment(['activity-labels', 'pi-activity', 'result-files', 'workspace-chrome']);
  const presentation = e.window.AthenaPiActivity.toolPresentation(circuits.alias, { fileId: ids.tool }, 'running');
  assert.equal(presentation.label, 'Calculating RC response');
  assert.equal(presentation.detail, 'Assigned circuit JSON');
  assert.equal(e.window.AthenaPiActivity.toolPresentation(circuits.alias, {}, 'succeeded').label, 'RC response calculated');
  const process = { id: ids.process, processId: ids.process, taskId: ids.task, attemptId: ids.attempt, toolId: ids.tool, status: 'running', job: { mcp: { ...circuits, phase: 'tools/list' }, program: '/bundled/node' } };
  let snapshot = { mode: 'runtime', revision: 1, sessionId: ids.session, run: { id: ids.run, status: 'running' }, tasks: [{ id: ids.task, title: 'Inspect circuit response', status: 'running' }], agents: [], attempts: [], tools: [], processes: [process], artifacts: [], approvals: [] };
  let update;
  const store = { getState: () => snapshot, subscribe(fn) { update = fn; fn(snapshot); return () => {}; } };
  const host = e.document.querySelector('#root');
  const view = e.window.AthenaWorkspaceChrome.mount(host, { store });
  try {
    const summary = host.querySelector('[data-aw-process] > summary');
    assert.match(summary.textContent, /RC step response/); assert.match(summary.textContent, /Discovering tools/); hidesIds(host);
    assert.equal(summary.textContent.includes('/bundled/node'), false);
    assert.equal(summary.textContent.includes(circuits.tool), false);
    assert.ok(host.querySelector('[data-aw-process] [data-aw-diagnostics]').textContent.includes(circuits.server));
    snapshot = { ...snapshot, revision: 2, processes: [{ ...process, job: { ...process.job, mcp: { ...process.job.mcp, server: 'unregistered-server' } } }] };
    update(snapshot);
    assert.match(host.querySelector('[data-aw-process] > summary').textContent, /Engineering calculation/); hidesIds(host);
  } finally { view.destroy(); }
});

test('measurement activity keeps failed tool outcomes after child or process completion', async () => {
  const { measurements: metadata } = await import(path.resolve(sourceRoot, '../../runtime/mcp-contract.mjs'));
  const e = environment(['activity-labels', 'pi-activity', 'result-files', 'workspace-chrome']);
  e.window.AthenaAvatars = { html: () => '<span aria-hidden="true">●</span>' };
  const task = { id: ids.task, title: 'Summarize measurements', status: 'succeeded', attemptId: ids.attempt, agentSessionId: ids.agentSession };
  const program = '/Applications/Athena.app/Contents/MacOS/athena-node';
  const tool = { id: ids.tool, taskId: task.id, name: 'calculate_csv', sdkToolName: 'calculate_csv', args: { column: 'measurement_mV' }, source: 'host', status: 'failed', logs: [{ at: 1, text: 'measurement_mV · Unclosed quoted CSV field.' }], command: 'calculate_csv', cwd: '/work' };
  const process = { id: ids.process, processId: ids.process, taskId: task.id, attemptId: ids.attempt, toolId: tool.id, status: 'failed', job: { mcp: { ...metadata, phase: 'tools/call' }, program, args: [], stdout: 'MCP tools/call', stderr: '', error: 'Unclosed quoted CSV field.' } };
  let snapshot = { mode: 'runtime', revision: 1, sessionId: ids.session, run: { id: ids.run, status: 'succeeded' }, tasks: [task], attempts: [{ id: ids.attempt, taskId: task.id, status: 'succeeded' }], agents: [{ id: ids.agent, name: 'Measurement worker', role: 'worker', taskId: task.id, agentSessionId: ids.agentSession, status: 'succeeded' }], tools: [tool], processes: [process], artifacts: [], events: [], approvals: [], capabilities: {} };
  let update;
  const store = { getState: () => snapshot, subscribe(fn) { update = fn; fn(snapshot); return () => {}; } };
  const root = e.document.querySelector('#root');
  const view = e.window.AthenaWorkspaceChrome.mount(root, { store });
  try {
    const activity = root.querySelector('#aw-activity');
    const toolRow = activity.querySelector('[data-aw-event-tool]');
    assert.match(toolRow.querySelector('.aw-agent-name').textContent, /CSV calculation failed/);
    assert.equal(toolRow.querySelector('.aw-status').dataset.status, 'failed');
    assert.equal(toolRow.querySelector('.aw-status').textContent, 'Needs attention');
    assert.equal(toolRow.textContent.includes('CSV statistics calculated'), false);
    assert.equal(toolRow.textContent.includes('Complete'), false);
    assert.match(activity.querySelector('.aw-agent-presence').textContent, /complete/, 'The child that explained the failure remains complete.');

    const processRow = activity.querySelector('[data-aw-process]');
    assert.match(processRow.querySelector('.aw-agent-name').textContent, /Measurement statistics/);
    assert.equal(processRow.querySelector('.aw-status').textContent, 'Needs attention');
    assert.equal(processRow.querySelector('summary').textContent.includes(program), false);
    processRow.open = true;
    assert.ok(processRow.querySelector('.aw-tool-command').textContent.includes(program), 'Technical details retain the full program path.');

    // Successful worker exit does not make a failed tool wrapper successful.
    snapshot = { ...snapshot, revision: 2, tools: [{ ...tool, logs: [{ at: 2, text: 'Artifact verification failed.' }] }], processes: [{ ...process, status: 'succeeded', job: { ...process.job, error: undefined } }] };
    update(snapshot);
    const failedWrapper = activity.querySelector('[data-aw-event-tool]');
    assert.match(failedWrapper.querySelector('.aw-agent-name').textContent, /CSV calculation failed/);
    assert.equal(failedWrapper.querySelector('.aw-status').dataset.status, 'failed');
    assert.equal(failedWrapper.querySelector('.aw-status').textContent, 'Needs attention');
    assert.equal(activity.querySelector('[data-aw-process] .aw-status').dataset.status, 'succeeded');
    assert.match(failedWrapper.querySelector('[data-aw-log]').textContent, /Artifact verification failed/);

    snapshot = { ...snapshot, revision: 3, tools: [{ ...tool, status: 'succeeded', logs: [] }] };
    update(snapshot);
    const successfulTool = activity.querySelector('[data-aw-event-tool]');
    assert.match(successfulTool.querySelector('.aw-agent-name').textContent, /CSV statistics calculated/);
    assert.equal(successfulTool.querySelector('.aw-status').textContent, 'Complete');

    // Preview activity remains task-driven, even with stale tool/process state.
    snapshot = { ...snapshot, mode: 'preview', revision: 4, run: { ...snapshot.run, status: 'failed' }, tasks: [{ ...task, status: 'failed', progress: 1, total: 2 }] };
    update(snapshot);
    const previewTool = activity.querySelector('[data-aw-event-tool]');
    assert.match(previewTool.querySelector('.aw-agent-name').textContent, /CSV calculation failed/);
    assert.equal(previewTool.querySelector('.aw-status').dataset.status, 'failed');
    assert.equal(previewTool.querySelector('.aw-status').textContent, 'Needs attention');
  } finally { view.destroy(); }
});
