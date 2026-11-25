'use strict';
// DOM and graph-projection contracts. Real browser interaction is checked separately.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { parseHTML } = require(require.resolve('linkedom', { paths: [__dirname, ...(process.env.ATHENA_QA_DEPENDENCIES ? [process.env.ATHENA_QA_DEPENDENCIES] : [])] }));
const base = path.resolve(__dirname, '..');
const copy = value => JSON.parse(JSON.stringify(value));
const scope = { projectId: 'project-private', sessionId: 'session-private', runId: 'run-private' };
function environment(data = {}, mount = false) {
  const { window, document } = parseHTML('<html><body><main id="athena-codex"><div id="host"></div></main></body></html>');
  Object.defineProperty(window.HTMLElement.prototype, 'open', { configurable: true, get() { return this.hasAttribute('open'); }, set(value) { this.toggleAttribute('open', Boolean(value)); } });
  Object.defineProperty(window.HTMLSelectElement.prototype, 'value', { configurable: true, get() { return [...this.options].find(option => option.hasAttribute('selected'))?.value || this.options[0]?.value || ''; }, set(value) { for (const option of this.options) option.toggleAttribute('selected', option.value === String(value)); } });
  let snapshot = { mode: 'runtime', ...scope, run: { id: scope.runId, status: 'running' }, taskManagerConnected: true, tasks: [], processes: [], attempts: [], tools: [], agents: [], artifacts: [], approvals: [], events: [], capabilities: {}, ...copy(data) };
  let subscriber; const navigation = [];
  const store = { getState: () => snapshot, subscribe(callback) { subscriber = callback; return () => { subscriber = null; }; } };
  window.AthenaPiActivity = { iconHTML: () => '', toolPresentation: () => ({ icon: 'circle' }) };
  const context = { window, document, AbortController, URL, Blob, Date, setTimeout, clearTimeout, navigator: {} };
  for (const name of ['activity-labels', 'result-files', 'workflow-graph', ...(mount ? ['workspace-views'] : [])]) vm.runInNewContext(fs.readFileSync(path.join(base, 'ui', name + '.js'), 'utf8'), context, { filename: name });
  const host = document.querySelector('#host');
  const api = mount ? window.AthenaWorkspaceViews.mount(host, { store, onNavigate: (view, selection) => navigation.push({ view, ...selection }) }) : null;
  return { window, host, api, navigation, graph: window.AthenaWorkflowGraph, get snapshot() { return snapshot; },
    project() { return window.AthenaWorkflowGraph.project(snapshot); },
    render() { host.innerHTML = window.AthenaWorkflowGraph.render(this.project()); return host; },
    q(selector) { return host.querySelector(selector); },
    click(selector) { const button = host.querySelector(selector); assert.ok(button, selector); button.dispatchEvent(new window.Event('click', { bubbles: true })); },
    change(selector, value) { const select = host.querySelector(selector); assert.ok(select, selector); select.value = value; select.dispatchEvent(new window.Event('change', { bubbles: true })); },
    put(next) { snapshot = { ...snapshot, ...copy(next) }; subscriber?.(snapshot); },
    close() { api?.destroy(); } };
}
function displayedText(root) {
  if (root.nodeType === 3) return root.textContent;
  if (root.nodeType !== 1 || root.hasAttribute('hidden')) return '';
  const children = root.localName === 'details' && !root.hasAttribute('open') ? [root.querySelector('summary')].filter(Boolean) : [...root.childNodes];
  return [root.getAttribute('aria-label'), root.getAttribute('title'), ...children.map(displayedText)].filter(Boolean).join(' ');
}
const task = (id, title, extra = {}) => ({ ...scope, id, title, status: 'running', dependencies: [], ...extra });
const study = () => [task('task-coordinator', 'Summarize the measurements'), task('task-csv', 'Inspect voltage CSV', { parentTaskId: 'task-coordinator' }), task('task-rc', 'Check RC response', { parentTaskId: 'task-coordinator' })];

