#!/usr/bin/env node
'use strict';

/**
 * M3 model-profile behavior checks for provider-profiles.js and the chat picker.
 * Run: node qa/model-profiles-test.cjs
 *
 * Deterministic Node + LinkeDOM module tests, NOT a browser or host run.
 * The adapter is an in-memory script: no credential store, network sign-in,
 * real catalog, or inference probe is exercised. Key values are asserted to
 * leave the page and appear only as adapter arguments. OAuth follows the host
 * contract: start returns {id, status:'pending'} with no URL, polling delivers
 * authorizeUrl as a user-activated link, and terminal values are exactly
 * succeeded | failed | cancelled. ChatGPT-account catalogs add source
 * 'chatgpt_account' with an opaque accountRef echoed to the host on save and
 * never rendered; account-list failures show an explicit error with no
 * fallback, and the legacy openai-codex route stays disabled with the host
 * reason.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { parseHTML } = require(require.resolve('linkedom', { paths: [__dirname] }));

const base = path.resolve(__dirname, '..') + path.sep;
const sources = {
  'ui/provider-profiles.js': fs.readFileSync(base + 'ui/provider-profiles.js', 'utf8'),
  'ui/chat-model-picker.js': fs.readFileSync(base + 'ui/chat-model-picker.js', 'utf8')
};
/* Objects created inside the VM realm must compare equal to Node literals. */
const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function createEnvironment() {
  const parsed = parseHTML('<html><body><div id="portal"><div id="panel-slot"></div><div id="picker-slot"></div></div></body></html>');
  const { window, document } = parsed;
  let active = null;
  const timers = [];
  let timerId = 1;
  Object.defineProperty(document, 'activeElement', { configurable: true, get: () => active });
  window.HTMLElement.prototype.focus = function focus() { active = this; };
  window.HTMLElement.prototype.blur = function blur() { if (active === this) active = null; };
  Object.defineProperty(window.HTMLSelectElement.prototype, 'value', {
    configurable: true,
    get() { return [...this.options].find(option => option.hasAttribute('selected'))?.value || this.options[0]?.value || ''; },
    set(value) { for (const option of this.options) option.toggleAttribute('selected', option.value === String(value)); }
  });
  const opened = [];
  window.open = (...args) => { opened.push(args); return null; };
  const context = vm.createContext({
    window, document, console,
    Event: window.Event, CustomEvent: window.CustomEvent,
    AbortController, URL, Date,
    setTimeout(fn, delay) { const id = timerId++; timers.push({ id, fn, delay: Math.max(1, Number(delay) || 0) }); return id; },
    clearTimeout(id) { const at = timers.findIndex(job => job.id === id); if (at >= 0) timers.splice(at, 1); }
  }, { name: 'Athena M3 model-profile behavior — no host, no network' });
  for (const [name, source] of Object.entries(sources)) new vm.Script(source, { filename: name }).runInContext(context);
  const settle = async (turns = 12) => { for (let turn = 0; turn < turns; turn++) await new Promise(resolve => setImmediate(resolve)); };
  return {
    window, document, timers, opened, settle,
    async tick(count = 8) { for (let run = 0; run < count && this.timers.length; run++) { const job = this.timers.shift(); job.fn(); await settle(6); } },
    fire(node, type) { node.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true })); return node; },
    click(node) { this.fire(node, 'click'); },
    type(input, value) { input.value = value; this.fire(input, 'input'); },
    change(select) { this.fire(select, 'change'); }
  };
}

function adapterFixture() {
  const calls = [];
  const state = {
    providers: [
      { id: 'openai', name: 'OpenAI', methods: [{ kind: 'api_key', label: 'API key', enabled: true }], auth: 'unconfigured' },
      { id: 'example-oauth', name: 'Example OAuth', methods: [{ kind: 'oauth', label: 'Example sign-in', enabled: true }], auth: 'unconfigured' },
      { id: 'bedrock', name: 'Amazon Bedrock', methods: [{ kind: 'host', label: 'AWS setup', enabled: true, reason: 'Configure AWS credentials and region on the Athena host.' }], auth: 'not_checked' }
    ],
    catalog: {
      provider: { id: 'openai', name: 'OpenAI', auth: 'unconfigured' },
      models: [
        { provider: 'openai', id: 'gpt-test', name: 'GPT Test', api: 'openai', input: ['text'], contextWindow: 128000, maxTokens: 16384, reasoning: true, thinkingLevels: ['low', 'medium', 'high'], tools: 'unverified', cost: null },
        { provider: 'openai', id: 'gpt-mini', name: 'GPT Mini', api: 'openai', input: ['text'], contextWindow: 32000, maxTokens: 4096, reasoning: false, thinkingLevels: [], tools: 'unverified', cost: null }
      ],
      availableModelIds: [], source: 'sdk_catalog', checkedAt: '2026-11-20T00:00:00.000Z'
    },
    profiles: [
      { id: 'profile-main', name: 'Main research', revision: 2, provider: 'openai', modelId: 'gpt-test', thinkingLevel: 'medium' },
      { id: 'profile-fast', name: 'Fast replies', revision: 1, provider: 'openai', modelId: 'gpt-mini', thinkingLevel: 'low' }
    ],
    appDefaultProfileId: 'profile-main', oauthStatus: 'pending', savedKey: null
  };
  const adapter = {
    listProviders: async query => {
      calls.push(['listProviders', query]);
      return state.providers.filter(provider => (provider.id + ' ' + provider.name).toLowerCase().includes(String(query || '').toLowerCase()));
    },
    getProviderCatalog: async (providerId, options) => {
      calls.push(['getProviderCatalog', providerId, options]);
      if (providerId === 'openai') {
        const provider = state.providers.find(item => item.id === providerId);
        return { ...state.catalog, provider, ...(options?.refresh ? { source: 'refreshed_catalog' } : {}) };
      }
      return { provider: { id: providerId, name: providerId, auth: 'not_checked' }, models: [], availableModelIds: [], source: 'sdk_catalog', checkedAt: '2026-11-20T00:00:00.000Z' };
    },
    saveProviderApiKey: async (providerId, key) => {
      calls.push(['saveProviderApiKey', providerId, 'length:' + key.length]);
      state.savedKey = key;
      state.providers = state.providers.map(provider => provider.id === providerId ? { ...provider, auth: 'configured' } : provider);
      return { saved: true };
    },
    logoutProvider: async providerId => {
      calls.push(['logoutProvider', providerId]);
      state.providers = state.providers.map(provider => provider.id === providerId ? { ...provider, auth: 'unconfigured' } : provider);
      return { removed: true };
    },
    startProviderOAuth: async providerId => { calls.push(['startProviderOAuth', providerId]); return { flowId: 'flow-1', authUrl: 'https://auth.example/authorize?flow=flow-1' }; },
    getProviderOAuth: async flowId => { calls.push(['getProviderOAuth', flowId]); return { status: state.oauthStatus }; },
    cancelProviderOAuth: async flowId => { calls.push(['cancelProviderOAuth', flowId]); state.oauthStatus = 'cancelled'; return { cancelled: true }; },
    listModelProfiles: async () => {
      calls.push(['listModelProfiles']);
      return { profiles: state.profiles, appDefaultProfileId: state.appDefaultProfileId, credentialMode: 'operator_key', hostModel: { provider: 'openai', modelId: 'gpt-test' } };
    },
    saveModelProfile: async input => {
      calls.push(['saveModelProfile', input]);
      if (input.id) state.profiles = state.profiles.map(profile => profile.id === input.id ? { ...profile, ...input, revision: profile.revision + 1 } : profile);
      else state.profiles = [...state.profiles, { ...input, id: 'profile-new', revision: 1 }];
      return { profile: state.profiles.find(profile => profile.id === (input.id || 'profile-new')) };
    },
    deleteModelProfile: async (id, revision) => {
      calls.push(['deleteModelProfile', id, revision]);
      state.profiles = state.profiles.filter(profile => !(profile.id === id && profile.revision === revision));
      if (state.appDefaultProfileId === id) state.appDefaultProfileId = null;
      return { deleted: true };
    },
    setAppModelProfile: async id => { calls.push(['setAppModelProfile', id]); state.appDefaultProfileId = id; return { saved: true }; },
    setProjectModelProfile: async (projectId, id) => { calls.push(['setProjectModelProfile', projectId, id]); return { saved: true }; },
    setConversationModelProfile: async (sessionId, id) => { calls.push(['setConversationModelProfile', sessionId, id]); return { saved: true }; },
    verifyModelProfile: async id => {
      calls.push(['verifyModelProfile', id]);
      const lastCheck = { checkedAt: '2026-11-20T01:00:00.000Z', streaming: 'passed', tools: 'passed' };
      state.profiles = state.profiles.map(profile => profile.id === id ? { ...profile, lastCheck } : profile);
      return state.profiles.find(profile => profile.id === id);
    },
    registerCompatibleEndpoint: async input => {
      calls.push(['registerCompatibleEndpoint', input]);
      const id = 'compatible-' + input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      state.providers = [...state.providers, { id, name: input.name, methods: [{ kind: 'api_key', label: 'API key', enabled: true }], auth: 'unconfigured' }];
      return { registered: true };
    }
  };
  return { adapter, state, calls };
}

