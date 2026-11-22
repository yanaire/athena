import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import type { OAuthCredential } from '@earendil-works/pi-ai';
import { chatGPTAccountRef } from '../runtime/chatgpt-catalog.ts';
import { ChatGPTRegistrations } from '../runtime/chatgpt-registrations.ts';
import { openProviderCredentials } from '../runtime/provider-credentials.ts';

const hostId = '018ec123-1234-4234-8234-123456789abc';
const hostBinding = `urn:uuid:${hostId}`;
const issuer = 'https://auth.openai.com';
const discoveryUrl = `${issuer}/.well-known/openid-configuration`;
const revokeUrl = `${issuer}/api/accounts/oauth/revoke`;

function credential(fields: Readonly<Record<string, unknown>> = {}): OAuthCredential {
  return { type: 'oauth', issuer, clientId: 'oaiapp_one', subject: 'subject-one',
    access: 'secret-access-one', refresh: 'secret-refresh-one', idToken: 'secret-id-one',
    expires: 2_000_000_000_000, scopes: ['openid', 'chatgpt.tokens.use.direct'], ...fields };
}

function accountRef(value: OAuthCredential): string {
  const ref = chatGPTAccountRef(value);
  assert.ok(ref);
  return ref;
}

const offline: typeof fetch = async () => { throw new TypeError('No provider network in tests.'); };

test('registrations distinguish issued clients and subjects even with the same email', async () => {
  const vault = new InMemoryCredentialStore();
  const registrations = new ChatGPTRegistrations({ credentials: vault, currentHostId: hostId, fetch: offline });
  const first = await registrations.registerVerified(credential(), { email: 'same@example.com', label: 'Work' });
  const second = await registrations.registerVerified(credential({ clientId: 'oaiapp_two' }),
    { email: 'same@example.com', label: 'Work' });
  const third = await registrations.registerVerified(credential({ subject: 'subject-two' }),
    { email: 'same@example.com' });

  assert.equal(new Set([first.authRef, second.authRef, third.authRef]).size, 3);
  assert.notEqual(first.label, second.label);
  assert.equal(first.authRef, accountRef(credential()));
  assert.deepEqual((await registrations.list()).map(item => item.authRef).sort(),
    [first.authRef, second.authRef, third.authRef].sort());
  assert.equal(await vault.read('openai'), undefined);
});

test('verified legacy sign-in writes the dedicated record without touching the legacy key', async () => {
  const vault = new InMemoryCredentialStore();
  await vault.modify('openai', async () => credential());
  await vault.modify('anthropic', async () => ({ type: 'api_key', key: 'other-provider-key' }));
  const registrations = new ChatGPTRegistrations({ credentials: vault, currentHostId: hostId, fetch: offline });
  const ref = accountRef(credential());

  assert.equal((await registrations.lookup(ref))?.clientId, 'oaiapp_one');
  assert.equal((await registrations.lookup(ref))?.lastAuthenticatedAt, null);
  assert.equal((await registrations.lookup(ref))?.lastRefreshedAt, null);
  await registrations.registerVerified(credential({ access: 'renewed-access' }));
  assert.deepEqual(await vault.read('openai'), credential());
  const dedicated = await vault.read(ref);
  assert.equal(dedicated?.type === 'oauth' ? dedicated.access : undefined, 'renewed-access');
  const selected = await registrations.forRegistration(ref).read('openai');
  assert.equal(selected?.type === 'oauth' ? selected.access : undefined, 'renewed-access');
  assert.deepEqual(await vault.read('anthropic'), { type: 'api_key', key: 'other-provider-key' });
  assert.equal((await registrations.list()).length, 1);
});

test('adding ChatGPT leaves the OpenAI API key route intact', async () => {
  const vault = new InMemoryCredentialStore();
  await vault.modify('openai', async () => ({ type: 'api_key', key: 'api-key' }));
  const registrations = new ChatGPTRegistrations({ credentials: vault, currentHostId: hostId, fetch: offline });

  await registrations.registerVerified(credential());

  assert.deepEqual(await vault.read('openai'), { type: 'api_key', key: 'api-key' });
  assert.equal((await registrations.list()).length, 1);
});