test('delegation remains a distinct association; waitFor dependencies keep child-to-coordinator layout stable', () => {
  const e = environment({ tasks: study() });
  const before = e.project();
  assert.deepEqual(copy(before.edges).map(({ source, target, kind }) => ({ source, target, kind })), [
    { source: 'task-csv', target: 'task-coordinator', kind: 'delegation' }, { source: 'task-rc', target: 'task-coordinator', kind: 'delegation' }
  ]);
  const beforePositions = copy(before.nodes.map(({ id, x, y }) => ({ id, x, y })));
  e.put({ tasks: study().map(t => t.id === 'task-coordinator' ? { ...t, dependencies: ['task-csv', 'task-rc'] } : t) });
  const after = e.project();
  assert.deepEqual(copy(after.nodes.map(({ id, x, y }) => ({ id, x, y }))), beforePositions);
  assert.equal(after.edges.length, 2); assert.ok(after.edges.every(edge => edge.kind === 'dependency' && !edge.cyclic));
  e.render(); assert.equal(e.host.querySelectorAll('[data-awg-edge="dependency"]').length, 2);
  assert.match(displayedText(e.host), /Dotted links show delegation, not execution order/);
});

test('unrelated tasks are not connected or ordered by timestamps; source records are never mutated', () => {
  const e = environment({ tasks: [task('task-first', 'Read input', { createdAt: 100 }), task('task-later', 'Inspect output', { createdAt: 999 })] });
  const original = JSON.stringify(e.snapshot), model = e.project();
  assert.equal(model.edges.length, 0); assert.equal(model.nodes[0].rank, model.nodes[1].rank);
  e.render(); assert.equal(JSON.stringify(e.snapshot), original);
});

test('missing, duplicate and circular relations remain explicit without inventing a node or ordering cyclic tasks', () => {
  const e = environment({ tasks: [
    task('task-a', 'Inspect measurements', { dependencies: ['task-b', 'task-missing'] }),
    task('task-b', 'Review measurements', { dependencies: ['task-a'] }),
    task('task-final', 'Write findings', { dependencies: ['task-b'] }),
    task('task-a', 'Duplicate must not render'),
    task('task-other-run', 'Other run must not render', { runId: 'different-run' })
  ] });
  const model = e.project();
  assert.equal(model.nodes.length, 3); assert.equal(model.missing.length, 1); assert.equal(model.duplicates.length, 1);
  assert.deepEqual(copy(model.cyclicIds).sort(), ['task-a', 'task-b']);
  assert.equal(model.nodes[0].rank, model.nodes[1].rank); assert.ok(model.nodes[2].rank > model.nodes[1].rank);
  e.render(); assert.match(e.host.textContent, /Circular relationships/); assert.match(e.host.textContent, /Some linked tasks/);
  assert.equal(e.host.textContent.includes('task-missing'), false); assert.equal(e.host.textContent.includes('Other run'), false);
  assert.equal(e.host.querySelectorAll('.awg-edge-cyclic').length, 2);
});

test('graph preserves each process outcome during task retry and shows previous attempts using readable labels', () => {
  const tasks = study().map(t => t.id === 'task-csv' ? { ...t, attemptId: 'attempt-retry-private', status: 'running' } : t);
  const e = environment({ tasks, attempts: [
    { ...scope, id: 'attempt-old-private', taskId: 'task-csv', status: 'failed' },
    { ...scope, id: 'attempt-retry-private', taskId: 'task-csv', status: 'running', retryOfAttemptId: 'attempt-old-private' }
  ], processes: [
    { ...scope, id: 'process-complete-private', taskId: 'task-csv', attemptId: 'attempt-old-private', status: 'succeeded', job: { mcp: { alias: 'calculate_csv', resultKind: 'csv-statistics', server: 'athena-measurements', tool: 'calculate_csv' } } },
    { ...scope, id: 'process-failed-private', taskId: 'task-csv', attemptId: 'attempt-old-private', status: 'failed', job: { program: 'Check measurements' } }
  ] });
  e.render(); const card = e.q('[data-awg-node="task-csv"]');
  assert.equal(card.dataset.awgStatus, 'running');
  assert.deepEqual([...card.querySelectorAll('.awg-processes small')].map(node => node.textContent), ['Complete', 'Failed']);
  assert.match(displayedText(card), /Attempt 2/); assert.match(displayedText(card), /Previous: Failed/);
  for (const id of ['task-csv', 'attempt-old-private', 'attempt-retry-private', 'process-complete-private', 'process-failed-private']) assert.equal(displayedText(card).includes(id), false, id);
  e.put({ tasks: tasks.map(t => ({ ...t, status: 'cancelled' })) }); e.render();
  assert.deepEqual([...e.q('[data-awg-node="task-csv"]').querySelectorAll('.awg-processes small')].map(node => node.textContent), ['Complete', 'Failed']);
});