/* An adapter whose responses stay pending until the test resolves them,
 * reproducing overlapping network ordering inside one page. */
function manualAdapter() {
  const state = {
    providers: [
      { id: 'openai', name: 'OpenAI', methods: [{ kind: 'api_key', label: 'API key', enabled: true }], auth: 'unconfigured' },
      { id: 'example-oauth', name: 'Example OAuth', methods: [{ kind: 'oauth', label: 'Example sign-in', enabled: true }], auth: 'unconfigured' }
    ],
    profiles: [{ id: 'profile-main', name: 'Main research', revision: 2, provider: 'openai', modelId: 'gpt-test', thinkingLevel: 'medium' }]
  };
  const pending = { list: [], providers: [], catalog: [], register: [] };
  const adapter = {
    listProviders: query => new Promise(resolve => pending.providers.push({ query, resolve })),
    getProviderCatalog: (providerId, options) => new Promise(resolve => pending.catalog.push({ providerId, options, resolve })),
    listModelProfiles: () => new Promise(resolve => pending.list.push({ resolve })),
    registerCompatibleEndpoint: input => new Promise(resolve => pending.register.push({ input, resolve })),
    saveProviderApiKey: async () => ({}),
    logoutProvider: async () => ({}),
    startProviderOAuth: async () => ({ id: 'flow-manual', status: 'pending' }),
    getProviderOAuth: async () => ({ id: 'flow-manual', status: 'pending' }),
    cancelProviderOAuth: async () => ({ cancelled: true }),
    saveModelProfile: async input => input,
    deleteModelProfile: async () => ({}),
    setAppModelProfile: async () => ({}),
    setProjectModelProfile: async () => ({}),
    setConversationModelProfile: async () => ({}),
    verifyModelProfile: async () => ({})
  };
  const take = (queue, result) => { const job = queue.shift(); job.resolve(result); };
  return { adapter, state, pending, take };
}

function mountPanel(env, options = {}) {
  const workspaceState = { projectId: 'project-1', sessionId: 'session-1', projects: [{ id: 'project-1', name: 'Research', defaultProfileId: null }], sessions: [{ id: 'session-1', projectId: 'project-1', profileId: null }] };
  const panel = env.window.AthenaProviderProfiles.mount(env.document.getElementById('panel-slot'), {
    icons: () => {}, toast: message => { (options.toasts ||= []).push(message); },
    getWorkspace: () => workspaceState
  });
  return { panel, workspaceState };
}

test('The profiles panel stays hidden until a model-profiles host attaches', async () => {
  const env = createEnvironment();
  const { panel } = mountPanel(env);
  assert.equal(env.document.querySelector('.amp-root').hidden, true);
  const { adapter } = adapterFixture();
  panel.setModelProfiles(adapter);
  await env.settle();
  assert.equal(env.document.querySelector('.amp-root').hidden, false);
  assert.equal(env.document.querySelectorAll('.amp-provider').length, 3);
  assert.equal(env.document.querySelector('[data-amp-credential-mode]').textContent, 'Host vault · operator key');
  panel.destroy();
});

test('Provider search re-queries the host and renders SDK auth states', async () => {
  const env = createEnvironment();
  const { adapter, calls } = adapterFixture();
  const { panel } = mountPanel(env);
  panel.setModelProfiles(adapter);
  await env.settle();
  const search = env.document.querySelector('[data-amp-provider-search]');
  env.type(search, 'bedrock');
  await env.tick();
  assert.deepEqual(plain(calls.filter(call => call[0] === 'listProviders').at(-1)), ['listProviders', 'bedrock']);
  assert.equal(env.document.querySelectorAll('.amp-provider').length, 1);
  assert.ok(env.document.body.textContent.includes('Configure AWS credentials and region on the Athena host.'));
  assert.ok(env.document.body.textContent.includes('Credential status not checked'));
  assert.equal(env.document.querySelectorAll('[data-amp-save-key="bedrock"]').length, 0, 'Host-setup providers expose no key field.');
  panel.destroy();
});

test('API key save reaches only the host, never echoes, and the note survives re-renders', async () => {
  const env = createEnvironment();
  const { adapter, state } = adapterFixture();
  const { panel } = mountPanel(env);
  panel.setModelProfiles(adapter);
  await env.settle();
  const keyInput = () => env.document.querySelector('[data-amp-key-input="openai"]');
  env.click(env.document.querySelector('[data-amp-save-key="openai"]'));
  await env.settle();
  assert.ok(env.document.body.textContent.includes('Enter a nonempty API key without whitespace.'));
  env.type(keyInput(), '  ');
  env.click(env.document.querySelector('[data-amp-save-key="openai"]'));
  await env.settle();
  assert.equal(state.savedKey, null, 'Whitespace-only keys never reach the host.');
  env.type(keyInput(), 'test-fixture-openai-key');
  env.click(env.document.querySelector('[data-amp-save-key="openai"]'));
  await env.settle();
  assert.equal(state.savedKey, 'test-fixture-openai-key');
  assert.equal(keyInput().value || '', '', 'The key is cleared from the page after saving.');
  assert.ok(!env.document.body.textContent.includes('test-fixture-openai-key'), 'The key value never appears in the DOM.');
  assert.ok(env.document.body.textContent.includes('API key stored by the host in the operator key vault.'));
  assert.ok(env.document.body.textContent.includes('Configured'));
  env.click(env.document.querySelector('[data-amp-remove-key="openai"]'));
  await env.settle();
  assert.ok(env.document.body.textContent.includes('Not configured'));
  assert.ok(env.document.body.textContent.includes('Credentials removed by the host.'), 'Provider notes persist across list re-renders.');
  panel.destroy();
});

