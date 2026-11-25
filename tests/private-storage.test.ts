import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPrivateDirectory, windowsPowerShellEnvironment, windowsStorageEnvironment, writeNewPrivateFileSync } from '../runtime/private-storage.ts';
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

test('the native storage helper receives only OS locations, with case-insensitive environment keys', () => {
  const inherited = { systemroot: String.raw`C:\Windows`, temp: String.raw`C:\Temp`,
    USERPROFILE: String.raw`C:\Users\fixture`, PATH: String.raw`C:\untrusted`,
    COR_ENABLE_PROFILING: '1', COR_PROFILER_PATH: 'untrusted.dll', NODE_OPTIONS: '--inspect',
    OPENAI_API_KEY: 'synthetic-not-a-secret', PSModulePath: String.raw`C:\user-modules` };
  const before = { ...inherited };
  assert.deepEqual(windowsStorageEnvironment(inherited), {
    SystemRoot: String.raw`C:\Windows`, TEMP: String.raw`C:\Temp`, USERPROFILE: String.raw`C:\Users\fixture`,
    PATH: String.raw`C:\Windows\System32`,
  });
  assert.deepEqual(inherited, before);
  assert.throws(() => windowsStorageEnvironment({ SystemRoot: 'relative' }), /system directory/);
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

test('new private files have the current owner and retain their requested mutable or immutable mode', async t => {
  const directory = join(await fixture(t), 'private');
  createPrivateDirectory(directory);
  for (const mode of [0o600, 0o400]) {
    const path = join(directory, `${mode}.txt`);
    writeNewPrivateFileSync(path, 'synthetic private content', { mode, flush: true });
    await assertPrivatePermissions(path, mode);
    assert.equal(await readFile(path, 'utf8'), 'synthetic private content');
    assert.throws(() => writeNewPrivateFileSync(path, 'replacement'), { code: 'EEXIST' });
    assert.equal(await readFile(path, 'utf8'), 'synthetic private content');
  }
});

test('creating a private file never repairs or replaces an existing unsafe file', async t => {
  const directory = join(await fixture(t), 'private');
  createPrivateDirectory(directory);
  const path = join(directory, 'existing.txt');
  writeNewPrivateFileSync(path, 'original');
  await makePublicPermissions(path);
  assert.throws(() => writeNewPrivateFileSync(path, 'replacement'), { code: 'EEXIST' });
  assert.equal(await readFile(path, 'utf8'), 'original');
  await assert.rejects(assertPrivatePermissions(path, 0o600));
});

test('an explicitly namespaced Windows storage path protects the same new directory',
  { skip: process.platform !== 'win32' ? 'Windows namespace paths require a Windows filesystem.' : false }, async t => {
    const root = await fixture(t);
    const directory = join(root, 'private');
    createPrivateDirectory(win32.toNamespacedPath(directory));
    await assertPrivatePermissions(directory, 0o700);
    assert.deepEqual(await readdir(root), ['private']);
  });

test('the fixed Windows helper checks fresh ACLs under restricted desktop environments and rejects ambiguous input',
  { skip: process.platform !== 'win32' ? 'The managed ACL helper requires native Windows.' : false }, async t => {
    const root = await fixture(t);
    const directory = join(root, 'private');
    createPrivateDirectory(directory);
    const executable = fileURLToPath(new URL('../runtime/windows-private-storage.exe', import.meta.url));
    const minimal = windowsStorageEnvironment({ ...process.env, USERPROFILE: root });
    delete minimal.APPDATA; delete minimal.LOCALAPPDATA;
    const environments = [minimal, { ...minimal, APPDATA: join(root, 'AppData', 'Roaming'),
      LOCALAPPDATA: join(root, 'AppData', 'Local') }];
    for (const env of environments) {
      assert.equal(execFileSync(executable, ['--version'], { env, encoding: 'utf8', timeout: 15_000, windowsHide: true }),
        'athena-windows-private-storage/1 .NETFramework/4.8');
      for (const input of [directory, win32.toNamespacedPath(directory)]) {
        assert.equal(execFileSync(executable, ['check'], { env, input, encoding: 'utf8', timeout: 15_000, windowsHide: true }),
          'ATHENA_PRIVATE_STORAGE_OK');
      }
    }
    for (const [operation, input] of [['check', 'C:relative'], ['check', '\\relative'], ['check', 'x'.repeat(32768)],
      ['check', String.raw`\\?\C:relative`], ['check', directory + '\0suffix'], ['unknown', directory]] as const) {
      const result = spawnSync(executable, [operation], { env: minimal, input, encoding: 'utf8', timeout: 15_000, windowsHide: true });
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /^ATHENA_PRIVATE_STORAGE_REJECTED:invalid_(?:path|operation)$/);
    }
    await makePublicPermissions(directory, 0o755);
    const changed = spawnSync(executable, ['check'], { env: minimal, input: directory, encoding: 'utf8', timeout: 15_000, windowsHide: true });
    assert.equal(changed.status, 1);
    assert.equal(changed.stdout, '');
    assert.equal(changed.stderr, 'ATHENA_PRIVATE_STORAGE_REJECTED:external_access');
    await assert.rejects(assertPrivatePermissions(directory, 0o700));
    const junction = join(root, 'junction');
    await symlink(directory, junction, 'junction');
    for (const operation of ['check', 'protect']) {
      const linked = spawnSync(executable, [operation], { env: minimal, input: junction, encoding: 'utf8', timeout: 15_000, windowsHide: true });
      assert.equal(linked.status, 1);
      assert.equal(linked.stdout, '');
      assert.equal(linked.stderr, 'ATHENA_PRIVATE_STORAGE_REJECTED:reparse_point');
    }
    // A failed protect request must not silently repair the junction's target.
    await assert.rejects(assertPrivatePermissions(directory, 0o700));
  });