test('a graph task or process opens existing details; controls preserve viewport and scope changes reset zoom', () => {
  const e = environment({ tasks: study(), processes: [{ ...scope, id: 'process-rc', taskId: 'task-rc', status: 'succeeded', job: { program: 'RC response' } }] }, true);
  try {
    assert.equal(e.api.getState().workflowMode, 'graph'); assert.ok(e.q('[data-awg-canvas]'));
    e.click('[data-awg-node="task-rc"] [data-awv-task]');
    assert.equal(e.q('[data-awv-detail-heading]').textContent, 'Check RC response');
    e.click('[data-awg-node="task-rc"] [data-awv-open-process]');
    assert.deepEqual(e.navigation.pop(), { view: 'execution', processId: 'process-rc', taskId: 'task-rc' });
    e.click('[data-awv-action="graph-zoom-in"]'); assert.equal(e.q('[data-awg-zoom]').textContent, '110%');
    const viewport = e.q('[data-awg-viewport]'); viewport.scrollLeft = 70; viewport.scrollTop = 40;
    e.put({ tasks: study().map(t => ({ ...t, status: 'succeeded' })) });
    assert.equal(e.q('[data-awg-viewport]').scrollLeft, 70); assert.equal(e.q('[data-awg-viewport]').scrollTop, 40);
    assert.equal(e.q('[data-awg-zoom]').textContent, '110%');
    e.click('[data-awv-action="graph-fit"]'); assert.ok(e.api.getState().graphZoom <= 100); assert.equal(e.q('[data-awg-viewport]').scrollLeft, 0);
    e.click('[data-awv-action="workflow-mode"][data-awv-value="list"]'); assert.ok(e.q('.awv-task-list')); assert.equal(e.q('[data-awg-canvas]'), null);
    e.click('[data-awv-action="workflow-mode"][data-awv-value="graph"]'); assert.ok(e.q('[data-awg-canvas]'));
    e.put({ sessionId: 'empty-conversation', run: { status: 'ready' }, tasks: [], processes: [] });
    assert.equal(e.api.getState().graphZoom, 100); assert.equal(e.q('[data-awg-node]'), null); assert.match(e.host.textContent, /No workflow tasks yet/);
  } finally { e.close(); }
});

test('large parallel groups wrap without overlapping cards or claiming sequential execution', () => {
  const tasks = [task('root', 'Review all checks'), ...Array.from({ length: 11 }, (_, i) => task('child-' + i, 'Check ' + (i + 1), { parentTaskId: 'root' }))];
  const e = environment({ tasks }), model = e.project();
  assert.equal(model.nodes.length, 12); assert.equal(model.edges.length, 11);
  for (const node of model.nodes) {
    assert.ok(node.x >= 0 && node.y >= 0); assert.ok(node.x + node.width <= model.width); assert.ok(node.y + node.height <= model.height);
    for (const other of model.nodes) if (node !== other) assert.ok(node.x + node.width <= other.x || other.x + other.width <= node.x || node.y + node.height <= other.y || other.y + other.height <= node.y, 'Cards must not overlap.');
  }
  assert.equal(new Set(model.nodes.filter(node => node.id !== 'root').map(node => node.rank)).size, 1);
});