test('registration accepts a validated stored host binding without a current host callback', async () => {
  const vault = new InMemoryCredentialStore();
  const registrations = new ChatGPTRegistrations({ credentials: vault, fetch: offline });
  const saved = await registrations.registerVerified(credential({ ext_agent_host_id: hostBinding }));
  // Real authorization refreshes return identity/token fields without app host metadata.
  await registrations.forRegistration(saved.authRef).modify('openai', async () =>
    credential({ access: 'rotated-without-host' }));
  await registrations.registerVerified(credential({ access: 'reauthorized-without-host' }));

  assert.equal((await registrations.lookup(saved.authRef))?.extAgentHostId, hostBinding);
  assert.equal((await registrations.forRegistration(saved.authRef).read('openai'))?.type, 'oauth');
});

test('registration rejects invalid identity, permissions and host bindings before saving', async t => {
  for (const fields of [
    { issuer: 'https://untrusted.example' }, { clientId: 'dynamic_agent_client' }, { subject: '' },
    { scopes: [] }, { refresh: '' }, { idToken: '' }, { expires: NaN },
    { extAgentHostId: 'arbitrary-host' },
    { extAgentHostId: 'urn:uuid:018ec123-1234-4234-8234-123456789abd' },
  ]) {
    await t.test(JSON.stringify(fields), async () => {
      const vault = new InMemoryCredentialStore();
      const registrations = new ChatGPTRegistrations({ credentials: vault, currentHostId: hostId, fetch: offline });
      await assert.rejects(registrations.registerVerified(credential(fields)));
      assert.deepEqual(await vault.list(), []);
    });
  }
  const registrations = new ChatGPTRegistrations({ credentials: new InMemoryCredentialStore(), fetch: offline });
  await assert.rejects(registrations.registerVerified(credential()), { code: 'INVALID_REGISTRATION' });
});

test('identity-only grants survive reopening but never authorize models or refresh', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'athena-identity-only-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const desktop = { key: 'cd'.repeat(32), source: 'operator_key' } as const;
  const { store } = await openProviderCredentials(directory, desktop);
  const registrations = new ChatGPTRegistrations({ credentials: store, currentHostId: hostId, fetch: offline });
  const identity = credential({ access: '', refresh: '', expires: 0, scopes: ['openid', 'profile', 'email'] });
  const saved = await registrations.registerVerified(credential({ scopes: ['openid', 'profile', 'email'] }));
  assert.equal(saved.planUsage, 'disabled');
  // Permission can also be removed by a successful token rotation.
  await registrations.registerVerified(credential());
  await registrations.forRegistration(saved.authRef).modify('openai', async () => identity);
  const { store: reopened } = await openProviderCredentials(directory, desktop);
  const restored = new ChatGPTRegistrations({ credentials: reopened, currentHostId: hostId, fetch: offline });
  assert.equal((await restored.lookup(saved.authRef))?.state, 'connected');
  assert.equal((await restored.lookup(saved.authRef))?.planUsage, 'disabled');
  assert.deepEqual(await restored.forRegistration(saved.authRef).list(), []);
  await assert.rejects(restored.forRegistration(saved.authRef).read('openai'), { code: 'AUTH_REQUIRED' });
  const retained = await restored.forAuthorization(saved.authRef).read('openai');
  assert.equal(retained?.type === 'oauth' && retained.idToken, 'secret-id-one');
  assert.equal((await restored.signOut(saved.authRef)).remote, 'not_needed');
  assert.equal((await restored.lookup(saved.authRef))?.state, 'signed_out');
});

test('public projections allowlist metadata and never return token fields', async () => {
  const vault = new InMemoryCredentialStore();
  const registrations = new ChatGPTRegistrations({ credentials: vault, currentHostId: hostId, fetch: offline });
  const saved = await registrations.registerVerified(credential({ arbitrarySecret: 'secret-extra' }),
    { label: 'Personal', email: 'person@example.com', displayName: 'Person', workspaceName: 'Workspace',
      ...{ access: 'secret-injected', nested: { secret: 'no' } } });

  assert.deepEqual(Object.keys(saved).sort(), ['authRef', 'issuer', 'clientId', 'subject', 'extAgentHostId',
    'state', 'planUsage', 'label', 'email', 'displayName', 'workspaceName', 'lastAuthenticatedAt', 'lastRefreshedAt'].sort());
  const serialized = JSON.stringify(await registrations.list());
  for (const secret of ['secret-access-one', 'secret-refresh-one', 'secret-id-one', 'secret-extra', 'secret-injected']) {
    assert.equal(serialized.includes(secret), false);
  }
  const stored = await vault.read(saved.authRef);
  assert.equal(stored?.type === 'oauth' ? stored.arbitrarySecret : undefined, undefined);
  await assert.rejects(registrations.registerVerified(credential(), { label: 'secret-access-one' }));
  await assert.rejects(registrations.registerVerified(credential(), { email: 'bad\nemail' }));
});

