#!/usr/bin/env node
/**
 * Contract tests using explicit SDK-shaped mocks. No SDK process, browser,
 * provider, shell, network, credentials, or real session files are accessed.
 * Run: node --test qa/pi-host-adapter-test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPiHostAdapter, PI_RPC_COMMANDS, PI_HOST_COMMANDS } from '../integrations/pi-host-adapter.mjs';

const deferred = () => {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

function fixture() {
  const calls = [];
  const model = {
    id: 'alpha', provider: 'local', name: 'Alpha', api: 'test-api', reasoning: true,
    input: ['text', 'image'], contextWindow: 64000, maxTokens: 4096,
    baseUrl: 'https://person:password@example.test/v1?api_key=secret#debug',
    headers: { Authorization: 'secret-header' }, apiKey: 'secret-key',
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 }
  };
  const model2 = { ...model, id: 'beta', name: 'Beta' };
  const call = (name, args, result) => { calls.push({ name, args }); return result; };
  const templates = [{ name: 'review', description: 'Review a change', content: 'Review $1', sourceInfo: { path: '/prompts/review.md' }, filePath: '/prompts/review.md' }];
  const resourceLoader = {
    getSkills: () => ({ skills: [{ name: 'research', description: 'Research evidence', filePath: '/skills/research/SKILL.md', sourceInfo: { path: '/skills/research/SKILL.md' } }], diagnostics: [{ type: 'warning', message: 'Skill note' }] }),
    getPrompts: () => ({ prompts: templates, diagnostics: [] }),
    getThemes: () => ({ themes: [{ name: 'ivory' }], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [{ path: '/AGENTS.md', content: 'Project conventions' }] }),
    getSystemPromptSource: () => ({ path: '/SYSTEM.md' }),
    getAppendSystemPromptSources: () => [{ path: '/APPEND.md' }],
    getExtensions: () => ({
      extensions: [{ path: '/ext.ts', resolvedPath: '/ext.ts', sourceInfo: { path: '/ext.ts' }, tools: new Map([['custom', {}]]), commands: new Map([['inspect', {}]]), flags: new Map(), handlers: new Map([['input', []]]) }],
      errors: [{ path: '/bad.ts', error: 'Load failed' }], warnings: [], runtime: { apiKey: 'do-not-serialize-runtime' }
    })
  };
  const settingsManager = {
    getSettings: () => ({ defaultModel: 'alpha', cacheWarming: 'off', apiKey: 'private-key', httpProxy: 'https://user:pass@proxy.test?token=private', env: { TOKEN: 'private' } }),
    getGlobalSettings: () => ({ defaultModel: 'alpha' }),
    getProjectSettings: () => ({ defaultTools: ['read'] }),
    getCacheWarmingMode: () => 'off'
  };

  function makeSession(id) {
    const listeners = new Set();
    const remembered = [];
    const entries = [
      { id: 'u1', parentId: null, type: 'message', message: { role: 'user', content: 'https://example.test/search?q=keep-this' } },
      { id: 'a1', parentId: 'u1', type: 'message', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'private-thought' }, { type: 'text', text: 'Visible answer' }] } }
    ];
    const manager = {
      getCwd: () => '/project',
      getLeafId: () => 'a1',
      getEntries: () => entries,
      getTree: () => [{ entry: entries[0], children: [{ entry: entries[1], children: [] }] }],
      getEntry: entryId => entries.find(entry => entry.id === entryId),
      appendLabelChange: (...args) => call('appendLabelChange', args, 'label-1')
    };
    const session = {
      sessionId: id, sessionFile: '/' + id + '.jsonl', sessionName: id,
      messages: entries.map(entry => entry.message), sessionManager: manager,
      model, thinkingLevel: 'medium', isStreaming: false, isCompacting: false,
      isIdle: true, steeringMode: 'one-at-a-time', followUpMode: 'one-at-a-time',
      autoCompactionEnabled: true, autoRetryEnabled: true, isRetrying: false,
      isBashRunning: false, retryAttempt: 0, pendingMessageCount: 0,
      systemPrompt: 'Effective project instructions', scopedModels: [{ model, thinkingLevel: 'low' }],
      cacheWarmingStatus: { state: 'inactive', reason: 'disabled' },
      resourceLoader, settingsManager, promptTemplates: templates,
      modelRuntime: { getAvailableSnapshot: () => [model, model2] },
      extensionRunner: {
        getRegisteredCommands: () => [{ invocationName: 'inspect', description: 'Inspect', sourceInfo: { path: '/ext.ts' } }],
        emitUserBash: async event => call('emitUserBash', [event], undefined)
      },
      subscribe(listener) {
        listeners.add(listener); remembered.push(listener);
        return () => { calls.push({ name: 'unsubscribe', args: [id] }); listeners.delete(listener); };
      },
      emit(event) { for (const listener of listeners) listener(event); },
      remembered,
      async prompt(text, options) {
        call('prompt', [text, options]);
        if (this.isStreaming && !options.streamingBehavior) throw new Error('streamingBehavior required');
        options.preflightResult(options.streamingBehavior ? 'queued' : 'started');
      },
      async steer(...args) { return call('steer', args, 'queued'); },
      async followUp(...args) { return call('followUp', args, 'handled'); },
      async abort() { return call('abort', [], undefined); },
      clearQueue: () => call('clearQueue', [], { steering: ['steering draft'], followUp: ['follow-up draft'] }),
      async setModel(next, options) { this.model = next; call('setModel', [next, options]); },
      async cycleModel(...args) { return call('cycleModel', args, { model: model2, thinkingLevel: 'low', isScoped: true }); },
      setThinkingLevel(...args) { this.thinkingLevel = args[0]; call('setThinkingLevel', args); },
      cycleThinkingLevel: () => call('cycleThinkingLevel', [], 'high'),
      getAvailableThinkingLevels: () => ['off', 'low', 'medium', 'high'],
      setSteeringMode: (...args) => call('setSteeringMode', args),
      setFollowUpMode: (...args) => call('setFollowUpMode', args),
      compact: async (...args) => call('compact', args, { summary: 'Compacted', firstKeptEntryId: 'u1', tokensBefore: 1000, estimatedTokensAfter: 300 }),
      setAutoCompactionEnabled: (...args) => call('setAutoCompactionEnabled', args),
      setAutoRetryEnabled: (...args) => call('setAutoRetryEnabled', args),
      abortRetry: () => call('abortRetry', []),
      executeBash: async (...args) => call('executeBash', args, { output: 'ok', exitCode: 0, cancelled: false, truncated: false }),
      recordBashResult: (...args) => call('recordBashResult', args),
      abortBash: () => call('abortBash', []),
      getSessionStats: () => ({ sessionId: id, tokens: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, total: 120 }, cost: 0.01, contextUsage: { tokens: null, contextWindow: 64000, percent: null } }),
      exportToHtml: async path => call('exportToHtml', [path], path || '/export.html'),
      exportToJsonl: path => call('exportToJsonl', [path], path || '/export.jsonl'),
      getUserMessagesForForking: () => [{ entryId: 'u1', text: 'Original request' }],
      getLastAssistantText: () => 'Visible answer',
      setSessionName: (...args) => call('setSessionName', args),
      getContextUsage: () => ({ tokens: null, contextWindow: 64000, percent: null }),
      getAllTools: () => [{ name: 'read', description: 'Read a file', parameters: { type: 'object' }, exposure: 'direct', sourceInfo: { path: 'builtin:read' } }, { name: 'custom', description: 'Custom', parameters: {}, exposure: 'deferred' }],
      getActiveToolNames: () => ['read'], getCallableToolNames: () => ['read', 'custom'],
      setActiveToolsByName: (...args) => call('setActiveToolsByName', args),
      navigateTree: async (...args) => call('navigateTree', args, { editorText: 'Old prompt', cancelled: false }),
      reload: async () => call('reload', []),
      abortCompaction: () => call('abortCompaction', []),
      abortBranchSummary: () => call('abortBranchSummary', []),
      setScopedModels(next) { this.scopedModels = next; call('setScopedModels', [next]); },
      setCacheWarmingMode: (...args) => call('setCacheWarmingMode', args)
    };
    return session;
  }

  const initial = makeSession('initial');
  let revision = 0;
  const runtime = {
    session: initial, cwd: '/project', hook: async () => call('originalHook', []),
    setRebindSession(fn) { this.hook = fn; call('setRebindSession', [fn]); },
    async replace() { this.session = makeSession('session-' + (++revision)); if (this.hook) await this.hook(this.session); },
    async newSession(...args) { call('newSession', args); await this.replace(); return { cancelled: false }; },
    async switchSession(...args) { call('switchSession', args); await this.replace(); return { cancelled: false }; },
    async fork(...args) { call('fork', args); await this.replace(); return { cancelled: false, selectedText: 'Fork text' }; },
    async importFromJsonl(...args) { call('importFromJsonl', args); await this.replace(); return { cancelled: false }; }
  };
  const SessionManager = {
    list: async (...args) => call('list', args, [{ id: 'initial', path: '/initial.jsonl', cwd: '/project', created: new Date('2026-01-01') }]),
    listAll: async (...args) => call('listAll', args, [{ id: 'other', path: '/other.jsonl', cwd: '/other' }])
  };
  const adapter = createPiHostAdapter({ runtime, SessionManager });
  const request = (type, fields = {}) => adapter.request({ id: 'test-' + type, type, ...fields });
  return { calls, initial, runtime, adapter, request, SessionManager, makeSession, model, model2, resourceLoader };
}

test('attaching is observational and partial hosts advertise only callable capabilities', async () => {
  let subscriptions = 0; let prompts = 0;
  const adapter = createPiHostAdapter({ session: { subscribe() { subscriptions++; return () => {}; }, prompt() { prompts++; } } });
  assert.equal(subscriptions, 1);
  assert.equal(prompts, 0);
  assert.deepEqual(adapter.capabilities, ['prompt', 'get_state']);
  const result = await adapter.request({ id: 'x', type: 'bash', command: 'must-not-run' });
  assert.equal(result.success, false);
  assert.equal(result.command, 'bash');
  adapter.destroy();
});

test('full SDK fixture advertises exactly all 33 RPC plus 18 implemented native capabilities', () => {
  const f = fixture();
  assert.equal(PI_RPC_COMMANDS.length, 33);
  assert.equal(PI_HOST_COMMANDS.length, 18);
  assert.deepEqual(f.adapter.capabilities, [...PI_RPC_COMMANDS, ...PI_HOST_COMMANDS]);
  assert.equal(f.calls.length, 0, 'no setters, prompt, shell, runtime rebind or resource reload on attach');
  f.adapter.destroy();
});

test('prompt returns its accepted disposition before run completion; abort stays concurrent', async () => {
  const f = fixture(); const run = deferred();
  f.initial.prompt = (message, options) => {
    f.calls.push({ name: 'pendingPrompt', args: [message, options] });
    options.preflightResult('started');
    return run.promise;
  };
  const response = await f.request('prompt', { message: 'Do work', images: [{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }] });
  assert.deepEqual(response.data, { disposition: 'started' });
  assert.equal(f.calls[0].args[1].source, 'rpc');
  assert.equal((await f.request('abort')).success, true);
  assert.equal(f.calls.some(item => item.name === 'clearQueue'), false, 'abort preserves official queue semantics');
  run.resolve();
  f.adapter.destroy();
});

test('prompt rejects missing streaming policy and reports errors after acceptance as events', async () => {
  const f = fixture(); const events = []; f.adapter.subscribe(event => events.push(event));
  f.initial.isStreaming = true;
  assert.equal((await f.request('prompt', { message: 'Ambiguous' })).success, false);
  assert.equal((await f.request('prompt', { message: 'Queue', streamingBehavior: 'followUp' })).data.disposition, 'queued');
  f.initial.prompt = (_text, opts) => { opts.preflightResult('handled'); return Promise.reject(new Error('post-accept problem')); };
  assert.equal((await f.request('prompt', { message: '/inspect' })).data.disposition, 'handled');
  await Promise.resolve();
  assert.equal(events.find(event => event.type === 'host_error').error, 'post-accept problem');
  f.adapter.destroy();
});

test('queue methods preserve images, modes and recoverable draft text', async () => {
  const f = fixture();
  assert.equal((await f.request('steer', { message: 'Change direction' })).data.disposition, 'queued');
  assert.equal((await f.request('follow_up', { message: 'Then summarize' })).data.disposition, 'handled');
  assert.deepEqual((await f.request('clear_queue')).data, { steering: ['steering draft'], followUp: ['follow-up draft'] });
  assert.equal((await f.request('set_steering_mode', { mode: 'all' })).success, true);
  assert.equal((await f.request('set_follow_up_mode', { mode: 'one-at-a-time' })).success, true);
  assert.equal((await f.request('set_follow_up_mode', { mode: 'sometimes' })).success, false);
  assert.deepEqual(f.calls.find(item => item.name === 'steer').args, ['Change direction', undefined, { source: 'rpc' }]);
  f.adapter.destroy();
});

test('model catalogue is secret-safe but native setModel receives the original model', async () => {
  const f = fixture();
  const catalogue = await f.request('get_available_models');
  const serialized = JSON.stringify(catalogue);
  assert.doesNotMatch(serialized, /secret-key|secret-header|password|api_key/);
  assert.equal(catalogue.data.models[0].baseUrl, 'https://example.test/v1');
  assert.equal((await f.request('set_model', { provider: 'local', modelId: 'beta' })).success, true);
  assert.equal(f.calls.find(item => item.name === 'setModel').args[0], f.model2);
  assert.equal((await f.request('set_model', { provider: 'missing', modelId: 'beta' })).success, false);
  assert.equal((await f.request('set_thinking_level', { level: 'max' })).success, false);
  assert.equal((await f.request('set_thinking_level', { level: 'high' })).success, true);
  assert.deepEqual((await f.request('get_available_thinking_levels')).data.levels, ['off', 'low', 'medium', 'high']);
  assert.deepEqual((await f.request('cycle_thinking_level')).data, { level: 'high' });
  assert.equal((await f.request('cycle_model')).data.model.id, 'beta');
  f.adapter.destroy();
});

test('session history has durable cursor semantics and never returns thinking content', async () => {
  const f = fixture();
  const all = await f.request('get_entries');
  assert.equal(all.data.entries.length, 2);
  assert.equal(all.data.leafId, 'a1');
  assert.equal((await f.request('get_entries', { since: 'u1' })).data.entries.length, 1);
  assert.equal((await f.request('get_entries', { since: 'missing' })).success, false);
  const messages = (await f.request('get_messages')).data.messages;
  assert.equal(messages[0].content, 'https://example.test/search?q=keep-this', 'user text is not URL-normalized');
  assert.equal(messages[1].content[0].thinking, '');
  assert.equal(f.initial.messages[1].content[0].thinking, 'private-thought', 'projection never changes backend context');
  assert.doesNotMatch(JSON.stringify((await f.request('get_tree')).data), /private-thought/);
  f.adapter.destroy();
});

test('own replacement requests rebind without overwriting an existing runtime hook', async () => {
  const f = fixture(); const events = []; f.adapter.subscribe(event => events.push(event));
  const oldCallback = f.initial.remembered[0];
  assert.equal((await f.request('new_session', { parentSession: '/parent.jsonl' })).data.cancelled, false);
  f.runtime.session.emit({ type: 'agent_start' });
  oldCallback({ type: 'message_end', message: { role: 'assistant', content: 'stale' } });
  assert.equal(events.filter(event => event.type === 'agent_start').length, 1);
  assert.equal(events.some(event => event.message?.content === 'stale'), false);
  assert.equal(f.calls.some(item => item.name === 'setRebindSession'), false);
  assert.equal(f.calls.some(item => item.name === 'originalHook'), true);
  assert.equal(events.find(event => event.type === 'host_session_changed').sessionId, 'session-1');
  assert.equal((await f.request('switch_session', { sessionPath: '/other.jsonl' })).success, true);
  assert.equal((await f.request('fork', { entryId: 'u1' })).data.text, 'Fork text');
  assert.equal((await f.request('clone')).success, true);
  assert.deepEqual(f.calls.filter(item => item.name === 'fork').at(-1).args, ['a1', { position: 'at' }]);
  assert.equal((await f.request('import_session', { inputPath: '/import.jsonl', cwdOverride: '/new' })).success, true);
  f.adapter.destroy();
});

test('explicit hook ownership and external subscriptions support outside replacements', async () => {
  const f = fixture(); f.adapter.destroy();
  let rebinds = 0; const events = [];
  const adapter = createPiHostAdapter({ runtime: f.runtime, ownsRuntimeRebind: true, onRebind: () => { rebinds++; } });
  adapter.subscribe(event => events.push(event));
  await f.runtime.replace();
  f.runtime.session.emit({ type: 'agent_start' });
  assert.equal(rebinds, 1);
  assert.equal(events.at(-1).type, 'agent_start');
  adapter.destroy();
  assert.equal(f.runtime.hook, undefined);
  let subscriber; let cleaned = false;
  const adapter2 = createPiHostAdapter({ runtime: f.runtime, subscribeSessionChanges(callback) { subscriber = callback; return () => { cleaned = true; }; } });
  const newEvents = []; adapter2.subscribe(event => newEvents.push(event));
  f.runtime.session = f.makeSession('external'); subscriber();
  f.runtime.session.emit({ type: 'agent_start' });
  assert.equal(newEvents.at(-1).type, 'agent_start');
  adapter2.destroy(); assert.equal(cleaned, true);
});

test('session list, exports, labels and navigation call verified public methods', async () => {
  const f = fixture();
  assert.equal((await f.request('list_sessions')).data.sessions[0].created, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(f.calls.find(item => item.name === 'list').args, ['/project', undefined]);
  assert.equal((await f.request('list_sessions', { all: true, sessionDir: '/sessions' })).success, true);
  assert.deepEqual(f.calls.find(item => item.name === 'listAll').args, ['/sessions']);
  assert.equal((await f.request('export_html', { outputPath: '/out.html' })).data.path, '/out.html');
  assert.equal((await f.request('export_jsonl')).data.path, '/export.jsonl');
  assert.equal((await f.request('set_session_label', { entryId: 'u1', label: 'Start' })).data.entryId, 'label-1');
  assert.equal((await f.request('set_session_label', { entryId: 'missing' })).success, false);
  assert.equal((await f.request('navigate_tree', { targetId: 'u1', summarize: true, customInstructions: 'Keep conclusions', label: 'Branch' })).data.editorText, 'Old prompt');
  assert.deepEqual(f.calls.find(item => item.name === 'navigateTree').args, ['u1', { summarize: true, customInstructions: 'Keep conclusions', label: 'Branch' }]);
  assert.equal((await f.request('set_session_name', { name: '  Research  ' })).success, true);
  assert.deepEqual(f.calls.find(item => item.name === 'setSessionName').args, ['Research']);
  assert.equal((await f.request('set_session_name', { name: ' ' })).success, false);
  f.adapter.destroy();
});

test('bash preserves extension interception, options and RPC request id', async () => {
  const f = fixture();
  await f.request('bash', { command: 'echo explicit', excludeFromContext: true });
  assert.deepEqual(f.calls.find(item => item.name === 'executeBash').args, ['echo explicit', undefined, { excludeFromContext: true, id: 'test-bash', operations: undefined }]);
  f.calls.length = 0;
  const result = { output: 'Handled', exitCode: 0, cancelled: false, truncated: false };
  f.initial.extensionRunner.emitUserBash = async () => ({ result });
  assert.equal((await f.request('bash', { command: 'intercepted' })).data.output, 'Handled');
  assert.equal(f.calls.some(item => item.name === 'executeBash'), false);
  assert.equal(f.calls.find(item => item.name === 'recordBashResult').args[1], result);
  assert.equal((await f.request('abort_bash')).success, true);
  f.adapter.destroy();
});

test('resources are normalized for UI and command discovery includes only callable sources', async () => {
  const f = fixture();
  const resource = (await f.request('get_resources')).data;
  for (const key of ['skills', 'prompts', 'extensions', 'themes', 'contextFiles', 'diagnostics']) assert.ok(Array.isArray(resource[key]), key);
  assert.equal(resource.skills[0].name, 'research');
  assert.deepEqual(resource.extensions[0].tools, ['custom']);
  assert.equal(resource.contextFiles[0].path, '/AGENTS.md');
  assert.equal(resource.diagnostics.length, 2);
  assert.doesNotMatch(JSON.stringify(resource), /do-not-serialize-runtime/);
  const commands = (await f.request('get_commands')).data.commands;
  assert.deepEqual(commands.map(command => command.name), ['inspect', 'review', 'skill:research']);
  assert.equal(commands.some(command => command.name === 'settings'), false);
  assert.equal((await f.request('reload')).success, true);
  f.adapter.destroy();
});

test('native tool/scoped-model/cache/settings/context controls expose real outcomes', async () => {
  const f = fixture();
  assert.deepEqual((await f.request('get_tools')).data.callableTools, ['read', 'custom']);
  await f.request('set_active_tools', { toolNames: ['read'] });
  assert.deepEqual(f.calls.find(item => item.name === 'setActiveToolsByName').args, [['read']]);
  const scoped = (await f.request('get_scoped_models')).data.models[0];
  assert.equal(scoped.provider, 'local'); assert.equal(scoped.modelId, 'alpha');
  await f.request('set_scoped_models', { models: [{ provider: 'local', modelId: 'beta', thinkingLevel: 'low' }] });
  assert.equal(f.initial.scopedModels[0].model, f.model2);
  assert.equal((await f.request('get_context_usage')).data.contextUsage.tokens, null);
  assert.equal((await f.request('get_session_stats')).data.contextUsage.percent, null);
  assert.equal((await f.request('get_system_prompt')).data.systemPrompt, 'Effective project instructions');
  assert.equal((await f.request('get_cache_warming')).data.status.state, 'inactive');
  await f.request('set_cache_warming', { mode: 'streaming' });
  const config = (await f.request('get_settings')).data;
  assert.equal(config.effective.defaultModel, 'alpha');
  assert.equal(config.effective.apiKey, undefined);
  assert.equal(config.effective.env, undefined);
  assert.equal(config.effective.httpProxy, 'https://proxy.test/');
  for (const type of ['abort_compaction', 'abort_branch_summary', 'abort_retry']) assert.equal((await f.request(type)).success, true);
  for (const type of ['set_auto_compaction', 'set_auto_retry']) assert.equal((await f.request(type, { enabled: false })).success, true);
  assert.equal((await f.request('compact', { customInstructions: 'Keep evidence' })).data.summary, 'Compacted');
  f.adapter.destroy();
});

test('extension UI responses are correlated, validated, and never infer approval', async () => {
  const f = fixture(); const events = []; f.adapter.subscribe(event => events.push(event));
  const pending = f.adapter.uiContext.select('Choose', ['A', 'B']);
  const request = events.at(-1);
  assert.equal(request.method, 'select');
  assert.equal(f.adapter.send({ type: 'extension_ui_response', id: request.id, value: 'not-an-option' }), false);
  assert.equal(f.adapter.send({ type: 'extension_ui_response', id: 'unknown', value: 'A' }), false);
  assert.equal(f.adapter.send({ type: 'extension_ui_response', id: request.id, value: 'B' }), true);
  assert.equal(await pending, 'B');
  assert.equal(f.adapter.send({ type: 'extension_ui_response', id: request.id, value: 'A' }), false);
  const confirmation = f.adapter.uiContext.confirm('Confirm', 'Continue?');
  const confirmRequest = events.at(-1);
  assert.equal(f.adapter.send({ type: 'extension_ui_response', id: confirmRequest.id, value: 'yes' }), false);
  assert.equal(f.adapter.send({ type: 'extension_ui_response', id: confirmRequest.id, confirmed: false }), true);
  assert.equal(await confirmation, false);
  const input = f.adapter.uiContext.input('Name');
  f.adapter.send({ type: 'extension_ui_response', id: events.at(-1).id, value: '' });
  assert.equal(await input, '');
  const editor = f.adapter.uiContext.editor('Edit', 'Existing');
  f.adapter.send({ type: 'extension_ui_response', id: events.at(-1).id, cancelled: true });
  assert.equal(await editor, undefined);
  f.adapter.destroy();
});

test('timeouts, AbortSignal, session replacement and destruction safely dismiss pending dialogs', async () => {
  const f = fixture(); const events = []; f.adapter.subscribe(event => events.push(event));
  assert.equal(await f.adapter.uiContext.confirm('Timeout', 'Proceed?', { timeout: 0 }), false);
  assert.equal(events.at(-1).reason, 'timeout');
  const controller = new AbortController();
  const input = f.adapter.uiContext.input('Waiting', undefined, { signal: controller.signal });
  const oldId = events.at(-1).id;
  controller.abort();
  assert.equal(await input, undefined);
  assert.equal(f.adapter.send({ type: 'extension_ui_response', id: oldId, value: 'late' }), false);
  const confirm = f.adapter.uiContext.confirm('Old session', 'Proceed?');
  await f.request('new_session');
  assert.equal(await confirm, false);
  const editor = f.adapter.uiContext.editor('Unfinished', 'Draft');
  f.adapter.destroy();
  assert.equal(await editor, undefined);
  assert.equal(events.at(-1).reason, 'destroy');
});

test('pending extension dialogs replay to later subscribers; all five notices are one-way', async () => {
  const adapter = createPiHostAdapter();
  const pending = adapter.uiContext.input('Before UI is ready');
  const events = []; adapter.subscribe(event => events.push(event));
  assert.equal(events[0].method, 'input');
  adapter.send({ type: 'extension_ui_response', id: events[0].id, value: 'Ready' });
  assert.equal(await pending, 'Ready');
  adapter.uiContext.notify('Notice');
  adapter.uiContext.setStatus('status', 'Running');
  adapter.uiContext.setStatus('status', undefined);
  adapter.uiContext.setWidget('w', ['line'], { placement: 'belowEditor' });
  adapter.uiContext.setTitle('Title');
  adapter.uiContext.setEditorText('Draft');
  assert.deepEqual(events.filter(event => event.type === 'extension_ui_request').slice(-6).map(event => event.method), ['notify', 'setStatus', 'setStatus', 'setWidget', 'setTitle', 'set_editor_text']);
  assert.equal('statusText' in events.filter(event => event.method === 'setStatus').at(-1), false);
  assert.equal(adapter.send({ type: 'extension_ui_response', id: events.at(-1).id, value: 'unexpected' }), false);
  assert.equal(await adapter.uiContext.custom(() => { throw new Error('must not run'); }), undefined);
  assert.equal(adapter.extensionBindings.mode, 'rpc');
  adapter.destroy();
});

test('raw streaming thoughts and credential fields are projected out without mutating events', () => {
  const f = fixture(); const events = []; f.adapter.subscribe(event => events.push(event));
  const event = { type: 'message_update', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'private raw reasoning' }] }, assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'private raw reasoning', partial: { apiKey: 'private-api-key' } } };
  f.initial.emit(event);
  assert.doesNotMatch(JSON.stringify(events), /private raw reasoning|private-api-key/);
  assert.equal(events[0].assistantMessageEvent.type, 'thinking_delta');
  assert.equal(events[0].assistantMessageEvent.characterCount, 21);
  assert.equal(event.assistantMessageEvent.delta, 'private raw reasoning');
  f.adapter.destroy();
});

test('destroy detaches without aborting or disposing host work; unsupported requests fail clearly', async () => {
  const f = fixture(); const events = []; f.adapter.subscribe(event => events.push(event));
  f.adapter.destroy();
  f.initial.emit({ type: 'agent_start' });
  assert.equal(events.length, 0);
  assert.equal(f.calls.some(item => item.name === 'abort'), false);
  assert.equal((await f.request('prompt', { message: 'Too late' })).success, false);
  assert.deepEqual(f.adapter.capabilities, []);
  assert.equal((await createPiHostAdapter().request({ type: 'not-real' })).success, false);
  let touched = false;
  assert.throws(() => createPiHostAdapter({ session: { subscribe() { touched = true; } }, ownsRuntimeRebind: true }), /setRebindSession/);
  assert.equal(touched, false, 'invalid hook ownership is rejected before a subscription is created');
});

test('teardown cannot reenter and leave a new approval pending', async () => {
  const adapter = createPiHostAdapter();
  let reentered;
  adapter.subscribe(event => {
    if (event.type === 'extension_ui_resolved' && event.reason === 'destroy') {
      reentered = adapter.uiContext.confirm('Too late', 'This must not wait');
      adapter.destroy();
    }
  });
  const original = adapter.uiContext.confirm('Pending', 'Confirm?');
  adapter.destroy();
  assert.equal(await original, false);
  assert.equal(await reentered, false);
});

test('host prompt limits reject excess without truncation and standard Pi never ignores file references', async t => {
  const calls = [];
  const session = { sessionId: 's', subscribe: () => () => {}, async prompt(message, options) { calls.push({ message, options }); options.preflightResult('started'); } };
  const adapter = createPiHostAdapter({ session, maxMessageCharacters: 32 }); t.after(() => adapter.destroy());
  const full = '  ' + 'x'.repeat(28) + '\n\n';
  assert.equal((await adapter.request({ type: 'prompt', message: full })).success, true);
  assert.equal(calls[0].message, full);
  const large = await adapter.request({ type: 'prompt', message: full + 'x' });
  assert.equal(large.success, false); assert.match(large.error, /exceeds/); assert.equal(calls.length, 1);
  const reference = { id: 'f1', projectId: 'p1', name: 'evidence.pdf', mimeType: 'application/pdf', size: 3, versionId: 'v1' };
  assert.equal(adapter.supportsFileReferences, false); assert.equal(adapter.stageFiles, undefined);
  const unsupported = await adapter.request({ type: 'prompt', message: 'Read', fileReferences: [reference] });
  assert.equal(unsupported.success, false); assert.match(unsupported.error, /no file-reference resolver/); assert.equal(calls.length, 1);
});

test('optional real file service must confirm every reference and resolves context before SDK submission', async t => {
  const calls = [], staged = [], resolved = [];
  const reference = { id: 'f1', projectId: 'p1', name: 'evidence.pdf', mimeType: 'application/pdf', size: 3, versionId: 'v1' };
  let resolveResult = { resolvedIds: ['f1'], contextText: 'Read stored file /project/files/f1 with the read tool.' };
  const session = { sessionId: 's', subscribe: () => () => {}, async prompt(message, options) { calls.push({ message, options }); options.preflightResult('started'); } };
  const fileService = { async stageFiles(files, context) { staged.push({ files, context }); return { fileReferences: [reference] }; }, async resolveReferences(references, context) { resolved.push({ references, context }); return resolveResult; } };
  const adapter = createPiHostAdapter({ session, fileService }); t.after(() => adapter.destroy());
  const files = [{ name: 'evidence.pdf', size: 3 }];
  assert.deepEqual(await adapter.stageFiles(files, { projectId: 'p1' }), { fileReferences: [reference] });
  assert.equal(staged[0].files, files); assert.equal(staged[0].context.sessionId, 's');
  const accepted = await adapter.request({ type: 'prompt', message: '  Examine all pages.\n', fileReferences: [reference] });
  assert.equal(accepted.success, true);
  assert.equal(calls[0].message, '  Examine all pages.\n\n\n' + resolveResult.contextText);
  assert.deepEqual(resolved[0].references, [reference]); assert.equal(resolved[0].context.sessionId, 's');
  resolveResult = { resolvedIds: [], contextText: 'Partial' };
  assert.equal((await adapter.request({ type: 'prompt', message: 'Read', fileReferences: [reference] })).success, false);
  resolveResult = { resolvedIds: ['f1'], contextText: '' };
  assert.equal((await adapter.request({ type: 'prompt', message: 'Read', fileReferences: [reference] })).success, false);
  resolveResult = { resolvedIds: ['f1'], contextText: 'x'.repeat(262144) };
  assert.equal((await adapter.request({ type: 'prompt', message: 'Read', fileReferences: [reference] })).success, false);
  assert.equal(calls.length, 1, 'No partial, empty or over-limit attachment content reaches Pi.');
  await assert.rejects(adapter.stageFiles(files, { projectId: 'another-project' }), /every attachment in this project/);
});

test('session replacement while resolving files cannot submit to the old or new session', async t => {
  const pending = deferred(); const calls = [];
  const makeSession = id => ({ sessionId: id, subscribe: () => () => {}, async prompt(...args) { calls.push(args); } });
  const runtime = { session: makeSession('first') };
  const fileService = { resolveReferences: () => pending.promise };
  const adapter = createPiHostAdapter({ runtime, fileService }); t.after(() => adapter.destroy());
  const request = adapter.request({ type: 'prompt', message: 'Read', fileReferences: [{ id: 'f1', projectId: null, name: 'x.txt', mimeType: 'text/plain', size: 1 }] });
  runtime.session = makeSession('second'); adapter.refreshSession();
  pending.resolve({ resolvedIds: ['f1'], contextText: 'File content' });
  const result = await request;
  assert.equal(result.success, false); assert.match(result.error, /session changed/i); assert.equal(calls.length, 0);
});