test('Sign-in starts as {id, status:"pending"} with no URL and surfaces the polled authorizeUrl as a user link', async () => {
  const env = createEnvironment();
  const { adapter, state, calls } = adapterFixture();
  adapter.startProviderOAuth = async providerId => { calls.push(['startProviderOAuth', providerId]); return { id: 'flow-9', status: 'pending' }; };
  let polls = 0;
  adapter.getProviderOAuth = async flowId => {
    calls.push(['getProviderOAuth', flowId]);
    polls++;
    if (polls === 1) return { id: 'flow-9', status: 'pending' };
    if (polls === 2) return { id: 'flow-9', status: 'pending', authorizeUrl: 'https://auth.example/authorize?flow=9' };
    return { id: 'flow-9', status: state.oauthStatus };
  };
  const { panel } = mountPanel(env);
  panel.setModelProfiles(adapter);
  await env.settle();
  env.click(env.document.querySelector('[data-amp-oauth="example-oauth"]'));
  await env.settle();
  assert.deepEqual(plain(calls.find(call => call[0] === 'startProviderOAuth')), ['startProviderOAuth', 'example-oauth']);
  assert.deepEqual(plain(calls.find(call => call[0] === 'getProviderOAuth')), ['getProviderOAuth', 'flow-9']);
  assert.equal(env.document.querySelector('.amp-oauth-url'), null, 'No link exists before the host delivers the authorizeUrl.');
  assert.ok(env.document.body.textContent.includes('Waiting for the provider sign-in to finish'));
  await env.tick();
  const link = env.document.querySelector('.amp-oauth-url a');
  assert.ok(link, 'The polled authorizeUrl renders as a user-activated link.');
  assert.equal(link.getAttribute('href'), 'https://auth.example/authorize?flow=9');
  assert.equal(link.getAttribute('target'), '_blank');
  assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(env.opened.length, 0, 'Polling never calls window.open; the user activates the link.');
  state.oauthStatus = 'succeeded';
  await env.tick();
  assert.ok(env.document.body.textContent.includes('Signed in with the provider.'), 'succeeded is the exact terminal value.');
  assert.equal(env.document.querySelector('[data-amp-oauth-cancel="example-oauth"]'), null);
  assert.equal(env.document.querySelector('.amp-oauth-url'), null, 'The link disappears once sign-in completes.');
  panel.destroy();
});

test('A start-returned authorizeUrl opens from the click gesture', async () => {
  const env = createEnvironment();
  const { adapter } = adapterFixture();
  const { panel } = mountPanel(env);
  panel.setModelProfiles(adapter);
  await env.settle();
  env.click(env.document.querySelector('[data-amp-oauth="example-oauth"]'));
  await env.settle();
  assert.deepEqual(env.opened.at(-1), ['https://auth.example/authorize?flow=flow-1', '_blank', 'noopener,noreferrer']);
  const link = env.document.querySelector('.amp-oauth-url a');
  assert.equal(link.getAttribute('href'), 'https://auth.example/authorize?flow=flow-1');
  panel.destroy();
});

test('Desktop polling offers the native browser action without exposing a sign-in URL', async () => {
  const env = createEnvironment();
  const { adapter, calls } = adapterFixture();
  adapter.startProviderOAuth = async () => ({ id: 'native-1', status: 'pending' });
  adapter.getProviderOAuth = async () => ({ id: 'native-1', status: 'pending', browserReady: true });
  adapter.openProviderOAuthBrowser = async flowId => { calls.push(['openProviderOAuthBrowser', flowId]); return { opened: true }; };
  const { panel } = mountPanel(env);
  panel.setModelProfiles(adapter);
  await env.settle();
  env.click(env.document.querySelector('[data-amp-oauth="example-oauth"]'));
  await env.settle();
  assert.equal(env.document.querySelector('.amp-oauth-url a'), null);
  assert.equal(env.opened.length, 0);
  env.click(env.document.querySelector('[data-amp-oauth-browser]'));
  await env.settle();
  assert.deepEqual(calls.filter(call => call[0] === 'openProviderOAuthBrowser'), [['openProviderOAuthBrowser', 'native-1']]);
  panel.destroy();
});

test('failed and cancelled poll statuses end the sign-in with the host message', async () => {
  const env = createEnvironment();
  const { adapter, calls } = adapterFixture();
  adapter.startProviderOAuth = async () => ({ id: 'flow-x', status: 'pending' });
  adapter.getProviderOAuth = async id => {
    calls.push(['getProviderOAuth', id]);
    return { id, status: 'failed', error: 'credential_save_failed' };
  };
  const { panel } = mountPanel(env);
  panel.setModelProfiles(adapter);
  await env.settle();
  env.click(env.document.querySelector('[data-amp-oauth="example-oauth"]'));
  await env.settle();
  assert.ok(env.document.body.textContent.includes('Sign-in was verified but the host could not save the credential.'));
  assert.equal(env.document.querySelector('[data-amp-oauth-cancel="example-oauth"]'), null, 'A failed sign-in hides the cancel control.');
  assert.equal(calls.filter(call => call[0] === 'getProviderOAuth').length, 1, 'Terminal statuses stop polling.');
  panel.destroy();
});

test('Cancelling a sign-in stops polling on the host flow id', async () => {
  const env = createEnvironment();
  const { adapter, calls } = adapterFixture();
  adapter.startProviderOAuth = async () => ({ id: 'flow-9', status: 'pending' });
  adapter.getProviderOAuth = async () => ({ id: 'flow-9', status: 'pending', authorizeUrl: 'https://auth.example/authorize?flow=9' });
  const { panel } = mountPanel(env);
  panel.setModelProfiles(adapter);
  await env.settle();
  env.click(env.document.querySelector('[data-amp-oauth="example-oauth"]'));
  await env.settle();
  await env.tick();
  env.click(env.document.querySelector('[data-amp-oauth-cancel="example-oauth"]'));
  await env.settle();
  assert.deepEqual(plain(calls.find(call => call[0] === 'cancelProviderOAuth')), ['cancelProviderOAuth', 'flow-9']);
  const polls = calls.filter(call => call[0] === 'getProviderOAuth').length;
  await env.tick(20);
  assert.equal(calls.filter(call => call[0] === 'getProviderOAuth').length, polls, 'No further polls run after cancellation.');
  panel.destroy();
});

test('Catalog labels separate SDK listing, eligibility, and refresh state', async () => {
  const env = createEnvironment();
  const { adapter, state, calls } = adapterFixture();
  const { panel } = mountPanel(env);
  panel.setModelProfiles(adapter);
  await env.settle();
  assert.ok(env.document.querySelector('[data-amp-catalog-meta]').textContent.includes('SDK catalog for OpenAI'));
  assert.ok(env.document.body.textContent.includes('Eligibility unknown · configure credentials first'), 'Unconfigured credentials leave eligibility unknown.');
  state.providers = state.providers.map(provider => provider.id === 'openai' ? { ...provider, auth: 'configured' } : provider);
  state.catalog = { ...state.catalog, provider: { ...state.catalog.provider, auth: 'configured' }, availableModelIds: ['gpt-test'] };
  env.click(env.document.querySelector('[data-amp-catalog-refresh]'));
  await env.settle();
  assert.deepEqual(plain(calls.filter(call => call[0] === 'getProviderCatalog').at(-1)), ['getProviderCatalog', 'openai', { query: '', refresh: true }]);
  assert.ok(env.document.querySelector('[data-amp-catalog-meta]').textContent.includes('Refreshed catalog for OpenAI'));
  const models = [...env.document.querySelectorAll('.amp-model')];
  assert.ok(models.find(model => model.textContent.includes('GPT Test')).textContent.includes('Pi reports available · inference unverified'));
  assert.ok(models.find(model => model.textContent.includes('GPT Mini')).textContent.includes('SDK catalog only · not returned as available'));
  panel.destroy();
});