test('scoped refresh is serialized in the encrypted vault and survives reopening', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'athena-registrations-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const desktop = { key: 'ab'.repeat(32), source: 'operator_key' } as const;
  const { store: vault } = await openProviderCredentials(directory, desktop);
  const registrations = new ChatGPTRegistrations({ credentials: vault, currentHostId: hostId, fetch: offline });
  const first = await registrations.registerVerified(credential());
  const other = await registrations.registerVerified(credential({ clientId: 'oaiapp_other' }));
  const one = registrations.forRegistration(first.authRef);
  const two = new ChatGPTRegistrations({ credentials: vault, currentHostId: hostId, fetch: offline })
    .forRegistration(first.authRef);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const refreshing = one.modify('openai', async current => {
    assert.equal(current?.type === 'oauth' ? current.refresh : undefined, 'secret-refresh-one');
    entered.resolve();
    await release.promise;
    return credential({ refresh: 'secret-refresh-two', access: 'secret-access-two' });
  });
  await entered.promise;
  const queued = two.modify('openai', async current => {
    assert.equal(current?.type === 'oauth' ? current.refresh : undefined, 'secret-refresh-two');
    return credential({ refresh: 'secret-refresh-three', access: 'secret-access-three' });
  });
  release.resolve();
  await Promise.all([refreshing, queued]);

  const reopened = await openProviderCredentials(directory, desktop);
  const restored = new ChatGPTRegistrations({ credentials: reopened.store, currentHostId: hostId, fetch: offline });
  const latest = await restored.forRegistration(first.authRef).read('openai');
  assert.equal(latest?.type === 'oauth' ? latest.refresh : undefined, 'secret-refresh-three');
  assert.equal((await restored.lookup(other.authRef))?.state, 'connected');
  const bytes = await readFile(join(directory, 'provider-secrets.v1'));
  assert.equal(bytes.includes(Buffer.from('secret-refresh-three')), false);
});

test('scoped credentials reject replacement identities and isolate returned objects', async () => {
  const vault = new InMemoryCredentialStore();
  const registrations = new ChatGPTRegistrations({ credentials: vault, currentHostId: hostId, fetch: offline });
  const saved = await registrations.registerVerified(credential());
  const scoped = registrations.forRegistration(saved.authRef);
  const view = await scoped.read('openai');
  if (view?.type === 'oauth') view.access = 'mutated-outside-lock';
  await assert.rejects(scoped.modify('openai', async () => credential({ subject: 'different-subject' })),
    { code: 'AUTH_REQUIRED' });
  await assert.rejects(scoped.modify('anthropic', async () => credential()), { code: 'SCOPED_PROVIDER' });
  await assert.rejects(scoped.delete('openai'), { code: 'SCOPED_PROVIDER' });
  assert.equal(await scoped.read('anthropic'), undefined);
  assert.deepEqual(await scoped.list(), [{ providerId: 'openai', type: 'oauth' }]);
  const unchanged = await scoped.read('openai');
  assert.equal(unchanged?.type === 'oauth' ? unchanged.access : undefined, 'secret-access-one');
});

test('sign-out revokes the latest rotated refresh token before clearing and retains metadata', async () => {
  const vault = new InMemoryCredentialStore();
  let revokedToken: string | null = null;
  const send: typeof fetch = async (url, init) => {
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal);
    if (String(url) === discoveryUrl) return Response.json({ issuer, revocation_endpoint: revokeUrl });
    assert.equal(String(url), revokeUrl);
    assert.ok(init?.body instanceof URLSearchParams);
    revokedToken = init.body.get('token');
    assert.equal(init.body.get('client_id'), 'oaiapp_one');
    assert.equal(init.body.get('token_type_hint'), 'refresh_token');
    return new Response(null, { status: 200 });
  };
  const registrations = new ChatGPTRegistrations({ credentials: vault, currentHostId: hostId, fetch: send });
  const first = await registrations.registerVerified(credential(), { email: 'person@example.com' });
  const other = await registrations.registerVerified(credential({ clientId: 'oaiapp_other' }));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const refreshing = registrations.forRegistration(first.authRef).modify('openai', async () => {
    entered.resolve();
    await release.promise;
    return credential({ refresh: 'latest-refresh-token' });
  });
  await entered.promise;
  const signingOut = registrations.signOut(first.authRef);
  release.resolve();
  await refreshing;
  const result = await signingOut;

  assert.equal(result.remote, 'revoked');
  assert.equal(revokedToken, 'latest-refresh-token');
  assert.equal(result.registration.email, 'person@example.com');
  assert.equal(result.registration.state, 'signed_out');
  assert.equal(result.registration.extAgentHostId, hostBinding);
  const cleared = await vault.read(first.authRef);
  assert.equal(cleared?.type, 'oauth');
  assert.equal(cleared?.type === 'oauth' ? cleared.access : undefined, '');
  assert.equal(cleared?.type === 'oauth' ? cleared.refresh : undefined, '');
  assert.equal(cleared?.type === 'oauth' ? cleared.idToken : undefined, undefined);
  await assert.rejects(registrations.forRegistration(first.authRef).modify('openai', async () => credential()),
    { code: 'AUTH_REQUIRED' });
  assert.equal((await registrations.signOut(first.authRef)).remote, 'not_needed');
  assert.equal((await registrations.lookup(other.authRef))?.state, 'connected');
});

