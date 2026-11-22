import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { ProviderOAuthController, ProviderOAuthError, registerOpenAIOAuth } from '../runtime/provider-oauth.ts';
import { openProviderCredentials } from '../runtime/provider-credentials.ts';
import { ProviderManager } from '../runtime/provider-manager.ts';
import { chatGPTAccountRef } from '../runtime/chatgpt-catalog.ts';
import type { ProviderOAuthFlow } from '../athena-backend-handoff/athena-codex-ui/integrations/model-profiles.d.ts';

const issuer = 'https://auth.openai.com';
const resource = 'https://api.openai.com/v1';
const clientId = 'oaiapp_athena_fixture';
const subject = 'fixture_subject';
const scopes = 'chatgpt.tokens.use.direct email offline_access openid profile resource.invoke';
const signing = generateKeyPairSync('rsa', { modulusLength: 2048 });
const untrustedKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
const kid = 'fixture-key';

function idToken(claims: Readonly<Record<string, unknown>>, key = signing.privateKey): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = `${encode({ alg: 'RS256', kid })}.${encode({ iss: issuer, aud: clientId, sub: subject,
    exp: Math.floor(Date.now() / 1000) + 600, ...claims })}`;
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), key).toString('base64url')}`;
}

type TokenReply = (form: URLSearchParams, signal?: AbortSignal | null) => Response | Promise<Response>;

function providerTransport(reply: TokenReply): typeof fetch {
  return async (url, init) => {
    assert.equal(init?.redirect, 'error');
    switch (String(url)) {
      case `${issuer}/.well-known/jwks.json`:
        return Response.json({ keys: [{ ...signing.publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }] });
      case `${issuer}/api/accounts/oauth/token`:
        assert.ok(init?.body instanceof URLSearchParams);
        assert.equal(init.body.get('resource'), resource);
        assert.equal(init.body.has('client_secret'), false);
        return reply(init.body, init.signal);
      default:
        assert.fail(`Unexpected request to ${String(url)}`);
    }
  };
}

function tokens(grant: Readonly<Record<string, unknown>> = {}): Response {
  return Response.json({ access_token: 'fixture_access', refresh_token: 'fixture_refresh',
    token_type: 'Bearer', expires_in: 3600, scope: scopes, ...grant });
}

async function fixture(t: TestContext, reply: TokenReply) {
  const deviceIdDirectory = await mkdtemp(join(tmpdir(), 'athena-openai-oauth-'));
  const credentials = new InMemoryCredentialStore();
  const makeRuntime = () => ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
  const runtime = await makeRuntime();
  const options = { credentials, deviceIdDirectory, fetch: providerTransport(reply) };
  const original = runtime.getProvider('openai');
  const createController = (target: ModelRuntime) => new ProviderOAuthController({ ...options, runtime: target });
  const controller = createController(runtime);
  t.after(async () => { await controller.close(); await rm(deviceIdDirectory, { recursive: true, force: true }); });
  return { credentials, runtime, original, controller, createController, makeRuntime, options };
}

async function observe<T>(get: () => T | undefined): Promise<T> {
  const deadline = AbortSignal.timeout(3000);
  for (;;) {
    const result = get();
    if (result !== undefined) return result;
    await setImmediate(undefined, { signal: deadline });
  }
}

async function begin(controller: ProviderOAuthController) {
  const flow = controller.start('openai');
  assert.match(flow.id, /^[a-f0-9-]{36}$/u);
  assert.deepEqual(Object.keys(flow).sort(), ['id', 'status']);
  const url = new URL(await observe(() => controller.status(flow.id)?.authorizeUrl));
  assert.equal(url.origin, issuer);
  assert.equal(url.pathname, '/api/accounts/authorize');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.has('id_token_hint'), false);
  const redirect = new URL(url.searchParams.get('redirect_uri') ?? '');
  assert.equal(redirect.protocol, 'http:');
  assert.equal(redirect.hostname, '127.0.0.1');
  assert.equal(redirect.pathname, '/auth/callback');
  const state = url.searchParams.get('state');
  const nonce = url.searchParams.get('nonce');
  assert.ok(state && nonce);
  assert.notEqual(state, nonce);
  const call = (params: Record<string, string> = {}) => {
    const callback = new URL(redirect);
    callback.search = new URLSearchParams({ code: 'fixture_code', state, ...params }).toString();
    return fetch(callback, { signal: AbortSignal.timeout(2000) });
  };
  const result = () => observe(() => {
    const current = controller.status(flow.id);
    if (current?.status !== 'pending') return current;
  });
  return { flow, url, redirect, nonce, call, result };
}

test('Pi stores only a verified OpenAI registration, preserves the catalog, and serializes rotation', async t => {
  let nonce = '';
  let redirect = '';
  let challenge = '';
  let refreshes = 0;
  const f = await fixture(t, form => {
    assert.equal(form.get('client_id'), clientId);
    if (form.get('grant_type') === 'authorization_code') {
      assert.equal(form.get('code'), 'fixture_code');
      assert.equal(form.get('redirect_uri'), redirect);
      const verifier = form.get('code_verifier');
      assert.ok(verifier);
      assert.equal(createHash('sha256').update(verifier).digest('base64url'), challenge);
      return tokens({ id_token: idToken({ nonce }) });
    }
    assert.equal(form.get('grant_type'), 'refresh_token');
    assert.equal(form.get('refresh_token'), 'fixture_refresh');
    assert.equal(form.has('scope'), false);
    refreshes += 1;
    return tokens({ access_token: 'rotated_access', refresh_token: 'rotated_refresh' });
  });
  const provider = f.runtime.getProvider('openai');
  assert.ok(provider && f.original);
  assert.deepEqual(provider.getModels(), f.original.getModels());
  assert.equal(provider.auth.apiKey, f.original.auth.apiKey);
  assert.equal(provider.streamSimple, f.original.streamSimple);
  await f.credentials.modify('anthropic', async () => ({ type: 'api_key', key: 'other-provider-fixture' }));
  const login = await begin(f.controller);
  nonce = login.nonce;
  redirect = login.redirect.href;
  challenge = login.url.searchParams.get('code_challenge') ?? '';
  assert.equal(login.url.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(login.url.searchParams.get('agent_name_hint'), 'Athena');
  assert.equal((await login.call({ state: 'wrong', error: 'access_denied' })).status, 400);
  assert.equal((await login.call({ client_id: clientId })).status, 202);
  assert.deepEqual(await login.result(), { id: login.flow.id, status: 'succeeded' });
  const saved = await f.credentials.read('openai');
  assert.ok(saved?.type === 'oauth');
  assert.equal(saved.subject, subject);
  assert.equal(saved.clientId, clientId);
  assert.equal(saved.issuer, issuer);
  assert.ok(typeof saved.idToken === 'string');
  assert.deepEqual(await f.credentials.read('anthropic'), { type: 'api_key', key: 'other-provider-fixture' });

  // A separate run runtime uses Pi's store lock, and need not read the original vault directly.
  await f.credentials.modify('openai', async () => ({ ...saved, expires: 0 }));
  const secondRuntime = await f.makeRuntime();
  registerOpenAIOAuth(secondRuntime, { ...f.options, credentials: { read: async () => assert.fail('refresh used login lookup') } });
  const auth = await Promise.all([secondRuntime.getAuth('openai'), secondRuntime.getAuth('openai')]);
  assert.deepEqual(auth.map(entry => entry?.auth), [1, 2].map(() => ({ apiKey: 'rotated_access', baseUrl: resource })));
  assert.equal(refreshes, 1);
  const current = await f.credentials.read('openai');
  assert.equal(current?.type === 'oauth' && current.refresh, 'rotated_refresh');
  assert.equal(current?.type === 'oauth' && current.idToken, saved.idToken);

  const model = secondRuntime.getModel('openai', 'gpt-4o');
  assert.ok(model);
  const reply = await secondRuntime.completeSimple(model, {
    messages: [{ role: 'user', content: 'Hello.', timestamp: Date.now() }],
  }, {
    maxTokens: 256, temperature: 0, maxRetries: 0,
    async fetch(input, init) {
      const request = new Request(input, init);
      assert.equal(request.url, `${resource}/responses`);
      assert.equal(request.headers.get('authorization'), 'Bearer rotated_access');
      const payload = await request.json();
      assert.equal(payload.model, model.id);
      assert.equal(payload.store, false);
      assert.equal(payload.stream, true);
      assert.equal(payload.max_output_tokens, undefined);
      assert.equal(payload.temperature, undefined);
      return new Response('data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
        { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  assert.equal(reply.stopReason, 'stop', reply.errorMessage);

  const returning = f.createController(await f.makeRuntime());
  t.after(() => returning.close());
  const relogin = await begin(returning);
  const deviceFile = join(f.options.deviceIdDirectory, 'openai-oauth-device.v1');
  assert.equal((await stat(deviceFile)).mode & 0o777, 0o600);
  const deviceId = (await readFile(deviceFile, 'utf8')).trim();
  assert.equal(login.url.searchParams.get('ext_agent_host_id'), `urn:uuid:${deviceId}`);
  assert.equal(relogin.url.searchParams.get('ext_agent_host_id'), `urn:uuid:${deviceId}`);
  assert.equal(relogin.url.searchParams.get('client_id'), clientId);
  assert.equal(relogin.url.searchParams.has('agent_name_hint'), false);
  assert.notEqual(relogin.nonce, login.nonce);
  assert.equal((await relogin.call({ client_id: 'oaiapp_other' })).status, 400);
  assert.equal((await relogin.result()).status, 'failed');
  assert.deepEqual(await f.credentials.read('openai'), current);
});

test('invalid OpenAI ID token claims, signatures, or grants cannot replace an existing key', async t => {
  const cases = [
    ['wrong issuer', { iss: 'https://another-issuer.test' }], ['wrong audience', { aud: 'another_client' }],
    ['missing subject', { sub: undefined }], ['wrong nonce', { nonce: 'not-this-attempt' }],
    ['expired ID token', { exp: 0 }], ['wrong signature', {}], ['missing granted scopes', {}],
  ] as const;
  for (const [name, claims] of cases) await t.test(name, async sub => {
    let nonce = '';
    const f = await fixture(sub, () => tokens({
      id_token: idToken({ nonce, ...claims }, name === 'wrong signature' ? untrustedKey : signing.privateKey),
      scope: name === 'missing granted scopes' ? undefined : scopes,
    }));
    const existing = { type: 'api_key', key: 'sk-existing' } as const;
    await f.credentials.modify('openai', async () => existing);
    const attempt = await begin(f.controller);
    nonce = attempt.nonce;
    assert.equal((await attempt.call({ client_id: clientId })).status, 202);
    assert.deepEqual(await attempt.result(), { id: attempt.flow.id, status: 'failed', error: 'authorization_failed' });
    assert.deepEqual(await f.credentials.read('openai'), existing);
  });
});

test('verified identity without plan consent persists separately and reconnect explicitly requests consent', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'athena-identity-consent-'));
  const credentials = new InMemoryCredentialStore();
  const nativeFetch = globalThis.fetch;
  let nonce = '';
  let granted = 'openid profile email';
  const transport = providerTransport(() => tokens({ scope: granted, id_token: idToken({ nonce }),
    ...(!granted.includes('chatgpt.tokens.use.direct')
      ? { access_token: undefined, refresh_token: undefined, token_type: undefined, expires_in: undefined } : {}) }));
  t.mock.method(globalThis, 'fetch', (url: RequestInfo | URL, init?: RequestInit) =>
    String(url).startsWith('http://127.0.0.1:') ? nativeFetch(url, init) : transport(url, init));
  const manager = await ProviderManager.create(credentials, directory, { chatGPTEnabled: true });
  t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }); });
  await manager.saveApiKey('openai', 'fixture-independent-api-key');
  const controller = manager.oauth;
  assert.ok(controller);
  const attempt = await begin(controller);
  nonce = attempt.nonce;
  assert.equal(attempt.url.searchParams.has('prompt'), false);
  await attempt.call({ client_id: clientId });
  assert.equal((await attempt.result()).status, 'succeeded');
  const [account] = await manager.chatGPTAccounts();
  assert.ok(account);
  assert.equal(account.state, 'connected');
  assert.equal('planUsage' in account && account.planUsage, 'disabled');
  assert.deepEqual(await credentials.read('openai'), { type: 'api_key', key: 'fixture-independent-api-key' });
  const identityCatalog = await manager.catalog('openai', { accountRef: account.authRef, refresh: true });
  assert.deepEqual(identityCatalog.models, []);
  assert.deepEqual(identityCatalog.availableModelIds, []);
  assert.equal(identityCatalog.provider.auth, 'refresh_required');
  await assert.rejects(manager.authorChatGPTProfile('gpt-4o', account.authRef), { code: 'AUTH_REQUIRED' });
  await assert.rejects(manager.pin({ provider: 'openai', modelId: 'gpt-4o', authMode: 'chatgpt', authRef: account.authRef }), { code: 'AUTH_REQUIRED' });
  const reconnect = controller.start('openai', account.authRef);
  const url = new URL(await observe(() => controller.status(reconnect.id)?.authorizeUrl));
  assert.equal(url.searchParams.get('client_id'), clientId);
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.deepEqual(url.searchParams.get('scope')?.split(' ').sort(), scopes.split(' ').sort());
  assert.equal(url.searchParams.has('force_reconsent'), false);
  nonce = url.searchParams.get('nonce') ?? '';
  granted = scopes;
  const callback = new URL(url.searchParams.get('redirect_uri') ?? '');
  callback.search = new URLSearchParams({ state: url.searchParams.get('state') ?? '', code: 'fixture_code' }).toString();
  await fetch(callback);
  await observe(() => controller.status(reconnect.id)?.status === 'succeeded' ? true : undefined);
  const [enabled] = await manager.chatGPTAccounts();
  assert.equal(enabled?.authRef, account.authRef);
  assert.equal(enabled && 'planUsage' in enabled && enabled.planUsage, 'enabled');
});

test('identity-scoped access without a refresh token preserves sign-in but cannot authorize plan use', async t => {
  let nonce = '';
  const f = await fixture(t, () => tokens({ scope: 'openid profile email', refresh_token: undefined,
    id_token: idToken({ nonce }) }));
  const attempt = await begin(f.controller);
  nonce = attempt.nonce;
  await attempt.call({ client_id: clientId });
  assert.equal((await attempt.result()).status, 'succeeded');
  const saved = await f.credentials.read('openai');
  assert.equal(saved?.type === 'oauth' && saved.subject, subject);
  assert.equal(saved?.type === 'oauth' && saved.access, 'fixture_access');
  assert.equal(saved?.type === 'oauth' && saved.refresh, '');
  await assert.rejects(f.runtime.getAuth('openai'));
});

test('a browser denial closes its loopback without exchanging a code or changing the saved key', async t => {
  let exchanges = 0;
  const f = await fixture(t, () => { exchanges += 1; return tokens(); });
  const existing = { type: 'api_key', key: 'sk-existing' } as const;
  await f.credentials.modify('openai', async () => existing);
  const attempt = await begin(f.controller);

  const response = await attempt.call({ client_id: clientId, error: 'access_denied' });

  assert.equal(response.status, 400);
  assert.deepEqual(await attempt.result(), { id: attempt.flow.id, status: 'failed', error: 'authorization_failed' });
  await assert.rejects(attempt.call({ client_id: clientId }));
  assert.equal(exchanges, 0);
  assert.deepEqual(await f.credentials.read('openai'), existing);
});

test('cancellation aborts exchange, closes loopback, and clears the link before returning terminal status', async t => {
  const exchange = Promise.withResolvers<AbortSignal>();
  const f = await fixture(t, async (_form, signal) => {
    assert.ok(signal);
    exchange.resolve(signal);
    return new Promise((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  assert.throws(() => f.controller.start('openai-codex'), ProviderOAuthError);
  const waiting = await begin(f.controller);
  assert.equal(f.controller.start('openai').id, waiting.flow.id);
  f.controller.cancel(waiting.flow.id);
  assert.equal(f.controller.status(waiting.flow.id)?.authorizeUrl, undefined);
  assert.equal((await waiting.result()).status, 'cancelled');
  await assert.rejects(waiting.call({ client_id: clientId }));

  const attempt = await begin(f.controller);
  assert.equal((await attempt.call({ client_id: clientId })).status, 202);
  const signal = await exchange.promise;
  f.controller.cancel(attempt.flow.id);
  assert.equal(f.controller.status(attempt.flow.id)?.authorizeUrl, undefined);
  assert.deepEqual(await attempt.result(), { id: attempt.flow.id, status: 'cancelled' });
  assert.equal(signal.aborted, true);
  assert.equal(await f.credentials.read('openai'), undefined);

  const next = await begin(f.controller);
  await f.controller.close();
  assert.equal(f.controller.status(next.flow.id), undefined);
  assert.throws(() => f.controller.start('openai'), ProviderOAuthError);
  await assert.rejects(next.call({ client_id: clientId }));
});

test('a temporary refresh failure preserves the expired credential and logout survives reopen', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'athena-oauth-vault-'));
  const previous = process.env.ATHENA_CREDENTIAL_KEY;
  process.env.ATHENA_CREDENTIAL_KEY = randomBytes(32).toString('hex');
  t.after(async () => {
    if (previous === undefined) delete process.env.ATHENA_CREDENTIAL_KEY;
    else process.env.ATHENA_CREDENTIAL_KEY = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const first = await openProviderCredentials(directory);
  const saved = { type: 'oauth', access: 'fixture-expired-access', refresh: 'fixture-expired-refresh', expires: 0,
    issuer, subject, clientId, scopes: scopes.split(' '), idToken: idToken({}) } as const;
  await first.store.modify('openai', async () => saved);
  let refreshes = 0;
  t.mock.method(globalThis, 'fetch', providerTransport(form => {
    assert.equal(form.get('grant_type'), 'refresh_token');
    assert.equal(form.get('client_id'), clientId);
    assert.equal(form.get('refresh_token'), saved.refresh);
    refreshes++;
    return Response.json({ error: 'temporary_unavailable' }, { status: 503 });
  }));
  const reopened = await openProviderCredentials(directory);
  const manager = await ProviderManager.create(reopened.store, directory, { chatGPTEnabled: true });
  t.after(() => manager.close());
  const expired = await manager.catalog('openai');
  assert.equal(expired.provider.auth, 'refresh_required');
  assert.deepEqual(expired.availableModelIds, []);
  assert.equal(refreshes, 0);
  const failed = await manager.catalog('openai', { refresh: true });
  assert.equal(failed.error, 'refresh_failed');
  assert.equal(failed.provider.auth, 'refresh_required');
  assert.ok(refreshes !== 0);
  assert.deepEqual(await reopened.store.read('openai'), saved);
  const wire = JSON.stringify([expired, failed]);
  for (const identity of [saved.access, saved.refresh, saved.idToken, saved.subject]) assert.equal(wire.includes(identity), false);
  await manager.logout('openai');
  const final = await openProviderCredentials(directory);
  assert.equal(await final.store.read('openai'), undefined);
});

test('terminal OpenAI refresh rejection clears only the selected registration and requires reauthorization after reopen', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'athena-oauth-terminal-'));
  const previous = process.env.ATHENA_CREDENTIAL_KEY;
  process.env.ATHENA_CREDENTIAL_KEY = randomBytes(32).toString('hex');
  t.after(async () => {
    if (previous === undefined) delete process.env.ATHENA_CREDENTIAL_KEY;
    else process.env.ATHENA_CREDENTIAL_KEY = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const { store } = await openProviderCredentials(directory);
  const rejected = { type: 'oauth', access: 'test-old-access', refresh: 'test-old-refresh', expires: 0,
    issuer, subject, clientId, scopes: scopes.split(' '), idToken: idToken({}) } as const;
  const selected = chatGPTAccountRef(rejected);
  assert.ok(selected);
  await store.modify(selected, async () => rejected);
  await store.modify('openai', async () => ({ type: 'api_key', key: 'fixture-separate-api-key' }));
  let exchanges = 0;
  t.mock.method(globalThis, 'fetch', providerTransport(form => {
    exchanges++;
    assert.equal(form.get('client_id'), clientId);
    assert.equal(form.get('grant_type'), 'refresh_token');
    return Response.json({ error: 'refresh_token_invalidated' }, { status: 400 });
  }));
  const manager = await ProviderManager.create(store, directory, { chatGPTEnabled: true });
  t.after(() => manager.close());
  assert.equal((await manager.catalog('openai', { accountRef: selected, refresh: true })).error, 'refresh_failed');
  assert.equal((await manager.catalog('openai', { accountRef: selected, refresh: true })).provider.auth, 'refresh_required');
  assert.equal(exchanges, 1);
  await manager.close();
  const reopened = await openProviderCredentials(directory);
  const rotated = await reopened.store.read(selected);
  assert.equal(rotated?.type, 'oauth');
  if (rotated?.type !== 'oauth') assert.fail('Missing registration');
  assert.deepEqual([rotated.access, rotated.refresh, rotated.expires, rotated.idToken], ['', '', 0, rejected.idToken]);
  assert.deepEqual(await reopened.store.read('openai'), { type: 'api_key', key: 'fixture-separate-api-key' });
  const after = await ProviderManager.create(reopened.store, directory, { chatGPTEnabled: true });
  t.after(() => after.close());
  assert.equal((await after.chatGPTAccounts())[0]?.state, 'reauth_required');
});

test('a verified callback whose vault write fails returns a distinct failure and no credential', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'athena-oauth-vault-failure-'));
  const previous = process.env.ATHENA_CREDENTIAL_KEY;
  process.env.ATHENA_CREDENTIAL_KEY = randomBytes(32).toString('hex');
  t.after(async () => {
    if (previous === undefined) delete process.env.ATHENA_CREDENTIAL_KEY;
    else process.env.ATHENA_CREDENTIAL_KEY = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const { store } = await openProviderCredentials(directory);
  await mkdir(join(directory, 'provider-secrets.v1'));
  const runtime = await ModelRuntime.create({ credentials: store, modelsPath: null, refreshOnCreate: false });
  let nonce = '';
  const controller = new ProviderOAuthController({ runtime, credentials: store, deviceIdDirectory: directory,
    fetch: providerTransport(() => tokens({ id_token: idToken({ nonce }) })) });
  t.after(() => controller.close());
  const attempt = await begin(controller);
  nonce = attempt.nonce;
  assert.equal((await attempt.call({ client_id: clientId })).status, 202);
  assert.deepEqual(await attempt.result(), { id: attempt.flow.id, status: 'failed', error: 'credential_save_failed' });
  assert.equal(await store.read('openai'), undefined);
});

test('the provider manager retains two ChatGPT registrations beside an API key and keeps returning browser hints private', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'athena-oauth-multiple-'));
  const credentials = new InMemoryCredentialStore();
  const manager = await ProviderManager.create(credentials, directory, { chatGPTEnabled: true, nativeBrowser: true });
  t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }); });
  await manager.saveApiKey('openai', 'fixture-api-only');
  const controller: ProviderOAuthController | undefined = manager.oauth;
  assert.ok(controller);
  const nativeFetch = globalThis.fetch;
  let identity = { client: clientId, nonce: '', token: '' };
  const transport = providerTransport(form => {
    assert.equal(form.get('client_id'), identity.client);
    return tokens({ access_token: identity.token, id_token: idToken({ nonce: identity.nonce, aud: identity.client,
      email_verified: true, email: 'same-account@example.invalid' }) });
  });
  t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).startsWith('http://127.0.0.1:')) return nativeFetch(url, init);
    if (String(url) === `${resource}/models`) {
      const token = new Headers(init?.headers).get('authorization');
      assert.ok(token === 'Bearer fixture-plan-one' || token === 'Bearer fixture-plan-two');
      const slug = token.endsWith('-one') ? 'plan-one' : 'plan-two';
      return Response.json({ models: [{ slug, display_name: slug, visibility: 'list' }] });
    }
    return transport(url, init);
  });
  let hostId: string | null = null;
  for (const [client, token] of [[clientId, 'fixture-plan-one'], ['oaiapp_other_workspace', 'fixture-plan-two']]) {
    assert.ok(client && token);
    const flow = controller.start('openai');
    const state: ProviderOAuthFlow = await observe((): ProviderOAuthFlow | undefined => {
      const current: ProviderOAuthFlow | undefined = controller.status(flow.id);
      return current?.browserReady ? current : undefined;
    });
    assert.deepEqual(state, { id: flow.id, status: 'pending', browserReady: true });
    const url: URL = new URL(controller.authorizeUrl(flow.id));
    assert.equal(url.searchParams.get('client_id'), 'dynamic_agent_client');
    assert.equal(url.searchParams.has('id_token_hint'), false);
    const currentHost = url.searchParams.get('ext_agent_host_id');
    if (hostId) assert.equal(currentHost, hostId);
    hostId = currentHost;
    identity = { token, client, nonce: url.searchParams.get('nonce') ?? '' };
    const callback = new URL(url.searchParams.get('redirect_uri') ?? '');
    callback.search = new URLSearchParams({ state: url.searchParams.get('state') ?? '', code: 'fixture_code', client_id: client }).toString();
    assert.equal((await fetch(callback)).status, 202);
    assert.equal((await observe(() => { const current = controller.status(flow.id); return current?.status === 'pending' ? undefined : current; })).status, 'succeeded');
  }
  const accounts = await manager.chatGPTAccounts();
  assert.equal(accounts.length, 2);
  assert.equal(new Set(accounts.map(account => account.label)).size, 2);
  assert.doesNotMatch(JSON.stringify(accounts), /fixture-plan|oaiapp_|fixture_subject/);
  assert.deepEqual(await credentials.read('openai'), { type: 'api_key', key: 'fixture-api-only' });
  const first = accounts[0];
  const second = accounts[1];
  assert.ok(first && second);
  assert.deepEqual((await manager.catalog('openai', { accountRef: first.authRef })).availableModelIds, ['plan-one']);
  assert.deepEqual((await manager.catalog('openai', { accountRef: second.authRef })).availableModelIds, ['plan-two']);
  await assert.rejects(manager.authorChatGPTProfile('plan-one', second.authRef), { code: 'MODEL_UNAVAILABLE' });
  const reconnect = controller.start('openai', first.authRef);
  const state = await observe(() => controller.status(reconnect.id)?.browserReady ? controller.status(reconnect.id) : undefined);
  assert.deepEqual(state, { id: reconnect.id, status: 'pending', browserReady: true });
  const url = new URL(controller.authorizeUrl(reconnect.id));
  assert.equal(url.searchParams.get('client_id'), clientId);
  assert.equal(url.searchParams.get('ext_agent_host_id'), hostId);
  assert.equal(url.searchParams.has('id_token_hint'), true);
  controller.cancel(reconnect.id);
  assert.throws(() => controller.authorizeUrl(reconnect.id), { code: 'UNSUPPORTED_AUTH' });
});