test('Profiles carry app, project, and conversation defaults plus the probe badge', async () => {
  const env = createEnvironment();
  const { adapter, calls } = adapterFixture();
  const { panel, workspaceState } = mountPanel(env);
  panel.setModelProfiles(adapter);
  await env.settle();
  const rows = [...env.document.querySelectorAll('.amp-profile')];
  assert.equal(rows.length, 2);
  assert.ok(rows.find(row => row.dataset.ampProfile === 'profile-main').textContent.includes('App default'));
  const find = (action, id) => env.document.querySelector('[data-amp-action="' + action + '"][data-amp-profile-id="' + id + '"]');
  env.click(find('app-default', 'profile-fast'));
  await env.settle();
  assert.deepEqual(plain(calls.find(call => call[0] === 'setAppModelProfile')), ['setAppModelProfile', 'profile-fast']);
  env.click(find('project-default', 'profile-fast'));
  await env.settle();
  assert.deepEqual(plain(calls.find(call => call[0] === 'setProjectModelProfile')), ['setProjectModelProfile', 'project-1', 'profile-fast']);
  env.click(find('conversation', 'profile-main'));
  await env.settle();
  assert.deepEqual(plain(calls.find(call => call[0] === 'setConversationModelProfile')), ['setConversationModelProfile', 'session-1', 'profile-main']);
  env.click(find('verify', 'profile-main'));
  await env.settle();
  assert.ok(env.document.querySelector('[data-amp-profile="profile-main"]').textContent.includes('Streaming verified'));
  env.click(find('delete', 'profile-fast'));
  await env.settle();
  assert.deepEqual(plain(calls.find(call => call[0] === 'deleteModelProfile')), ['deleteModelProfile', 'profile-fast', 1]);
  assert.equal(env.document.querySelectorAll('.amp-profile').length, 1);
  workspaceState.sessionId = null;
  panel.destroy();
});

test('Probe states render from the persisted lastCheck and survive list reloads', async () => {
  const env = createEnvironment();
  const { adapter, state } = adapterFixture();
  const { panel } = mountPanel(env);
  panel.setModelProfiles(adapter);
  await env.settle();
  state.profiles = state.profiles.map(profile => profile.id === 'profile-fast'
    ? { ...profile, lastCheck: { checkedAt: '2026-11-20T01:00:00.000Z', streaming: 'passed', tools: 'failed', error: 'unsupported' } }
    : profile);
  env.click(env.document.querySelector('[data-amp-action="app-default"][data-amp-profile-id="profile-fast"]'));
  await env.settle();
  let row = env.document.querySelector('[data-amp-profile="profile-fast"]');
  assert.ok(row.textContent.includes('Checked'));
  assert.ok(row.textContent.includes('Streaming verified'));
  assert.ok(row.textContent.includes('Tools failed'), 'Streaming and tools render as separate probe states.');
  adapter.verifyModelProfile = async id => {
    const profile = state.profiles.find(item => item.id === id);
    const updated = { ...profile, lastCheck: { checkedAt: '2026-11-20T02:00:00.000Z', streaming: 'failed', tools: 'not_checked', error: 'authentication' } };
    state.profiles = state.profiles.map(item => item.id === id ? updated : item);
    return updated;
  };
  env.click(env.document.querySelector('[data-amp-action="verify"][data-amp-profile-id="profile-main"]'));
  await env.settle();
  row = env.document.querySelector('[data-amp-profile="profile-main"]');
  assert.ok(row.textContent.includes('Streaming failed'));
  assert.ok(row.textContent.includes('Tools not checked'));
  assert.equal(row.querySelector('.amp-probe-error').textContent, 'authentication');
  env.click(env.document.querySelector('[data-amp-action="project-default"][data-amp-profile-id="profile-main"]'));
  await env.settle();
  row = env.document.querySelector('[data-amp-profile="profile-main"]');
  assert.ok(row.textContent.includes('Streaming failed'), 'The failed probe survives a host list reload.');
  assert.ok(env.document.querySelector('[data-amp-profile="profile-fast"]').textContent.includes('Streaming verified'), 'The persisted passing probe survives the same reload.');
  panel.destroy();
});

test('Registering compatible endpoints updates the catalog select in the same page', async () => {
  const env = createEnvironment();
  const { adapter, calls } = adapterFixture();
  const { panel } = mountPanel(env);
  panel.setModelProfiles(adapter);
  await env.settle();
  const select = env.document.querySelector('[data-amp-catalog-provider]');
  assert.equal(select.options.length, 3);
  env.type(env.document.querySelector('[data-amp-register="name"]'), 'First gateway');
  env.type(env.document.querySelector('[data-amp-register="endpoint"]'), 'https://one.example/v1');
  env.type(env.document.querySelector('[data-amp-register="apiKey"]'), 'gw-key-1');
  env.click(env.document.querySelector('[data-amp-register-submit]'));
  await env.settle();
  env.type(env.document.querySelector('[data-amp-register="name"]'), 'Second gateway');
  env.type(env.document.querySelector('[data-amp-register="endpoint"]'), 'https://two.example/v1');
  env.click(env.document.querySelector('[data-amp-register-submit]'));
  await env.settle();
  const values = [...select.options].map(option => option.value);
  assert.ok(values.includes('compatible-first-gateway'));
  assert.ok(values.includes('compatible-second-gateway'));
  assert.equal(env.document.querySelector('[data-amp-profile-new]').disabled, false, 'Registration leaves profile actions enabled.');
  const registered = calls.filter(call => call[0] === 'registerCompatibleEndpoint').map(call => call[1]);
  assert.equal(registered[0].apiKey, 'gw-key-1');
  assert.equal(registered[1].apiKey, undefined, 'An endpoint without a key never sends a key field.');
  assert.ok(!env.document.body.textContent.includes('gw-key-1'), 'The registered key never echoes into the page.');
  panel.destroy();
});

