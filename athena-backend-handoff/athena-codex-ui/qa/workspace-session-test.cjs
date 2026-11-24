#!/usr/bin/env node
'use strict';
// Read-only projection contract tests with explicit fixtures, no scheduler/backend.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const crypto = require('node:crypto');
const source = fs.readFileSync(path.resolve(__dirname, '../ui/workspace-session.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise,resolve,reject }; };

function create(t, { storage = new Map(), storageFailure = false } = {}) {
  let state = { connected: false, session: {}, model: null, thinkingLevel: null };
  const subscribers = new Set(), eventSubscribers = new Set(), demoSubscribers = new Set(), calls = [];
  const runtime = {
    getState: () => state,
    subscribe(fn) { subscribers.add(fn); fn(state); return () => subscribers.delete(fn); },
    subscribeEvents(fn) { eventSubscribers.add(fn); return () => eventSubscribers.delete(fn); },
    set(next) { state = { ...state, ...next }; for (const fn of subscribers) fn(state); },
    emit(event) { for (const fn of eventSubscribers) fn(event); }
  };
  const demoState = { run: { id: 'sample-run', status: 'ready' }, tasks: [{ id: 'sample-task' }], agents: [], tools: [{ id: 'sample-tool' }], artifacts: [{ id: 'sample-artifact' }], events: [], approvals: [] };
  const demo = { getState: () => plain(demoState), subscribe(fn) { demoSubscribers.add(fn); fn(demoState); return () => demoSubscribers.delete(fn); } };
  for (const method of ['start','pause','resume','reset','cancel','configure','setScenario','retryTask','decideApproval']) demo[method] = (...args) => { calls.push({ method,args }); for (const fn of demoSubscribers) fn(demoState); return true; };
  const context = vm.createContext({ window: { crypto: crypto.webcrypto, localStorage: { getItem: key => storage.get(key) ?? null, setItem(key, value) { if (storageFailure) throw new Error('Storage unavailable'); storage.set(key, String(value)); } } }, Date }); vm.runInContext(source, context);
  const errors = [];
  const workspace = context.window.AthenaWorkspaceSession.create({ demo, runtime, onError: message => errors.push(message) });
  t.after(() => workspace.destroy());
  return { workspace,runtime,calls,errors,storage };
}
function snapshot(revision = 1, patch = {}) {
  const scope = { projectId: 'project-1', sessionId: 'session-1', runId: 'run-1' };
  return { revision, projectId: scope.projectId, sessionId: scope.sessionId,
    projects: [{ id: 'project-1', name: 'Project', defaultModel: { provider: 'local', modelId: 'project-default' } }],
    sessions: [{ id: 'session-1', projectId: 'project-1', title: 'Research' }],
    run: { id: 'run-1', status: 'running', startedAt: 1, elapsedMs: 50, model: { provider: 'local', modelId: 'run-model', thinkingLevel: 'high' } },
    tasks: [{ ...scope, id: 'task-1', title: 'Read source', status: 'running', dependencies: [], toolIds: ['tool-1'], artifactIds: ['artifact-1'] }],
    agents: [{ ...scope, id: 'agent-1', taskId: 'task-1', name: 'Reader', role: 'researcher', status: 'running' }],
    tools: [{ ...scope, id: 'tool-1', taskId: 'task-1', name: 'read', sdkToolName: 'read', status: 'running', args: { path: '/project/source.md' }, logs: [] }],
    artifacts: [{ ...scope, id: 'artifact-1', version: 'v1', taskId: 'task-1', title: 'Evidence', kind: 'document', status: 'ready', review: { status: 'unreviewed', version: 'v1' }, evidence: [] }],
    events: [{ ...scope, id: 'event-1', type: 'tool.started', taskId: 'task-1', toolId: 'tool-1', at: 10, summary: 'Reading source' }],
    approvals: [{ ...scope, id: 'approval-1', taskId: 'task-1', status: 'pending', description: 'Read', scope: 'project', impact: 'read-only' }],
    ...patch };
}
function manager(initial, capabilities = []) {
  let listener;
  const calls = [];
  return { capabilities, calls, getSnapshot: async () => initial,
    subscribe(fn) { listener = fn; return () => { calls.push(['unsubscribe']); }; },
    emit(next) { listener?.(next); },
    callback() { return listener; },
    async createProject(input) { calls.push(['createProject', input]); return { project: { id: 'created-project', name: input.name } }; },
    async createSession(input) { calls.push(['createSession', input]); return { sessionId: 'created-session' }; },
    async retryTask(taskId, request) { calls.push(['retryTask', taskId, request]); return { taskId, parentTaskId: 'root-task', runId: 'run-1', attemptId: 'retry-attempt', agentSessionId: 'agent-session', status: 'queued', reconciliationAttemptId: 'reconcile-attempt' }; },
    async cancelRun(runId) { calls.push(['cancelRun', runId]); }
  };
}
function retrySnapshot(revision = 1, patch = {}) {
  const current = snapshot(revision);
  return { ...current, tasks: [{ ...current.tasks[0], parentTaskId: 'root-task', attemptId: 'attempt-1', status: 'paused', retryable: true }], attempts: [{ id: 'attempt-1', taskId: 'task-1', status: 'paused', error: 'Host restarted.' }], ...patch };
}

test('manual retry deduplicates pending clicks and preserves reported history until the host updates it', async t => {
  const { workspace } = create(t), pending = deferred();
  const initial = retrySnapshot(), host = manager(initial, ['retry_task']);
  host.retryTask = (taskId, request) => { host.calls.push(['retryTask', taskId, request]); return pending.promise; };
  await workspace.attach(host);
  const before = workspace.getState();
  const first = workspace.retryTask('task-1'), second = workspace.retryTask('task-1');
  assert.equal(first, second); assert.equal(workspace.getState().retryOperations['task-1'].pending, true);
  await Promise.resolve(); assert.equal(host.calls.length, 1);
  assert.equal(host.calls[0][2].expectedAttemptId, 'attempt-1');
  for (const field of ['tasks', 'attempts', 'tools', 'artifacts']) assert.deepEqual(workspace.getState()[field], before[field]);
  pending.resolve({ taskId: 'task-1', runId: 'run-1', attemptId: 'attempt-2', status: 'queued' });
  await first;
  assert.equal(workspace.getState().retryOperations['task-1'].pending, false);
  assert.equal(workspace.getState().retryOperations['task-1'].accepted, true);
  await workspace.retryTask('task-1'); assert.equal(host.calls.length, 1, 'An accepted receipt cannot resubmit a still-stale task projection.');
  host.emit(retrySnapshot(2, { tasks: [{ ...initial.tasks[0], status: 'running', retryable: false, attemptId: 'attempt-2' }], attempts: [...initial.attempts, { id: 'attempt-2', taskId: 'task-1', status: 'running', retryOfAttemptId: 'attempt-1' }] }));
  assert.equal(workspace.getState().retryOperations['task-1'], undefined);
  assert.equal(workspace.getState().attempts[0].error, 'Host restarted.');
  assert.equal(workspace.getState().attempts.length, 2);
});

test('an uncertain retry response stays task-local and reuses the durable request after reload', async t => {
  const storage = new Map(), first = create(t, { storage }), calls = [];
  const initial = retrySnapshot(), host = manager(initial, ['retry_task']);
  host.retryTask = async (taskId, request) => { calls.push(plain(request)); throw new Error('Connection lost for task-1 and attempt-1.'); };
  await first.workspace.attach(host);
  assert.equal(await first.workspace.retryTask('task-1'), null);
  assert.match(first.workspace.getState().retryOperations['task-1'].error, /Connection lost/);
  assert.equal(first.workspace.getState().error, null);
  assert.equal(first.workspace.getState().taskManagerStatus, 'connected'); assert.deepEqual(first.errors, []);
  await first.workspace.retryTask('task-1'); assert.deepEqual(calls[1], calls[0]);
  first.workspace.destroy();
  const reloaded = create(t, { storage }); await reloaded.workspace.attach(host);
  await reloaded.workspace.retryTask('task-1'); assert.deepEqual(calls[2], calls[0]);
  const saved = [...storage.values()].join('');
  assert.equal(saved.includes('Connection lost'), false); assert.equal(saved.includes('Host restarted'), false);
  assert.equal(saved.includes(calls[0].requestId), true);
});

test('new attempts receive new request identities and late failures do not leak across conversations', async t => {
  const { workspace } = create(t), pending = deferred(), initial = retrySnapshot();
  const host = manager(initial, ['retry_task']);
  host.retryTask = (taskId, request) => { host.calls.push(plain(request)); return host.calls.length === 1 ? pending.promise : Promise.resolve({ taskId, runId: 'run-1', attemptId: 'attempt-3', status: 'queued' }); };
  await workspace.attach(host);
  const first = workspace.retryTask('task-1'); await Promise.resolve();
  host.emit(retrySnapshot(2, { tasks: [{ ...initial.tasks[0], attemptId: 'attempt-2' }] }));
  pending.reject(new Error('The old attempt changed.')); await first;
  assert.equal(workspace.getState().retryOperations['task-1'], undefined);
  await workspace.retryTask('task-1');
  assert.notEqual(host.calls[0].requestId, host.calls[1].requestId);
  assert.equal(host.calls[1].expectedAttemptId, 'attempt-2');
  workspace.confirmSession({ sessionId: 'another-session', projectId: 'another-project' });
  assert.deepEqual(plain(workspace.getState().retryOperations), {});
  assert.equal(await workspace.retryTask('task-1'), null);
  assert.equal(host.calls.length, 2);
});

test('retry sends nothing if durable identity storage is unavailable or the host changes before dispatch', async t => {
  const first = create(t, { storageFailure: true }), host = manager(retrySnapshot(), ['retry_task']);
  await first.workspace.attach(host); await first.workspace.retryTask('task-1');
  assert.equal(host.calls.length, 0); assert.match(first.workspace.getState().retryOperations['task-1'].error, /could not be saved/);
  const second = create(t), oldHost = manager(retrySnapshot(), ['retry_task']), newHost = manager(retrySnapshot(8), ['retry_task']);
  await second.workspace.attach(oldHost);
  const result = second.workspace.retryTask('task-1');
  await second.workspace.attach(newHost); await result;
  assert.equal(oldHost.calls.some(call => call[0] === 'retryTask'), false);
  assert.equal(newHost.calls.length, 0);
  assert.deepEqual(plain(second.workspace.getState().retryOperations), {});
});

test('real connections isolate sample data and never run the demo scheduler', async t => {
  const { workspace,runtime,calls } = create(t);
  assert.equal(workspace.getState().mode, 'preview'); assert.equal(workspace.getState().tasks[0].id, 'sample-task');
  runtime.set({ connected: true, session: { sessionId: 'session-1' } });
  assert.equal(workspace.getState().mode, 'runtime');
  assert.deepEqual(plain(workspace.getState().tasks), []); assert.deepEqual(plain(workspace.getState().artifacts), []);
  const before = calls.length;
  for (const method of ['start','pause','resume','reset']) assert.equal(workspace[method](), false);
  assert.equal(workspace.configure({ parallelLimit: 4 }), false); assert.equal(calls.length, before);
  const host = manager(retrySnapshot(), ['retry_task']); await workspace.attach(host);
  assert.equal(workspace.getState().tasks[0].id, 'task-1'); assert.equal(workspace.getState().taskManagerConnected, true);
  await workspace.retryTask('task-1'); assert.deepEqual(host.calls[0].slice(0, 2), ['retryTask','task-1']);
  assert.equal(host.calls[0][2].expectedAttemptId, 'attempt-1'); assert.ok(host.calls[0][2].requestId);
  assert.equal(calls.some(call => call.method === 'start'), false);
});

test('accepted snapshots are immutable, retain common IDs, and isolate approvals by session', async t => {
  const { workspace,runtime } = create(t);
  runtime.set({ connected: true, session: { sessionId: 'session-1' }, model: { provider: 'local', id: 'chat-model' }, thinkingLevel: 'medium' });
  const initial = snapshot();
  initial.approvals.push({ ...initial.approvals[0], id: 'foreign-approval', projectId: 'other-project', sessionId: 'other-session' });
  const host = manager(initial); await workspace.attach(host);
  initial.projects[0].name = 'Mutated without a revision'; initial.tasks[0].title = 'Mutated'; initial.agents[0].name = 'Mutated'; initial.artifacts[0].review.status = 'approved';
  const state = workspace.getState();
  assert.equal(state.projects[0].name, 'Project'); assert.equal(state.tasks[0].title, 'Read source'); assert.equal(state.agents[0].name, 'Reader'); assert.equal(state.artifacts[0].review.status, 'unreviewed');
  assert.deepEqual(plain(state.approvals.map(item => item.id)), ['approval-1']);
  workspace.observeActivity({ runId: 999, tools: [{ toolCallId: 'tool-1', toolName: 'read', status: 'succeeded', output: 'Entire source', args: { path: '/project/source.md' } }] });
  const tool = workspace.getState().tools[0];
  assert.equal(tool.id, 'tool-1'); assert.equal(tool.taskId, 'task-1'); assert.equal(tool.sessionId, 'session-1'); assert.equal(tool.runId, 'run-1');
  assert.equal(workspace.getState().tasks[0].toolIds[0], tool.id); assert.equal(workspace.getState().artifacts[0].taskId, tool.taskId);
  workspace.observeManual({ toolCallId: 'manual-1', args: { command: 'pwd' }, output: '/project', status: 'succeeded' });
  workspace.observeActivity({ tools: [] });
  assert.ok(workspace.getState().tools.some(item => item.id === 'manual-1'), 'Manual command records survive later model activity snapshots.');
});

test('stale revisions and late snapshots from replaced managers cannot overwrite current state', async t => {
  const { workspace } = create(t);
  const pending = deferred(); const first = manager(null); first.getSnapshot = () => pending.promise;
  const oldAttach = workspace.attach(first), oldListener = first.callback();
  const second = manager(snapshot(8)); await workspace.attach(second);
  oldListener(snapshot(100, { projectId: 'wrong-project' }));
  pending.resolve(snapshot(99, { projectId: 'wrong-project' })); await oldAttach;
  assert.equal(workspace.getState().revision, 8); assert.equal(workspace.getState().projectId, 'project-1');
  assert.equal(workspace.ingest(snapshot(7)), false); assert.equal(workspace.ingest(snapshot(8)), false);
  assert.throws(() => workspace.ingest(snapshot(9, { tasks: [{ id: '' }] })), /identifiers/);
  assert.equal(workspace.getState().revision, 8);
});

test('capabilities require a confirmed snapshot and callable host method; rejected reads stay unconnected', async t => {
  const { workspace } = create(t), pending = deferred();
  const host = manager(null, ['create_project', 'create_session']); host.getSnapshot = () => pending.promise; host.createSession = undefined;
  const attaching = workspace.attach(host);
  assert.equal(workspace.getState().taskManagerConnected, false); assert.equal(workspace.getState().taskManagerStatus, 'connecting');
  await assert.rejects(workspace.createProject({ name: 'Too early' }), /does not provide/);
  pending.resolve(snapshot()); await attaching;
  assert.equal(workspace.getState().capabilities.createProject, true); assert.equal(workspace.getState().capabilities.createSession, false);
  const result = await workspace.createProject({ name: 'Real request' }); assert.equal(result.project.id, 'created-project');
  const failing = manager(null, ['create_project']); failing.getSnapshot = async () => { throw new Error('Host unavailable'); };
  await assert.rejects(workspace.attach(failing), /Host unavailable/);
  assert.equal(workspace.getState().taskManagerConnected, false); assert.equal(workspace.getState().connected, false); assert.equal(workspace.getState().taskManagerStatus, 'error');
  await assert.rejects(workspace.createProject({ name: 'Not sent' }), /does not provide/);
});

test('app, project, conversation and frozen run models remain separate', async t => {
  const { workspace,runtime } = create(t);
  workspace.setAppDefault({ provider: 'local', modelId: 'app-default' });
  workspace.getState().modelScopes.appDefault.modelId = 'attempted mutation';
  assert.equal(workspace.getState().modelScopes.appDefault.modelId, 'app-default');
  runtime.set({ connected: true, session: { sessionId: 'session-1' }, model: { provider: 'local', id: 'chat-model' }, thinkingLevel: 'medium' });
  const host = manager(snapshot()); await workspace.attach(host);
  const scopes = workspace.getState().modelScopes;
  assert.equal(scopes.appDefault.modelId, 'app-default'); assert.equal(scopes.projectDefault.modelId, 'project-default'); assert.equal(scopes.conversation.modelId, 'chat-model'); assert.equal(scopes.runLocked.modelId, 'run-model');
  const changed = snapshot(2); changed.run.model = { provider: 'local', modelId: 'other-model' };
  host.emit(changed);
  assert.equal(workspace.getState().modelScopes.runLocked.modelId, 'run-model'); assert.match(workspace.getState().error, /execution-start model/);
  runtime.set({ model: { provider: 'local', id: 'new-conversation-model' } });
  assert.equal(workspace.getState().modelScopes.conversation.modelId, 'new-conversation-model'); assert.equal(workspace.getState().modelScopes.runLocked.modelId, 'run-model');
});

test('Pi-only observations never manufacture a backend run ID and clear on session replacement', t => {
  const { workspace,runtime } = create(t);
  runtime.set({ connected: true, session: { sessionId: 'session-1', isStreaming: true }, model: { provider: 'local', id: 'first' }, thinkingLevel: 'high' });
  runtime.emit({ type: 'agent_start' });
  workspace.observeActivity({ runId: 77, settled: false, tools: [{ toolCallId: 'actual-tool', toolName: 'read', status: 'running' }] });
  assert.equal(workspace.getState().run.id, null); assert.equal(workspace.getState().tools[0].runId, null);
  runtime.set({ model: { provider: 'local', id: 'later' }, thinkingLevel: 'low' });
  assert.equal(workspace.getState().modelScopes.runLocked.modelId, 'first');
  runtime.set({ session: { sessionId: 'session-2' } });
  assert.equal(workspace.getState().tools.length, 0); assert.equal(workspace.getState().modelScopes.runLocked, null);
});

function sessionSnapshot(revision, label) {
  const projectId = 'project-' + label, sessionId = 'session-' + label, runId = 'run-' + label;
  const scope = { projectId, sessionId, runId };
  return snapshot(revision, {
    projectId, sessionId,
    projects: [{ id: projectId, name: 'Project ' + label, defaultModel: { provider: 'local', modelId: 'project-' + label } }],
    sessions: [{ id: sessionId, projectId, title: 'Research ' + label }],
    run: { id: runId, status: 'running', startedAt: revision, elapsedMs: 0, model: { provider: 'local', modelId: 'run-' + label } },
    tasks: [{ ...scope, id: 'task-' + label, title: 'Read ' + label, status: 'running', dependencies: [], toolIds: ['tool-' + label], artifactIds: [] }],
    agents: [{ ...scope, id: 'agent-' + label, taskId: 'task-' + label, name: 'Reader ' + label, role: 'researcher', status: 'running' }],
    tools: [{ ...scope, id: 'tool-' + label, taskId: 'task-' + label, name: 'read', sdkToolName: 'read', status: 'running', args: {}, logs: [] }],
    artifacts: [],
    events: [{ ...scope, id: 'event-' + label, toolId: 'tool-' + label, taskId: 'task-' + label, type: 'tool.started', at: revision, summary: 'Read ' + label }],
    approvals: [{ ...scope, id: 'approval-' + label, taskId: 'task-' + label, status: 'pending', description: 'Read ' + label, scope: 'project', impact: 'read-only' }]
  });
}

test('confirmed session activation waits for matching Pi and workspace identities without leaking the old session', async t => {
  const { workspace,runtime } = create(t);
  runtime.set({ connected: true, session: { sessionId: 'session-A', runId: 'run-A' }, model: { provider: 'local', id: 'chat-A' }, thinkingLevel: 'medium' });
  const host = manager(sessionSnapshot(1, 'A'), ['retry_task', 'cancel_run']);
  await workspace.attach(host);
  runtime.emit({ type: 'agent_start' });
  workspace.observeManual({ toolCallId: 'manual-A', args: { command: 'pwd' }, output: '/A', status: 'succeeded' });
  const confirmed = { sessionId: 'session-B', projectId: 'project-B', title: 'Confirmed B', model: { provider: 'local', modelId: 'requested-B' } };
  workspace.confirmSession(confirmed);
  confirmed.title = 'Mutated after confirmation';
  let state = workspace.getState();
  assert.equal(state.sessionId, 'session-B'); assert.equal(state.projectId, 'project-B');
  assert.equal(state.sessionBound, false); assert.equal(state.workspaceBound, false);
  assert.equal(state.sessions.find(item => item.id === 'session-B').title, 'Confirmed B');
  for (const key of ['tasks','agents','tools','artifacts','events','approvals']) assert.deepEqual(plain(state[key]), [], key + ' must not come from session A.');
  assert.equal(state.run.id, null); assert.equal(state.modelScopes.conversation, null); assert.equal(state.modelScopes.runLocked, null);
  assert.equal(state.capabilities.retryTask, false); assert.equal(state.capabilities.cancelRun, false);

  // A newer authoritative revision about A must not erase B's confirmed activation.
  host.emit(sessionSnapshot(2, 'A'));
  state = workspace.getState();
  assert.equal(state.sessionId, 'session-B'); assert.equal(state.workspaceBound, false); assert.equal(state.sessionBound, false);
  assert.equal(state.tasks.length, 0); assert.equal(state.tools.length, 0); assert.equal(state.modelScopes.conversation, null);

  // Pi can bind B before the TaskManager catches up. Its observed records must
  // use B's actual project/run identity, never the stale TaskManager A identity.
  runtime.set({ session: { sessionId: 'session-B', runId: 'run-B', isStreaming: true }, model: { provider: 'local', id: 'chat-B' }, thinkingLevel: 'high' });
  runtime.emit({ type: 'agent_start' });
  workspace.observeActivity({ settled: false, tools: [{ toolCallId: 'pi-tool-B', toolName: 'read', status: 'running' }] });
  workspace.observeManual({ toolCallId: 'manual-B', args: { command: 'pwd' }, output: '/B', status: 'succeeded' });
  runtime.emit({ type: 'tool_execution_start', toolCallId: 'pi-tool-B', toolName: 'read' });
  state = workspace.getState();
  assert.equal(state.sessionBound, true); assert.equal(state.workspaceBound, false);
  assert.equal(state.run.id, 'run-B'); assert.equal(state.modelScopes.conversation.modelId, 'chat-B'); assert.equal(state.modelScopes.runLocked.modelId, 'chat-B');
  assert.equal(state.tasks.length, 0);
  assert.deepEqual(plain(state.tools.map(item => item.id).sort()), ['manual-B','pi-tool-B']);
  for (const tool of state.tools) { assert.equal(tool.sessionId, 'session-B'); assert.equal(tool.projectId, 'project-B'); }
  assert.equal(state.tools.find(item => item.id === 'pi-tool-B').runId, 'run-B');
  assert.equal(state.events[0].sessionId, 'session-B'); assert.equal(state.events[0].projectId, 'project-B');

  // Once B is authoritative, the temporary activation must stop pinning B.
  host.emit(sessionSnapshot(3, 'B'));
  state = workspace.getState();
  assert.equal(state.sessionId, 'session-B'); assert.equal(state.workspaceBound, true); assert.equal(state.sessionBound, true);
  assert.deepEqual(plain(state.tasks.map(item => item.id)), ['task-B']);
  assert.equal(state.modelScopes.runLocked.modelId, 'run-B');
  host.emit(sessionSnapshot(4, 'C'));
  state = workspace.getState();
  assert.equal(state.sessionId, 'session-C'); assert.equal(state.projectId, 'project-C');
  assert.equal(state.workspaceBound, true); assert.equal(state.sessionBound, false);
  assert.deepEqual(plain(state.tasks.map(item => item.id)), ['task-C']);
  assert.deepEqual(plain(state.tools.map(item => item.id)), ['tool-C']);
  assert.equal(state.modelScopes.conversation, null); assert.equal(state.modelScopes.runLocked.modelId, 'run-C');
});

test('session mutations without an inline snapshot refresh the authoritative host state', async t => {
  const { workspace,runtime } = create(t);
  runtime.set({ connected: true, session: { sessionId: 'session-A' } });
  let current = sessionSnapshot(1, 'A'), reads = 0;
  const host = manager(current, ['create_session']);
  host.getSnapshot = async () => { reads++; return current; };
  host.createSession = async input => {
    current = sessionSnapshot(2, 'B');
    return { sessionId: 'session-B', projectId: 'project-B', title: input.title };
  };
  await workspace.attach(host);
  const activation = await workspace.createSession({ projectId: 'project-B', title: 'Confirmed B' });
  assert.equal(activation.sessionId, 'session-B'); assert.equal(reads, 2);
  assert.equal(workspace.getState().sessionId, 'session-B'); assert.equal(workspace.getState().revision, 2);
  assert.equal(workspace.getState().sessionBound, false);
  assert.deepEqual(plain(workspace.getState().tasks.map(item => item.id)), ['task-B']);
});