test('remote failures clear legacy tokens and expose only a fixed public failure', async t => {
  for (const mode of ['network', 'rejected', 'cancelled'] as const) {
    await t.test(mode, async () => {
      const vault = new InMemoryCredentialStore();
      await vault.modify('openai', async () => credential());
      const send: typeof fetch = async url => {
        if (mode === 'network') throw new TypeError('secret-refresh-one');
        if (String(url) === discoveryUrl) return Response.json({ issuer, revocation_endpoint: revokeUrl });
        return new Response('secret-refresh-one', { status: 503 });
      };
      const registrations = new ChatGPTRegistrations({ credentials: vault, currentHostId: hostId, fetch: send });
      const signal = mode === 'cancelled' ? AbortSignal.abort() : undefined;

      const result = await registrations.signOut(accountRef(credential()), { signal });

      assert.equal(result.remote, 'unconfirmed');
      assert.equal(result.remoteFailure, mode === 'rejected' ? 'revocation_rejected' : 'request_failed');
      assert.equal(result.registration.state, 'signed_out');
      assert.equal(JSON.stringify(result).includes('secret-'), false);
      const stored = await vault.read('openai');
      assert.equal(stored?.type === 'oauth' ? stored.refresh : undefined, '');
    });
  }
});

test('discovery cannot send credentials outside the official HTTPS origin or through URL hints', async t => {
  for (const endpoint of [
    'https://attacker.example/revoke', 'http://auth.openai.com/revoke',
    'https://auth.openai.com.attacker.example/revoke', 'https://user:pass@auth.openai.com/revoke',
    `${revokeUrl}?token=hint`, `${revokeUrl}#hint`,
  ]) {
    await t.test(endpoint, async () => {
      const vault = new InMemoryCredentialStore();
      let requests = 0;
      const send: typeof fetch = async () => {
        requests++;
        return Response.json({ issuer, revocation_endpoint: endpoint });
      };
      const registrations = new ChatGPTRegistrations({ credentials: vault, currentHostId: hostId, fetch: send });
      const saved = await registrations.registerVerified(credential());

      const result = await registrations.signOut(saved.authRef);

      assert.equal(result.remoteFailure, 'invalid_discovery');
      assert.equal(result.registration.state, 'signed_out');
      assert.equal(requests, 1);
    });
  }
});

test('revocation deadline clears tokens even if an injected transport ignores abort', async t => {
  // Keep a referenced circuit breaker: AbortSignal.timeout itself is unref'ed.
  const guard = setTimeout(() => assert.fail('Revocation did not finish within its deadline.'), 1000);
  t.after(() => clearTimeout(guard));
  const vault = new InMemoryCredentialStore();
  const lateDiscovery = Promise.withResolvers<Response>();
  let requests = 0;
  const send: typeof fetch = () => {
    requests++;
    return lateDiscovery.promise;
  };
  const registrations = new ChatGPTRegistrations({ credentials: vault, currentHostId: hostId, fetch: send,
    requestTimeoutMs: 10 });
  const saved = await registrations.registerVerified(credential());

  const result = await registrations.signOut(saved.authRef);

  assert.equal(result.remoteFailure, 'request_failed');
  assert.equal(result.registration.state, 'signed_out');
  await assert.rejects(registrations.forRegistration(saved.authRef).read('openai'), { code: 'AUTH_REQUIRED' });
  lateDiscovery.resolve(Response.json({ issuer, revocation_endpoint: revokeUrl }));
  await setImmediate();
  assert.equal(requests, 1, 'A late discovery result must not send cleared tokens.');
});