test('Overlapping initial responses and registration all apply inside one page', async () => {
  const env = createEnvironment();
  const { adapter, state, pending, take } = manualAdapter();
  const { panel } = mountPanel(env);
  panel.setModelProfiles(adapter);
  await env.settle(2);
  assert.equal(env.document.querySelector('[data-amp-profile-new]').disabled, true, 'Busy while the initial list request is in flight.');
  assert.equal(pending.list.length, 1);
  assert.equal(pending.providers.length, 1);
  /* Providers resolve first; the catalog request they trigger is independent. */
  take(pending.providers, state.providers);
  await env.settle();
  assert.equal(env.document.querySelectorAll('.amp-provider').length, 2);
  assert.equal(pending.catalog.length, 1);
  take(pending.catalog, { provider: { id: 'openai', name: 'OpenAI', auth: 'unconfigured' }, models: [], availableModelIds: [], source: 'sdk_catalog', checkedAt: '2026-11-20T00:00:00.000Z' });
  await env.settle();
  assert.equal(env.document.querySelector('[data-amp-catalog-refresh]').disabled, false, 'The catalog request clears its own busy flag.');
  assert.equal(env.document.querySelector('[data-amp-profile-new]').disabled, true, 'The still-pending list keeps profile actions busy.');
  /* Register two endpoints while the initial list is still pending. */
  for (const [name, endpoint] of [['First gateway', 'https://one.example/v1'], ['Second gateway', 'https://two.example/v1']]) {
    env.type(env.document.querySelector('[data-amp-register="name"]'), name);
    env.type(env.document.querySelector('[data-amp-register="endpoint"]'), endpoint);
    env.click(env.document.querySelector('[data-amp-register-submit]'));
    await env.settle(2);
    take(pending.register, { registered: true });
    await env.settle(2);
    const id = 'compatible-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    state.providers = [...state.providers, { id, name, methods: [{ kind: 'api_key', label: 'API key', enabled: true }], auth: 'unconfigured' }];
    take(pending.providers, state.providers);
    await env.settle(2);
  }
  const select = env.document.querySelector('[data-amp-catalog-provider]');
  const values = [...select.options].map(option => option.value);
  assert.ok(values.includes('compatible-first-gateway'), 'Registration applies while an unrelated request is pending.');
  assert.ok(values.includes('compatible-second-gateway'));
  /* The initial list resolves last and still applies under per-key ownership. */
  take(pending.list, { profiles: state.profiles, appDefaultProfileId: 'profile-main', credentialMode: 'operator_key', hostModel: { provider: 'openai', modelId: 'gpt-test' } });
  await env.settle();
  assert.equal(env.document.querySelector('[data-amp-credential-mode]').textContent, 'Host vault · operator key');
  assert.equal(env.document.querySelector('[data-amp-profile-new]').disabled, false, 'The late list response clears its own busy flag.');
  panel.destroy();
});

test('Editing a profile resends its host revision', async () => {
  const env = createEnvironment();
  const { adapter, calls } = adapterFixture();
  const { panel } = mountPanel(env);
  panel.setModelProfiles(adapter);
  await env.settle();
  env.click(env.document.querySelector('[data-amp-action="edit"][data-amp-profile-id="profile-main"]'));
  await env.settle();
  const form = env.document.querySelector('[data-amp-profile-form]');
  assert.equal(form.hidden, false);
  assert.equal(env.document.querySelector('[data-amp-profile-field="name"]').value, 'Main research');
  assert.equal(env.document.querySelector('[data-amp-profile-field="modelId"]').value, 'gpt-test');
  env.type(env.document.querySelector('[data-amp-profile-field="name"]'), 'Primary research');
  env.click(env.document.querySelector('[data-amp-profile-save]'));
  await env.settle();
  assert.deepEqual(plain(calls.filter(call => call[0] === 'saveModelProfile').at(-1)), ['saveModelProfile', { id: 'profile-main', revision: 2, name: 'Primary research', provider: 'openai', modelId: 'gpt-test', thinkingLevel: 'medium' }]);
  assert.equal(form.hidden, true, 'The form closes after a host-confirmed save.');
  panel.destroy();
});

test('A new profile saves the preselected first row without a change event', async () => {
  const env = createEnvironment();
  const { adapter, calls } = adapterFixture();
  const { panel } = mountPanel(env);
  panel.setModelProfiles(adapter);
  await env.settle();
  env.click(env.document.querySelector('[data-amp-profile-new]'));
  await env.settle();
  const modelSelect = env.document.querySelector('[data-amp-profile-field="modelId"]');
  assert.equal(modelSelect.value, 'gpt-test', 'The sole catalog row is visually selected.');
  env.type(env.document.querySelector('[data-amp-profile-field="name"]'), 'Draft helper');
  env.click(env.document.querySelector('[data-amp-profile-save]'));
  await env.settle();
  assert.deepEqual(plain(calls.filter(call => call[0] === 'saveModelProfile').at(-1)), ['saveModelProfile', { name: 'Draft helper', provider: 'openai', modelId: 'gpt-test', thinkingLevel: 'medium' }], 'Saving uses the preselected row without any change event.');
  assert.equal(env.document.querySelectorAll('.amp-profile').length, 3);
  panel.destroy();
});

test('Compatible endpoint registration validates the URL and stores the key on the host', async () => {
  const env = createEnvironment();
  const { adapter, calls } = adapterFixture();
  const { panel } = mountPanel(env);
  panel.setModelProfiles(adapter);
  await env.settle();
  env.type(env.document.querySelector('[data-amp-register="name"]'), 'Team gateway');
  env.type(env.document.querySelector('[data-amp-register="endpoint"]'), 'not-a-url');
  env.type(env.document.querySelector('[data-amp-register="apiKey"]'), 'gw-key-1');
  env.click(env.document.querySelector('[data-amp-register-submit]'));
  await env.settle();
  assert.equal(calls.filter(call => call[0] === 'registerCompatibleEndpoint').length, 0, 'Invalid URLs never reach the host.');
  assert.ok(env.document.body.textContent.includes('Use a full http:// or https:// URL.'));
  env.type(env.document.querySelector('[data-amp-register="endpoint"]'), 'https://gateway.example/v1');
  env.click(env.document.querySelector('[data-amp-register-submit]'));
  await env.settle();
  assert.deepEqual(plain(calls.find(call => call[0] === 'registerCompatibleEndpoint')), ['registerCompatibleEndpoint', { name: 'Team gateway', endpoint: 'https://gateway.example/v1', apiKey: 'gw-key-1' }]);
  for (const field of ['name', 'endpoint', 'apiKey']) assert.equal(env.document.querySelector('[data-amp-register="' + field + '"]').value, '', 'Credential and endpoint fields are cleared after registering.');
  assert.ok(!env.document.body.textContent.includes('gw-key-1'), 'The registered key never echoes into the page.');
  assert.ok(env.document.body.textContent.includes('Team gateway'));
  panel.destroy();
});

function pickerRuntime(state) {
  const calls = [];
  const subscribers = new Set();
  const runtime = {
    getState: () => state.current,
    subscribe(fn) { subscribers.add(fn); fn(state.current); return () => subscribers.delete(fn); },
    async execute(action, args) {
      calls.push([action, args]);
      if (action === 'set_model' && state.current.models?.length) {
        const [provider, id] = String(args?.modelKey || '').split('\u241f');
        state.current = { ...state.current, model: state.current.models.find(model => model.provider === provider && model.id === id) || null };
      }
      if (action === 'set_thinking_level') state.current = { ...state.current, thinkingLevel: args?.level };
      for (const fn of subscribers) fn(state.current);
      return {};
    }
  };
  return { runtime, calls };
}

