import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createPrivateDirectory, windowsPowerShellEnvironment } from '../runtime/private-storage.ts';
import { assertPrivatePermissions, makePublicPermissions } from './platform-test-helpers.ts';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'athena-private-directories-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('fixed Windows PowerShell cannot inherit a different edition or user module path', () => {
  const executable = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
  const inherited = {
    SystemRoot: String.raw`C:\Windows`, PATH: 'fixture-system-path',
    PSModulePath: String.raw`C:\Program Files\PowerShell\7\Modules`,
    psmodulepath: String.raw`C:\Users\fixture\Documents\PowerShell\Modules`,
  };
  const before = { ...inherited };
  const environment = windowsPowerShellEnvironment(executable, inherited);
  assert.deepEqual(Object.keys(environment).filter(key => key.toUpperCase() === 'PSMODULEPATH'), ['PSModulePath']);
  assert.equal(environment.PSModulePath, String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\Modules`);
  assert.equal(environment.SystemRoot, inherited.SystemRoot);
  assert.equal(environment.PATH, inherited.PATH);
  assert.deepEqual(inherited, before);
});

test('private directory creation secures every new level on its first attempt', async t => {
  const root = await fixture(t);
  const first = join(root, 'private');
  const second = join(first, 'nested');
  const last = join(second, 'storage');
  // On Windows, recursive mkdir returns a namespaced first-created path even
  // though the requested path has an ordinary drive root. Do not retry here:
  // repeated attempts could hide a failure after only one level was protected.
  createPrivateDirectory(last);
  for (const path of [first, second, last]) await assertPrivatePermissions(path, 0o700);
  assert.deepEqual(await readdir(root), ['private']);
  createPrivateDirectory(last);
});

test('private directory validation rejects changed access without repairing it', async t => {
  const directory = join(await fixture(t), 'private');
  createPrivateDirectory(directory);
  await makePublicPermissions(directory, 0o755);
  assert.throws(() => createPrivateDirectory(directory), /private storage/);
  await assert.rejects(assertPrivatePermissions(directory, 0o700));
});

test('an explicitly namespaced Windows storage path protects the same new directory',
  { skip: process.platform !== 'win32' ? 'Windows namespace paths require a Windows filesystem.' : false }, async t => {
    const root = await fixture(t);
    const directory = join(root, 'private');
    createPrivateDirectory(win32.toNamespacedPath(directory));
    await assertPrivatePermissions(directory, 0o700);
    assert.deepEqual(await readdir(root), ['private']);
  });
