import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { TaskManager } from '../runtime/manager.ts';
import { ModelProfiles } from '../runtime/model-profiles.ts';
import { openProviderCredentials } from '../runtime/provider-credentials.ts';
import { ProviderError, ProviderManager } from '../runtime/provider-manager.ts';
import { object } from '../runtime/connections.ts';

const base = 'https://api.openai.com/v1';
const slug = 'fixture-account-codex';
const access = 'fixture-access-A-no-public-copy';
const registration = { type: 'oauth', issuer: 'https://auth.openai.com', clientId: 'oaiapp_fixture_A', subject: 'fixture-subject-A',
  idToken: 'fixture-id-token-A', access, refresh: 'fixture-refresh-A', expires: Date.now() + 600_000,
  scopes: ['openid', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'] } as const;
const entry = (id: string, label: string, visibility = 'list') => ({ slug: id, display_name: label, visibility });

test('a disabled deployment and legacy Codex never list or run a saved plan credential', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'athena-chatgpt-disabled-'));
  const store = new InMemoryCredentialStore();
  await store.modify('openai', async () => registration);
  const providers = await ProviderManager.create(store, directory);
  t.after(async () => { await providers.close(); await rm(directory, { recursive: true, force: true }); });
  t.mock.method(globalThis, 'fetch', () => assert.fail('Disabled plan usage made a network request'));
  assert.equal(providers.oauth, undefined);
  assert.equal(providers.providers('openai').find(p => p.id === 'openai')?.methods.find(m => m.kind === 'oauth')?.enabled, false);
  assert.equal(providers.providers('openai-codex')[0]?.methods.find(m => m.kind === 'oauth')?.enabled, false);
  assert.deepEqual((await providers.catalog('openai', { refresh: true })).models, []);
  await assert.rejects(providers.pin({ provider: 'openai', modelId: slug, authMode: 'chatgpt' }), ProviderError);
  await assert.rejects(providers.pin({ provider: 'openai-codex', modelId: slug }), (error: unknown) =>
    error instanceof ProviderError && error.code === 'UNSUPPORTED_AUTH');
});

test('only the current account list can author or run an OAuth profile; there is no static fallback', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'athena-chatgpt-list-'));
  const store = new InMemoryCredentialStore();
  await store.modify('openai', async () => registration);
  const providers = await ProviderManager.create(store, directory, { chatGPTEnabled: true });
  const profiles = new ModelProfiles(directory, (p, id) => providers.model(p, id));
  t.after(async () => { profiles.close(); await providers.close(); await rm(directory, { recursive: true, force: true }); });
  let failed = false;
  let inFlight: { readonly entered: PromiseWithResolvers<void>; readonly resume: PromiseWithResolvers<void> } | undefined;
  let models = [entry(slug, 'Actual account display name'), entry('private-codex', 'Do not display', 'hidden'),
    entry('gpt-4o', 'Name from the subscription service')];
  t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(url, init);
    assert.equal(request.url, base + '/models');
    assert.equal(request.method, 'GET');
    assert.equal(request.redirect, 'error');
    const token = request.headers.get('authorization');
    assert.ok([`Bearer ${access}`, 'Bearer fixture-access-B'].includes(token ?? ''));
    const response = failed ? Response.json({ error: access }, { status: 403 }) : Response.json({ models });
    const paused = inFlight;
    if (paused) { paused.entered.resolve(); await paused.resume.promise; }
    return response;
  });
  const first = await providers.catalog('openai');
  assert.equal(first.source, 'chatgpt_account');
  assert.deepEqual(first.models.map(m => [m.id, m.name]), [[slug, 'Actual account display name'], ['gpt-4o', 'Name from the subscription service']]);
  assert.deepEqual(first.availableModelIds, [slug, 'gpt-4o']);
  assert.deepEqual(first.models.map(m => m.cost), [null, null]);
  assert.equal(first.models[0]?.contextWindow, null);
  assert.ok(first.accountRef);
  assert.doesNotMatch(JSON.stringify(first), /fixture-(?:access|subject|id-token|refresh)|oaiapp_fixture/);
  const input = { name: 'Codex', provider: 'openai', modelId: slug, authMode: 'chatgpt', accountRef: first.accountRef };
  const profile = profiles.save(input, await providers.authorChatGPTProfile(slug, first.accountRef));
  assert.equal(profile.endpoint, base);
  await assert.rejects(providers.pin({ provider: 'openai', modelId: 'gpt-4o' }), /OpenAI API key route/);
  failed = true;
  const error = await providers.catalog('openai', { refresh: true });
  assert.deepEqual([error.source, error.error, error.models, error.availableModelIds], ['chatgpt_account', 'account_catalog_failed', [], []]);
  assert.equal(JSON.stringify(error).includes(access), false);
  failed = false;
  models = [];
  const empty = await providers.catalog('openai');
  assert.deepEqual([empty.provider.auth, empty.error, empty.models], ['configured', undefined, []]);
  models = [entry(slug, 'First account model')];
  const paused = { entered: Promise.withResolvers<void>(), resume: Promise.withResolvers<void>() };
  inFlight = paused;
  const stale = providers.catalog('openai');
  await paused.entered.promise;
  await store.modify('openai', async () => ({ ...registration, clientId: 'oaiapp_fixture_B', subject: 'fixture-subject-B', access: 'fixture-access-B' }));
  inFlight = undefined;
  paused.resume.resolve();
  const rejected = await stale;
  assert.deepEqual([rejected.error, rejected.models], ['account_catalog_failed', []]);
  models = [entry('second-account-only', 'Other account model')];
  const second = await providers.catalog('openai');
  assert.notEqual(second.accountRef, first.accountRef);
  assert.deepEqual(second.availableModelIds, ['second-account-only']);
  await assert.rejects(providers.authorChatGPTProfile(slug, first.accountRef), ProviderError);
  await assert.rejects(providers.pin(profile), ProviderError);
  await providers.logout('openai');
  await providers.saveApiKey('openai', 'fixture-openai-api-key');
  assert.notEqual((await providers.catalog('openai')).source, 'chatgpt_account');
  await assert.rejects(providers.pin(profile), ProviderError);
});