test('The chat picker lists host profiles, searches them, and applies a conversation override', async () => {
  const env = createEnvironment();
  const { adapter, calls } = adapterFixture();
  const pi = pickerRuntime({ current: { connected: false, session: { sessionId: 'session-1' }, model: null, models: [], thinkingLevel: null, thinkingLevels: [], capabilities: {}, busy: [] } });
  const picker = env.window.AthenaChatModelPicker.mount(env.document.getElementById('picker-slot'), { runtime: pi.runtime, icons: () => {}, announce: () => {}, isSessionBound: () => true, isUnavailable: () => false, beforeOpen() {}, onOpenSettings() {} });
  picker.setModelProfiles(adapter);
  picker.setProfileContext({ sessionId: 'session-1', profileId: null, projectId: 'project-1' });
  await env.settle();
  assert.equal(env.document.querySelector('#ac-chat-model-menu').hidden, true);
  picker.open('model');
  await env.settle();
  assert.equal(env.document.querySelector('#ac-chat-model-menu').hidden, false);
  let rows = [...env.document.querySelectorAll('[data-acmp-model]')];
  assert.equal(rows.length, 3, 'Inherit default plus both host profiles.');
  assert.ok(rows[0].textContent.includes('Inherit default'));
  env.type(env.document.querySelector('.acmp-search input'), 'fast');
  await env.settle();
  rows = [...env.document.querySelectorAll('[data-acmp-model]')];
  assert.equal(rows.length, 2, 'Search keeps inherit plus the matching profile.');
  assert.ok(rows[1].textContent.includes('Fast replies'));
  env.click(rows[1]);
  await env.settle();
  assert.deepEqual(plain(calls.find(call => call[0] === 'setConversationModelProfile')), ['setConversationModelProfile', 'session-1', 'profile-fast']);
  assert.equal(env.document.querySelector('#aw-model-label').textContent, 'Fast replies');
  assert.equal(env.document.querySelector('#ac-chat-reasoning-label').textContent, 'Reasoning · Low');
  picker.destroy();
});

test('The reasoning menu reads the profile catalog and saves the level with its revision', async () => {
  const env = createEnvironment();
  const { adapter, calls } = adapterFixture();
  const pi = pickerRuntime({ current: { connected: false, session: { sessionId: 'session-1' }, model: null, models: [], thinkingLevel: null, thinkingLevels: [], capabilities: {}, busy: [] } });
  const picker = env.window.AthenaChatModelPicker.mount(env.document.getElementById('picker-slot'), { runtime: pi.runtime, icons: () => {}, announce: () => {}, isSessionBound: () => true, isUnavailable: () => false, beforeOpen() {}, onOpenSettings() {} });
  picker.setModelProfiles(adapter);
  picker.setProfileContext({ sessionId: 'session-1', profileId: 'profile-main', projectId: 'project-1' });
  await env.settle();
  picker.open('reasoning');
  await env.settle();
  assert.deepEqual(plain(calls.find(call => call[0] === 'getProviderCatalog')), ['getProviderCatalog', 'openai', { query: 'gpt-test' }]);
  const rows = [...env.document.querySelectorAll('[data-acmp-level]')];
  assert.deepEqual(rows.map(row => row.dataset.acmpKey), ['low', 'medium', 'high']);
  assert.ok(rows.find(row => row.dataset.acmpKey === 'high').textContent.includes('saved to Main research'));
  env.click(rows.find(row => row.dataset.acmpKey === 'high'));
  await env.settle();
  assert.deepEqual(plain(calls.find(call => call[0] === 'saveModelProfile')), ['saveModelProfile', { id: 'profile-main', revision: 2, name: 'Main research', provider: 'openai', modelId: 'gpt-test', thinkingLevel: 'high' }]);
  picker.destroy();
});

test('Without the M3 adapter the picker keeps the M2 runtime commands', async () => {
  const env = createEnvironment();
  const pi = pickerRuntime({ current: { connected: true, session: { sessionId: 'session-1' }, model: { provider: 'openai', id: 'gpt-test', name: 'GPT Test' }, models: [{ provider: 'openai', id: 'gpt-test', name: 'GPT Test' }, { provider: 'openai', id: 'gpt-mini', name: 'GPT Mini' }], thinkingLevel: 'medium', thinkingLevels: ['low', 'medium', 'high'], capabilities: { set_model: { available: true }, set_thinking_level: { available: true }, get_available_models: { available: true }, get_available_thinking_levels: { available: true } }, busy: [] } });
  const picker = env.window.AthenaChatModelPicker.mount(env.document.getElementById('picker-slot'), { runtime: pi.runtime, icons: () => {}, announce: () => {}, isSessionBound: () => true, isUnavailable: () => false, beforeOpen() {}, onOpenSettings() {} });
  picker.open('model');
  await env.settle();
  const rows = [...env.document.querySelectorAll('[data-acmp-model]')];
  assert.equal(rows.length, 2);
  assert.ok(rows[0].textContent.includes('GPT Test'));
  env.click(rows[1]);
  await env.settle();
  assert.deepEqual(plain(pi.calls.find(call => call[0] === 'set_model')), ['set_model', { modelKey: 'openai\u241fgpt-mini' }]);
  picker.open('reasoning');
  await env.settle();
  env.click([...env.document.querySelectorAll('[data-acmp-level]')].find(row => row.dataset.acmpKey === 'high'));
  await env.settle();
  assert.deepEqual(plain(pi.calls.find(call => call[0] === 'set_thinking_level')), ['set_thinking_level', { level: 'high' }]);
  picker.destroy();
});

/* ChatGPT-account catalog contract: exclusive account models named by
 * display_name, an opaque accountRef echoed on save and never rendered,
 * explicit account-list failures without any static fallback, and the
 * disabled legacy openai-codex route whose reason comes from the host. */
function accountFixture() {
  const calls = [];
  const legacyReason = 'Legacy Codex sign-in is retired; sign in to OpenAI with your ChatGPT account instead.';
  const state = {
    providers: [
      { id: 'openai', name: 'OpenAI', methods: [{ kind: 'oauth', label: 'ChatGPT sign-in', enabled: true }], auth: 'configured' },
      { id: 'openai-codex', name: 'OpenAI Codex', methods: [{ kind: 'oauth', label: 'Codex sign-in', enabled: false, reason: legacyReason }], auth: 'unconfigured' }
    ],
    accountCatalog: {
      provider: { id: 'openai', name: 'OpenAI', auth: 'configured' },
      accountRef: 'qa-acct',
      models: [
        { provider: 'openai', id: 'gpt-5-pro', display_name: 'GPT-5 Pro', input: ['text'], thinkingLevels: ['low', 'medium', 'high'], cost: null },
        { provider: 'openai', id: 'gpt-5-mini', display_name: 'GPT-5 Mini', thinkingLevels: [], cost: null }
      ],
      availableModelIds: ['gpt-5-pro'], source: 'chatgpt_account', checkedAt: '2026-11-20T00:00:00.000Z'
    },
    profiles: [
      { id: 'profile-plan', name: 'Plan writer', revision: 1, provider: 'openai', modelId: 'gpt-5-pro', thinkingLevel: 'medium', authMode: 'chatgpt', authRef: 'qa-acct' }
    ],
    appDefaultProfileId: 'profile-plan'
  };
  const adapter = {
    listProviders: async query => {
      calls.push(['listProviders', query]);
      return state.providers.filter(provider => (provider.id + ' ' + provider.name).toLowerCase().includes(String(query || '').toLowerCase()));
    },
    getProviderCatalog: async (providerId, options) => {
      calls.push(['getProviderCatalog', providerId, options]);
      if (providerId === 'openai') return { ...state.accountCatalog, ...(options?.refresh ? { checkedAt: '2026-11-20T02:00:00.000Z' } : {}) };
      return { provider: { id: providerId, name: providerId, auth: 'not_checked' }, models: [], availableModelIds: [], source: 'sdk_catalog', checkedAt: '2026-11-20T00:00:00.000Z' };
    },
    saveProviderApiKey: async () => ({}),
    logoutProvider: async () => ({}),
    startProviderOAuth: async () => ({ id: 'flow-1', status: 'pending' }),
    getProviderOAuth: async () => ({ id: 'flow-1', status: 'succeeded' }),
    cancelProviderOAuth: async () => ({ cancelled: true }),
    listModelProfiles: async () => {
      calls.push(['listModelProfiles']);
      return { profiles: state.profiles, appDefaultProfileId: state.appDefaultProfileId, credentialMode: 'operator_key', hostModel: { provider: 'openai', modelId: 'gpt-5-pro' } };
    },
    saveModelProfile: async input => {
      calls.push(['saveModelProfile', input]);
      if (input.id) state.profiles = state.profiles.map(profile => profile.id === input.id ? { ...profile, ...input, revision: profile.revision + 1 } : profile);
      else state.profiles = [...state.profiles, { ...input, id: 'profile-new', revision: 1 }];
      return { profile: state.profiles.find(profile => profile.id === (input.id || 'profile-new')) };
    },
    deleteModelProfile: async () => ({ deleted: true }),
    setAppModelProfile: async () => ({ saved: true }),
    setProjectModelProfile: async () => ({ saved: true }),
    setConversationModelProfile: async () => ({ saved: true }),
    verifyModelProfile: async () => ({}),
    registerCompatibleEndpoint: async () => ({ registered: true })
  };
  return { adapter, state, calls };
}

