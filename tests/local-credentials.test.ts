import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test, { type TestContext } from 'node:test';
import { CredentialMigration } from '../runtime/credential-migration.ts';
import { openLocalCredentials } from '../runtime/local-credentials.ts';
import { CredentialVaultError, openProviderCredentials } from '../runtime/provider-credentials.ts';
import { assertPrivatePermissions, directoryLink, makePublicPermissions, restorePrivatePermissions, windows } from './platform-test-helpers.ts';

async function setup(t: TestContext) {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'athena-local-credentials-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const auth = join(dir, 'auth');
  return { dir, auth, file: join(auth, 'credentials.v2.json') };
}

const apiKey = (key: string) => ({ type: 'api_key', key } as const);
const firstToken = { type: 'oauth', access: 'fixture-access', refresh: 'fixture-refresh', expires: 1 } as const;
const rotated = { type: 'oauth', access: 'next-access', refresh: 'next-refresh', expires: 2 } as const;
const invalid = (error: unknown) => error instanceof CredentialVaultError && error.code === 'VAULT_INVALID';

test('local credentials initialize privately and restore provider and account changes independently', async t => {
  const { auth, file } = await setup(t);
  const store = await openLocalCredentials(auth);
  await assertPrivatePermissions(auth, 0o700);
  await assertPrivatePermissions(file, 0o600);
  assert.deepEqual(await store.list(), []);
  await store.modify('openai', async () => apiKey('fixture-api'));
  await store.modify('openai', async () => apiKey('updated-fixture'));
  await store.modify('chatgpt:first', async () => firstToken);
  await store.modify('chatgpt:second', async () => rotated);
  const reopened = await openLocalCredentials(auth);
  assert.deepEqual(await reopened.read('openai'), apiKey('updated-fixture'));
  assert.deepEqual(await reopened.read('chatgpt:first'), firstToken);
  assert.deepEqual(await reopened.read('chatgpt:second'), rotated);
  assert.deepEqual(await reopened.list(), [
    { providerId: 'openai', type: 'api_key' }, { providerId: 'chatgpt:first', type: 'oauth' }, { providerId: 'chatgpt:second', type: 'oauth' },
  ]);
  await reopened.delete('chatgpt:first');
  assert.equal(await store.read('chatgpt:first'), undefined);
  assert.deepEqual(await store.read('chatgpt:second'), rotated);
  await reopened.delete('openai');
  assert.equal(await (await openLocalCredentials(auth)).read('openai'), undefined);
});

test('local credentials fail closed on permission changes, symbolic links and damaged JSON', async t => {
  const { auth, file, dir } = await setup(t);
  await openLocalCredentials(auth);
  await makePublicPermissions(file);
  await assert.rejects(openLocalCredentials(auth), invalid);
  await restorePrivatePermissions(file, 0o600);
  await makePublicPermissions(auth, 0o755);
  await assert.rejects(openLocalCredentials(auth), invalid);
  await restorePrivatePermissions(auth, 0o700);
  await writeFile(file, '{incomplete');
  await assert.rejects(openLocalCredentials(auth), invalid);
  assert.equal(await readFile(file, 'utf8'), '{incomplete');
  await rm(file);
  const unrelated = join(dir, 'unrelated.json');
  await writeFile(unrelated, 'unchanged', { mode: 0o600 });
  await symlink(unrelated, file);
  await assert.rejects(openLocalCredentials(auth), invalid);
  assert.equal(await readFile(unrelated, 'utf8'), 'unchanged');
  await directoryLink(auth, join(dir, 'alias'));
  await assert.rejects(openLocalCredentials(join(dir, 'alias')), invalid);
});

function holdCredentialUpdate(t: TestContext, auth: string) {
  t.signal.throwIfAborted();
  let owned: ChildProcessWithoutNullStreams | undefined;
  let exited: Promise<number | null> | undefined;
  const stop = () => {
    if (owned && owned.exitCode === null && owned.signalCode === null) owned.kill('SIGKILL');
  };
  // Register ownership before creating a process. A timed-out callback may resume
  // after an awaited ACL operation; it must never leave a writer awaiting stdin.
  t.after(async () => {
    t.signal.removeEventListener('abort', stop);
    stop();
    await exited;
  });
  t.signal.addEventListener('abort', stop, { once: true });
  t.signal.throwIfAborted();
  const script = `const {openLocalCredentials}=await import(process.argv[1]);
    const store=await openLocalCredentials(process.argv[2]);
    await store.modify('chatgpt:first', async current=>{
      if (current?.expires !== 1) throw new Error('Unexpected fixture');
      console.log('held');
      await new Promise(resolve=>process.stdin.once('data',resolve));
      return {type:'oauth',access:'next-access',refresh:'next-refresh',expires:2};
    }); process.stdin.destroy();`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, new URL('../runtime/local-credentials.ts', import.meta.url).href, auth],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  owned = child;
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  exited = new Promise<number | null>(resolve => child.once('close', resolve));
  return { child, lines, exited };
}