function sse(model: string, output: { readonly text: string } | { readonly function: string; readonly args: object }, terminal = 'completed') {
  const text = 'text' in output;
  const item = text ? { type: 'message', id: 'msg_fixture', role: 'assistant', content: [{ type: 'output_text', text: output.text }] }
    : { type: 'function_call', id: `fc_${output.function}`, call_id: `call_${output.function}`, name: output.function, arguments: JSON.stringify(output.args) };
  const events = [{ type: 'response.output_item.added', output_index: 0, item: text ? { ...item, content: [] } : { ...item, arguments: '' } },
    text ? { type: 'response.output_text.delta', output_index: 0, delta: output.text }
      : { type: 'response.function_call_arguments.delta', output_index: 0, delta: JSON.stringify(output.args) },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: `response.${terminal}`, response: { model, status: terminal, output: [item], ...(terminal === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}) } }];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } });
}

test('selected account slug streams with local tools in real Pi parent and child sessions and survives reopen', { timeout: 15_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'athena-chatgpt-run-'));
  const previous = process.env.ATHENA_CREDENTIAL_KEY;
  process.env.ATHENA_CREDENTIAL_KEY = randomBytes(32).toString('hex');
  t.after(async () => {
    if (previous === undefined) delete process.env.ATHENA_CREDENTIAL_KEY;
    else process.env.ATHENA_CREDENTIAL_KEY = previous;
    await rm(directory, { recursive: true, force: true });
  });
  let { store } = await openProviderCredentials(directory);
  await store.modify('openai', async () => registration);
  let providers = await ProviderManager.create(store, directory, { chatGPTEnabled: true });
  const makeProfiles = () => new ModelProfiles(directory, (p, id) => providers.model(p, id));
  let profiles = makeProfiles();
  const makeManager = () => new TaskManager({ dataDir: directory, models: {
    resolve: (c, p) => profiles.resolve(c, p), pin: ref => providers.pin(ref), requireProfile: id => { profiles.get(id); },
  } });
  let manager = makeManager();
  t.after(async () => { await manager.close(); profiles.close(); await providers.close(); });
  const calls: Array<{ readonly parent: boolean; readonly outputs: readonly string[] }> = [];
  const events: unknown[] = [];
  const outboundErrors: unknown[] = [];
  let terminal = 'completed';
  t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(url, init);
    try {
      assert.equal(request.headers.get('authorization'), `Bearer ${access}`);
      assert.equal(request.redirect, 'error');
      if (request.url === base + '/models') return Response.json({ models: [entry(slug, 'Fixture Codex Display')] });
      assert.equal(request.url, base + '/responses');
      assert.equal(request.method, 'POST');
      const payload: unknown = await request.json();
      assert.ok(object(payload));
      assert.equal(payload.model, slug);
      assert.equal(payload.store, false);
      assert.equal(payload.stream, true);
      for (const key of ['background', 'conversation', 'max_output_tokens', 'metadata', 'previous_response_id', 'temperature', 'top_p', 'tools']) assert.equal(Object.hasOwn(payload, key), false, key);
      assert.ok(Array.isArray(payload.input));
      assert.ok(payload.input.every(item => object(item) && item.role !== 'system'));
      const declarations = payload.input.filter(item => item.type === 'additional_tools').flatMap(item => item.tools);
      assert.ok(declarations.length && declarations.every(tool => tool.type === 'function' && typeof tool.name === 'string'));
      const parent = declarations.some(tool => tool.name === 'spawn_agent');
      const outputs = payload.input.filter(item => item.type === 'function_call_output').map(item => item.call_id);
      calls.push({ parent, outputs });
      if (parent && !outputs.length && terminal === 'completed') return sse(slug, { function: 'spawn_agent', args: { title: 'Child', prompt: 'Report fixture result.' } });
      if (parent && outputs.length === 1) return sse(slug, { function: 'wait_for_agents', args: {} });
      return sse(slug, { text: parent ? 'Parent received fixture report.' : 'Child fixture result.' }, terminal);
    } catch (error) {
      outboundErrors.push(error);
      return Response.json({ error: 'Invalid wire request' }, { status: 400 });
    }
  });
  await manager.initialize();
  const { accountRef } = await providers.catalog('openai');
  assert.ok(accountRef);
  const profile = profiles.save({ name: 'Fixture', provider: 'openai', modelId: slug, authMode: 'chatgpt', accountRef },
    await providers.authorChatGPTProfile(slug, accountRef));
  const { project } = await manager.createProject({ name: 'ChatGPT planning fixture' });
  const conversation = await manager.createSession({ projectId: project.id, title: 'Pinned Codex' });
  manager.setConversationProfile(conversation.sessionId, profile.id);
  const unsubscribePi = manager.subscribeAllPi((_id, event) => events.push(event));
  t.after(unsubscribePi);
  const settled = Promise.withResolvers<void>();
  const unsubscribe = manager.subscribe(snapshot => {
    if (snapshot.run.status === 'succeeded') settled.resolve();
    if (snapshot.run.status === 'failed') settled.reject(new Error(JSON.stringify({ attempts: snapshot.attempts, outboundErrors })));
  });
  await manager.pi(conversation.sessionId, { type: 'prompt', id: 'account-codex-run', message: 'Have a worker report.' });
  await settled.promise;
  unsubscribe();
  assert.deepEqual(outboundErrors, []);
  assert.deepEqual(calls.filter(h => h.parent).map(h => h.outputs), [[], ['call_spawn_agent'], ['call_spawn_agent', 'call_wait_for_agents']]);
  assert.equal(calls.filter(h => !h.parent).length, 1);
  const before = manager.getSnapshot();
  assert.equal(before.attempts.length, 2);
  assert.equal(new Set(before.attempts.map(row => row.agentSessionId)).size, 2);
  for (const row of before.attempts) {
    assert.deepEqual([row.model?.provider, row.model?.modelId, row.model?.profileId, row.model?.configurationRevision, row.model?.endpoint],
      ['openai', slug, profile.id, 1, base]);
  }
  assert.match(JSON.stringify(events), /text_delta/);
  const history = await manager.getAgentHistory(conversation.sessionId, conversation.sessionId);
  assert.match(JSON.stringify(history), /Parent received fixture report/);
  await manager.close(); profiles.close(); await providers.close();
  ({ store } = await openProviderCredentials(directory));
  providers = await ProviderManager.create(store, directory, { chatGPTEnabled: true });
  profiles = makeProfiles(); manager = makeManager(); await manager.initialize();
  assert.deepEqual(await store.read('openai'), registration);
  assert.deepEqual(manager.getSnapshot().attempts, before.attempts);
  assert.deepEqual(await manager.getAgentHistory(conversation.sessionId, conversation.sessionId), history);
  for (const path of await readdir(directory, { recursive: true })) {
    if (!/\.jsonl$|\.sqlite(?:-wal)?$|provider-secrets\.v1$/u.test(path)) continue;
    const bytes = await readFile(join(directory, path));
    for (const value of [access, registration.refresh, registration.idToken]) assert.equal(bytes.includes(value), false, path);
  }
  terminal = 'incomplete';
  const pinned = await providers.pin(profile);
  const reply = await pinned.modelRuntime.completeSimple(pinned.model, { messages: [{ role: 'user', content: 'Reply.', timestamp: Date.now() }],
    tools: [{ name: 'fixture_tool', description: 'Fixture tool', parameters: { type: 'object' } }] });
  assert.equal(reply.stopReason, 'error');
  assert.match(reply.errorMessage ?? '', /response\.completed was not received/);
});