test('graph buttons escape record text and expose full labels without adding fake processes', () => {
  const e = environment({ tasks: [task('task-unsafe', '<img src=x onerror=alert(1)> Check task-unsafe')] });
  e.render(); assert.equal(e.q('img'), null); assert.equal(e.q('[data-awv-open-process]'), null);
  assert.equal(displayedText(e.host).includes('task-unsafe'), false); assert.ok(e.q('[data-awv-task]').getAttribute('title'));
  assert.equal(e.q('[data-awg-viewport]').getAttribute('tabindex'), '0');
  assert.equal(e.q('[role="listitem"]').querySelector('button').getAttribute('aria-pressed'), 'false');
});

test('saved request selection keeps graph, list, count, details and calculations in the same run without losing history', () => {
  const old = task('task-earlier', 'Earlier CSV inspection', { runId: 'run-earlier', status: 'succeeded' });
  const latest = task('task-latest', 'Current RC inspection', { runId: 'run-latest', status: 'running' });
  const process = (id, taskId, runId) => ({ ...scope, id, taskId, runId, status: 'succeeded', job: { mcp: { alias: 'calculate_csv', server: 'athena-measurements', tool: 'calculate_csv', resultKind: 'csv-statistics' } } });
  const e = environment({ run: { id: 'run-latest', status: 'running' }, tasks: [old, latest], processes: [process('process-earlier', old.id, old.runId), process('process-latest', latest.id, latest.runId)], capabilities: { cancelRun: true } }, true);
  try {
    assert.equal(e.q('[data-awv-run-selector]').hidden, false);
    assert.deepEqual([...e.host.querySelectorAll('[data-awg-node]')].map(node => node.dataset.awgNode), [latest.id]);
    assert.equal(e.q('[data-awv-task-count]').textContent, '0 / 1 complete');
    assert.equal(e.q('[data-awv-detail-heading]').textContent, latest.title);
    assert.equal(e.q('[data-awv-measurements] [data-awv-open-process]').dataset.awvOpenProcess, 'process-latest');
    e.change('[data-awv-run-select]', old.runId);
    assert.deepEqual([...e.host.querySelectorAll('[data-awg-node]')].map(node => node.dataset.awgNode), [old.id]);
    assert.equal(e.q('[data-awv-task-count]').textContent, '1 / 1 complete');
    assert.equal(e.q('[data-awv-detail-heading]').textContent, old.title);
    assert.equal(e.q('[data-awv-measurements] [data-awv-open-process]').dataset.awvOpenProcess, 'process-earlier');
    assert.equal(e.q('[data-awv-action="cancel-run"]'), null, 'Inspecting an earlier request must not offer cancellation of the new run.');
    assert.equal(e.q('[data-awv-run-status]').textContent, 'Saved task records');
    e.click('[data-awv-action="workflow-mode"][data-awv-value="list"]');
    assert.deepEqual([...e.host.querySelectorAll('.awv-task-list [data-awv-task]')].map(node => node.dataset.awvTask), [old.id]);
    const newer = task('task-newest', 'Another request', { runId: 'run-newest' });
    e.put({ run: { id: 'run-newest', status: 'running' }, tasks: [old, latest, newer] });
    assert.equal(e.api.getState().workflowRunId, old.runId); assert.equal(e.q('[data-awv-detail-heading]').textContent, old.title);
    e.api.open('workflow', { taskId: latest.id });
    assert.equal(e.api.getState().workflowRunId, latest.runId); assert.equal(e.q('[data-awv-detail-heading]').textContent, latest.title);
    e.click('[data-awv-action="workflow-mode"][data-awv-value="graph"]');
    assert.equal(e.q('[data-awg-node] [aria-pressed="true"]').dataset.awvTask, latest.id);
    const shown = displayedText(e.host);
    for (const id of ['run-earlier', 'run-latest', 'run-newest']) assert.equal(shown.includes(id), false);
    assert.equal(e.snapshot.tasks.length, 3, 'The projection never deletes previous requests.');
  } finally { e.close(); }
});