test('reauthorization state blocks refresh and verified sign-in restores the same registration', async () => {
  const vault = new InMemoryCredentialStore();
  const registrations = new ChatGPTRegistrations({ credentials: vault, currentHostId: hostId, fetch: offline });
  const saved = await registrations.registerVerified(credential(), { label: 'Saved account' });

  await registrations.markReauthorizationRequired(saved.authRef);

  assert.equal((await registrations.lookup(saved.authRef))?.state, 'reauth_required');
  await assert.rejects(registrations.forRegistration(saved.authRef).read('openai'), { code: 'AUTH_REQUIRED' });
  const hints = await registrations.forAuthorization(saved.authRef).read('openai');
  assert.equal(hints?.type === 'oauth' ? hints.idToken : undefined, 'secret-id-one');
  const restored = await registrations.registerVerified(credential({ access: 'reauthorized-access' }));
  assert.equal(restored.authRef, saved.authRef);
  assert.equal(restored.label, saved.label);
  assert.equal(restored.state, 'connected');
  assert.equal((await registrations.list()).length, 1);
});

test('authentication and refresh timestamps reflect successful events and survive sign-out', async t => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const vault = new InMemoryCredentialStore();
  const registrations = new ChatGPTRegistrations({ credentials: vault, currentHostId: hostId, fetch: offline });
  const first = await registrations.registerVerified(credential());
  const scoped = registrations.forRegistration(first.authRef);
  assert.equal(first.lastAuthenticatedAt, 1000);
  assert.equal(first.lastRefreshedAt, null);

  now = 2000;
  await scoped.modify('openai', async () => undefined);
  assert.equal((await registrations.lookup(first.authRef))?.lastRefreshedAt, null);
  await assert.rejects(scoped.modify('openai', async () => { throw new Error('failed refresh'); }));
  assert.equal((await registrations.lookup(first.authRef))?.lastRefreshedAt, null);
  await scoped.modify('openai', async () => credential({ refresh: 'timestamp-rotation' }));
  const refreshed = await registrations.lookup(first.authRef);
  assert.equal(refreshed?.lastAuthenticatedAt, 1000);
  assert.equal(refreshed?.lastRefreshedAt, 2000);

  now = 3000;
  const reauthenticated = await registrations.registerVerified(credential());
  assert.equal(reauthenticated.lastAuthenticatedAt, 3000);
  assert.equal(reauthenticated.lastRefreshedAt, 2000);
  now = 4000;
  const signedOut = await registrations.signOut(first.authRef);
  assert.equal(signedOut.registration.lastAuthenticatedAt, 3000);
  assert.equal(signedOut.registration.lastRefreshedAt, 2000);
  const hints = await registrations.forAuthorization(first.authRef).read('openai');
  assert.equal(hints?.type === 'oauth' ? hints.idToken : undefined, undefined);
  const restarted = new ChatGPTRegistrations({ credentials: vault, currentHostId: hostId, fetch: offline });
  assert.equal((await restarted.lookup(first.authRef))?.lastRefreshedAt, 2000);
});

test('sign-out clears a matching legacy copy while preserving a replacement API key', async t => {
  for (const replaceWithApiKey of [false, true]) {
    await t.test(replaceWithApiKey ? 'replaced API key' : 'matching OAuth copy', async () => {
      const vault = new InMemoryCredentialStore();
      await vault.modify('openai', async () => credential());
      const registrations = new ChatGPTRegistrations({ credentials: vault, currentHostId: hostId, fetch: offline });
      const saved = await registrations.registerVerified(credential({ refresh: 'new-verified-refresh' }));
      if (replaceWithApiKey) await vault.modify('openai', async () => ({ type: 'api_key', key: 'keep-api-key' }));

      await registrations.signOut(saved.authRef);

      const legacy = await vault.read('openai');
      if (replaceWithApiKey) assert.deepEqual(legacy, { type: 'api_key', key: 'keep-api-key' });
      else {
        assert.equal(legacy?.type === 'oauth' ? legacy.refresh : undefined, '');
        assert.equal(legacy?.type === 'oauth' ? legacy.idToken : undefined, undefined);
      }
      assert.equal((await registrations.lookup(saved.authRef))?.state, 'signed_out');
      assert.equal((await registrations.list()).length, 1);
    });
  }
});
