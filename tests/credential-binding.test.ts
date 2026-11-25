import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { CredentialBindings } from '../runtime/credential-binding.ts';
import { assertPrivatePermissions, assertPublicPermissions, makePublicPermissions } from './platform-test-helpers.ts';

test('concurrent processes publish one private binding key and reopening preserves opaque references', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'athena-binding-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const helper = new URL('../runtime/credential-binding.ts', import.meta.url).href;
  const sdk = new URL('../node_modules/@earendil-works/pi-ai/dist/index.js', import.meta.url).href;
  const program = `import {CredentialBindings} from ${JSON.stringify(helper)};
    import {InMemoryCredentialStore} from ${JSON.stringify(sdk)};
    console.log(await new CredentialBindings(new InMemoryCredentialStore(), process.argv[1]).bind('test', {key:'binding-fixture-secret'}));`;
  const references = await Promise.all(Array.from({ length: 3 }, async () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', program, directory], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', error = '';
    child.stdout.setEncoding('utf8').on('data', value => { output += value; });
    child.stderr.setEncoding('utf8').on('data', value => { error += value; });
    const [code] = await once(child, 'close'); assert.equal(code, 0, error);
    return output.trim();
  }));
  assert.equal(new Set(references).size, 1);
  assert.match(references[0]!, /^credential:v1:[a-f0-9]{64}$/u);
  const reopened = new CredentialBindings(new InMemoryCredentialStore(), directory);
  assert.equal(await reopened.bind('test', { key: 'binding-fixture-secret' }), references[0]);
  assert.notEqual(await reopened.bind('other', { key: 'binding-fixture-secret' }), references[0]);
  const path = join(directory, 'provider-bindings', 'key.v1');
  const key = (await readFile(path, 'utf8')).trim();
  await assertPrivatePermissions(path, 0o600);
  await assertPrivatePermissions(join(directory, 'provider-bindings'), 0o700);
  assert.equal(key.includes('binding-fixture-secret'), false);
  assert.equal(references[0]!.includes(key), false);
  assert.equal(references[0]!.includes('binding-fixture-secret'), false);
});

test('damaged or unsafe binding keys fail closed without replacing the existing file', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'athena-binding-invalid-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bind = () => new CredentialBindings(new InMemoryCredentialStore(), directory).bind('test', { key: 'fixture' });
  await bind();
  const path = join(directory, 'provider-bindings', 'key.v1');
  const saved = await readFile(path);
  await writeFile(path, 'damaged\n');
  await assert.rejects(bind(), { code: 'VAULT_INVALID' });
  assert.equal(await readFile(path, 'utf8'), 'damaged\n');
  await writeFile(path, saved); await makePublicPermissions(path);
  await assert.rejects(bind(), { code: 'VAULT_INVALID' });
  assert.deepEqual(await readFile(path), saved);
  await assertPublicPermissions(path);
});

test('memory-only bindings belong to the credential-store object and cannot imply durable identity', async () => {
  const store = new InMemoryCredentialStore();
  const one = await new CredentialBindings(store).bind('test', { key: 'fixture' });
  assert.equal(await new CredentialBindings(store).bind('test', { key: 'fixture' }), one);
  assert.notEqual(await new CredentialBindings(new InMemoryCredentialStore()).bind('test', { key: 'fixture' }), one);
});