function accountPicker(env, adapter, profileId) {
  const pi = pickerRuntime({ current: { connected: false, session: { sessionId: 'session-1' }, model: null, models: [], thinkingLevel: null, thinkingLevels: [], capabilities: {}, busy: [] } });
  const picker = env.window.AthenaChatModelPicker.mount(env.document.getElementById('picker-slot'), { runtime: pi.runtime, icons: () => {}, announce: () => {}, isSessionBound: () => true, isUnavailable: () => false, beforeOpen() {}, onOpenSettings() {} });
  picker.setModelProfiles(adapter);
  picker.setProfileContext({ sessionId: 'session-1', profileId, projectId: 'project-1' });
  return { picker, pi };
}

test('The account catalog shows plan models by display name with conservative metadata and a fresh save echoes the account ref', async () => {
  const env = createEnvironment();
  const { adapter, calls } = accountFixture();
  const { panel } = mountPanel(env);
  panel.setModelProfiles(adapter);
  await env.settle();
  const meta = env.document.querySelector('[data-amp-catalog-meta]').textContent;
  assert.ok(meta.includes('ChatGPT account catalog for OpenAI'), 'The account source is labeled distinctly from the SDK catalog.');
  assert.ok(meta.includes('ChatGPT plan usage · account models only'));
  const rows = [...env.document.querySelectorAll('.amp-model')];
  assert.equal(rows.length, 2, 'The account catalog is the exclusive model list; no static fallback appears.');
  const pro = rows.find(row => row.textContent.includes('GPT-5 Pro'));
  assert.ok(pro.textContent.includes('gpt-5-pro'), 'The account slug stays visible beside the display name.');
  assert.ok(pro.textContent.includes('Official account model'));
  assert.ok(pro.textContent.includes('On your ChatGPT plan'), 'Account eligibility is a plan listing, not inference verification.');
  assert.ok(!pro.textContent.includes('verified'), 'Account rows never claim inference verification.');
  assert.ok(pro.textContent.includes('ChatGPT plan usage · no per-token rates'), 'A null account price stays unstated.');
  assert.ok(!pro.textContent.includes('context') && !pro.textContent.includes('output limit'), 'Limits the account did not supply are never invented.');
  assert.ok(env.document.querySelector('[data-amp-profile="profile-plan"]').textContent.includes('ChatGPT plan usage'), 'Saved account profiles are distinguished from API-key profiles.');
  env.click(env.document.querySelector('[data-amp-profile-new]'));
  await env.settle();
  const modelSelect = env.document.querySelector('[data-amp-profile-field="modelId"]');
  assert.equal(modelSelect.value, 'gpt-5-pro');
  const option = [...modelSelect.options].find(item => item.value === 'gpt-5-pro');
  assert.ok(option.textContent.includes('GPT-5 Pro · gpt-5-pro'), 'The choice shows the account display name with its slug.');
  assert.ok(env.document.querySelector('[data-amp-profile-auth-mode]').textContent.includes('ChatGPT plan usage'), 'The form indicates plan usage before the API-key alternative.');
  env.type(env.document.querySelector('[data-amp-profile-field="name"]'), 'Plan helper');
  env.click(env.document.querySelector('[data-amp-profile-save]'));
  await env.settle();
  assert.deepEqual(plain(calls.filter(call => call[0] === 'saveModelProfile').at(-1)), ['saveModelProfile', { name: 'Plan helper', provider: 'openai', modelId: 'gpt-5-pro', thinkingLevel: 'medium', authMode: 'chatgpt', accountRef: 'qa-acct' }], 'A fresh save sends the auth mode with the displayed catalog account ref.');
  assert.ok(!env.document.body.textContent.includes('qa-acct'), 'The opaque account reference never renders in the page.');
  panel.destroy();
});

test('An account-list failure shows the explicit error and no fallback models', async () => {
  const env = createEnvironment();
  const { adapter } = accountFixture();
  adapter.getProviderCatalog = async providerId => providerId === 'openai'
    ? { provider: { id: 'openai', name: 'OpenAI', auth: 'configured' }, accountRef: 'qa-acct', models: [], availableModelIds: [], source: 'chatgpt_account', error: 'account_catalog_failed', checkedAt: '2026-11-20T00:00:00.000Z' }
    : { provider: { id: providerId, name: providerId, auth: 'not_checked' }, models: [], availableModelIds: [], source: 'sdk_catalog', checkedAt: '2026-11-20T00:00:00.000Z' };
  const { panel } = mountPanel(env);
  panel.setModelProfiles(adapter);
  await env.settle();
  const errorNode = env.document.querySelector('[data-amp-catalog-error]');
  assert.equal(errorNode.hidden, false, 'The account-list failure is surfaced explicitly.');
  assert.ok(errorNode.textContent.includes('The ChatGPT account model list could not be loaded.'));
  assert.ok(errorNode.textContent.includes('No fallback models are shown'));
  assert.equal(env.document.querySelectorAll('.amp-model').length, 0);
  assert.ok(env.document.body.textContent.includes('No account models are shown while the account list is unavailable.'));
  assert.ok(!env.document.body.textContent.includes('GPT-5 Pro'), 'No static fallback list appears for a failed account catalog.');
  panel.destroy();
});

test('The legacy Codex provider stays disabled with the host reason and no sign-in control', async () => {
  const env = createEnvironment();
  const { adapter } = accountFixture();
  const { panel } = mountPanel(env);
  panel.setModelProfiles(adapter);
  await env.settle();
  const legacy = env.document.querySelector('[data-amp-provider="openai-codex"]');
  assert.ok(legacy, 'The host still lists the legacy provider.');
  assert.equal(legacy.querySelector('[data-amp-oauth="openai-codex"]'), null, 'The legacy route exposes no sign-in button.');
  assert.ok(legacy.textContent.includes('Legacy Codex sign-in is retired; sign in to OpenAI with your ChatGPT account instead.'), 'The disabled reason comes from the host verbatim.');
  assert.ok(legacy.textContent.includes('legacy path · unavailable'), 'The legacy route is labeled distinctly from the account path.');
  panel.destroy();
});