test('concurrent processes serialize rotation and release the lock after a killed writer',
  // This scenario performs about 66 OS ACL inspections/protections on Windows,
  // including two independent writers. Keep the short lock-abort deadline below.
  { timeout: windows ? 120_000 : 15_000 }, async t => {
  const { auth, file } = await setup(t);
  const store = await openLocalCredentials(auth);
  await store.modify('chatgpt:first', async () => firstToken, { signal: t.signal });
  const first = holdCredentialUpdate(t, auth);
  t.signal.throwIfAborted();
  assert.equal((await first.lines.next()).value, 'held');

  // A read remains available but an independent process cannot start a conflicting update yet.
  assert.deepEqual(await store.read('chatgpt:first', { signal: t.signal }), firstToken);
  t.signal.throwIfAborted();
  await assert.rejects(store.modify('chatgpt:first', async () => assert.fail('Concurrent writer entered the transaction'),
    { signal: AbortSignal.timeout(125) }), { name: 'AbortError' });
  t.signal.throwIfAborted();
  const waiting = store.modify('chatgpt:first', async credential => {
    assert.deepEqual(credential, rotated);
    return undefined;
  }, { signal: t.signal });
  // A test timeout can reject this operation while the child is still closing.
  // The awaited promise below still reports ordinary operation failures.
  void waiting.catch(() => undefined);
  first.child.stdin.write('\n');
  t.signal.throwIfAborted();
  assert.equal(await first.exited, 0);
  t.signal.throwIfAborted();
  assert.deepEqual(await waiting, rotated);

  await store.modify('chatgpt:first', async () => firstToken, { signal: t.signal });
  const beforeCrash = await readFile(file);
  const second = holdCredentialUpdate(t, auth);
  t.signal.throwIfAborted();
  assert.equal((await second.lines.next()).value, 'held');
  second.child.kill('SIGKILL');
  t.signal.throwIfAborted();
  await second.exited;
  const temporary = '.credentials.v2.abcdabcd-abcd-abcd-abcd-abcdabcdabcd.tmp';
  await writeFile(join(auth, temporary), 'incomplete fixture', { mode: 0o600 });
  const reopened = await openLocalCredentials(auth);
  assert.deepEqual(await readFile(file), beforeCrash);
  assert.equal((await readdir(auth)).includes(temporary), false);
  await reopened.modify('chatgpt:first', async () => rotated, { signal: t.signal });
  assert.deepEqual(await store.read('chatgpt:first', { signal: t.signal }), rotated);
});

test('legacy import is opt-in, preserves both stores after failure, and never overwrites newer logins', async t => {
  const { auth, file, dir } = await setup(t);
  const sourceKey = randomBytes(32);
  const { store: legacy } = await openProviderCredentials(dir, { key: sourceKey.toString('hex'), source: 'keychain' });
  await legacy.modify('openai', async () => apiKey('older-fixture'));
  await legacy.modify('chatgpt:first', async () => firstToken);
  const legacyFile = join(dir, 'provider-secrets.v1');
  const original = await readFile(legacyFile);
  const store = await openLocalCredentials(auth);
  await store.modify('openai', async () => apiKey('newer-fixture'));
  const before = await readFile(file);
  let reads = 0;
  let key = randomBytes(32);
  const migration = new CredentialMigration({ workspace: dir, store, requestKey: async () => { reads++; return Buffer.from(key); } });
  assert.equal(await migration.status(), 'approval_required');
  assert.equal(reads, 0);
  await assert.rejects(migration.importWithApproval(), { code: 'VAULT_KEY_MISMATCH' });
  assert.deepEqual(await readFile(file), before);
  assert.deepEqual(await readFile(legacyFile), original);
  key = sourceKey;
  assert.deepEqual(await migration.importWithApproval(), { status: 'imported', added: 1 });
  assert.deepEqual(await readFile(legacyFile), original);
  const reopened = await openLocalCredentials(auth);
  assert.deepEqual(await reopened.read('openai'), apiKey('newer-fixture'));
  assert.deepEqual(await reopened.read('chatgpt:first'), firstToken);
  assert.equal(await new CredentialMigration({ workspace: dir, store: reopened }).status(), 'imported');
  assert.deepEqual(await migration.importWithApproval(), { status: 'imported', added: 0 });
  assert.equal(reads, 2);
});