test('A reasoning-only edit keeps the ChatGPT account binding and echoes the stored reference', async () => {
  const env = createEnvironment();
  const { adapter, calls } = accountFixture();
  const { picker } = accountPicker(env, adapter, 'profile-plan');
  await env.settle();
  picker.open('model');
  await env.settle();
  const rows = [...env.document.querySelectorAll('[data-acmp-model]')];
  assert.ok(rows.find(row => row.textContent.includes('gpt-5-pro')).textContent.includes('ChatGPT plan usage'), 'The picker distinguishes plan usage from API-key profiles.');
  picker.open('reasoning');
  await env.settle();
  env.click([...env.document.querySelectorAll('[data-acmp-level]')].find(row => row.dataset.acmpKey === 'high'));
  await env.settle();
  assert.deepEqual(plain(calls.find(call => call[0] === 'saveModelProfile')), ['saveModelProfile', { id: 'profile-plan', revision: 1, name: 'Plan writer', provider: 'openai', modelId: 'gpt-5-pro', thinkingLevel: 'high', authMode: 'chatgpt', accountRef: 'qa-acct' }], 'A reasoning-only edit echoes the stored account reference instead of a fresh catalog one.');
  picker.destroy();
});

test('Re-editing an account profile keeps its model and auth mode while the account list is unavailable', async () => {
  const env = createEnvironment();
  const { adapter, calls } = accountFixture();
  adapter.getProviderCatalog = async providerId => providerId === 'openai'
    ? { provider: { id: 'openai', name: 'OpenAI', auth: 'unconfigured' }, models: [], availableModelIds: [], source: 'chatgpt_account', error: 'account_catalog_failed', checkedAt: '2026-11-20T00:00:00.000Z' }
    : { provider: { id: providerId, name: providerId, auth: 'not_checked' }, models: [], availableModelIds: [], source: 'sdk_catalog', checkedAt: '2026-11-20T00:00:00.000Z' };
  const { panel } = mountPanel(env);
  panel.setModelProfiles(adapter);
  await env.settle();
  env.click(env.document.querySelector('[data-amp-action="edit"][data-amp-profile-id="profile-plan"]'));
  await env.settle();
  const modelSelect = env.document.querySelector('[data-amp-profile-field="modelId"]');
  assert.equal(modelSelect.value, 'gpt-5-pro', 'The saved account model keeps its selector while the list is unavailable.');
  assert.ok([...modelSelect.options].find(option => option.value === 'gpt-5-pro').textContent.includes('saved model'));
  assert.ok(env.document.querySelector('[data-amp-profile-auth-mode]').textContent.includes('ChatGPT plan usage'), 'The form never converts the profile to an API key.');
  env.type(env.document.querySelector('[data-amp-profile-field="name"]'), 'Plan writer renamed');
  env.click(env.document.querySelector('[data-amp-profile-save]'));
  await env.settle();
  assert.deepEqual(plain(calls.filter(call => call[0] === 'saveModelProfile').at(-1)), ['saveModelProfile', { id: 'profile-plan', revision: 1, name: 'Plan writer renamed', provider: 'openai', modelId: 'gpt-5-pro', thinkingLevel: 'medium', authMode: 'chatgpt', accountRef: 'qa-acct' }], 'The stale save preserves the account binding and echoes the stored reference.');
  panel.destroy();
});

test('An account profile never silently converts to an API key when the SDK catalog is shown', async () => {
  const env = createEnvironment();
  const { adapter, calls } = accountFixture();
  adapter.getProviderCatalog = async providerId => providerId === 'openai'
    ? { provider: { id: 'openai', name: 'OpenAI', auth: 'configured' }, models: [{ provider: 'openai', id: 'gpt-test', name: 'GPT Test', thinkingLevels: ['low', 'medium'], cost: null }], availableModelIds: ['gpt-test'], source: 'sdk_catalog', checkedAt: '2026-11-20T00:00:00.000Z' }
    : { provider: { id: providerId, name: providerId, auth: 'not_checked' }, models: [], availableModelIds: [], source: 'sdk_catalog', checkedAt: '2026-11-20T00:00:00.000Z' };
  const { panel } = mountPanel(env);
  panel.setModelProfiles(adapter);
  await env.settle();
  env.click(env.document.querySelector('[data-amp-action="edit"][data-amp-profile-id="profile-plan"]'));
  await env.settle();
  assert.equal(env.document.querySelector('[data-amp-profile-field="modelId"]').value, 'gpt-5-pro', 'The disconnected catalog still keeps the saved account model selected.');
  assert.ok(env.document.querySelector('[data-amp-profile-auth-mode]').textContent.includes('account catalog currently unavailable'));
  env.type(env.document.querySelector('[data-amp-profile-field="name"]'), 'Still on the plan');
  env.click(env.document.querySelector('[data-amp-profile-save]'));
  await env.settle();
  assert.deepEqual(plain(calls.filter(call => call[0] === 'saveModelProfile').at(-1)), ['saveModelProfile', { id: 'profile-plan', revision: 1, name: 'Still on the plan', provider: 'openai', modelId: 'gpt-5-pro', thinkingLevel: 'medium', authMode: 'chatgpt', accountRef: 'qa-acct' }], 'The save keeps the account binding instead of converting to an API key.');
  panel.destroy();
});

test('A freshly switched account is never silently re-bound to an existing OAuth profile', async () => {
  const env = createEnvironment();
  const { adapter, state, calls } = accountFixture();
  adapter.getProviderCatalog = async providerId => providerId === 'openai'
    ? { provider: { id: 'openai', name: 'OpenAI', auth: 'configured' }, accountRef: 'acct-opaque-999', models: state.accountCatalog.models, availableModelIds: ['gpt-5-pro'], source: 'chatgpt_account', checkedAt: '2026-11-20T00:00:00.000Z' }
    : { provider: { id: providerId, name: providerId, auth: 'not_checked' }, models: [], availableModelIds: [], source: 'sdk_catalog', checkedAt: '2026-11-20T00:00:00.000Z' };
  const { panel } = mountPanel(env);
  panel.setModelProfiles(adapter);
  await env.settle();
  env.click(env.document.querySelector('[data-amp-action="edit"][data-amp-profile-id="profile-plan"]'));
  await env.settle();
  env.type(env.document.querySelector('[data-amp-profile-field="name"]'), 'Switched rename');
  env.click(env.document.querySelector('[data-amp-profile-save]'));
  await env.settle();
  const errorNode = env.document.querySelector('[data-amp-profile-form-error]');
  assert.equal(errorNode.hidden, false, 'The switched account surfaces an explicit form error.');
  assert.ok(errorNode.textContent.includes('no longer matches the account catalog'));
  assert.equal(calls.filter(call => call[0] === 'saveModelProfile').length, 0, 'The switched account never reaches the host through an existing OAuth profile.');
  assert.ok(!env.document.body.textContent.includes('acct-opaque-999'), 'Neither account reference renders in the page.');
  panel.destroy();
});
