import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPrivateDirectory, windowsPowerShellEnvironment, windowsStorageEnvironment, windowsStorageRoot, writeNewPrivateFileSync } from '../runtime/private-storage.ts';
import { assertPrivatePermissions, assertPublicPermissions, makePublicPermissions } from './platform-test-helpers.ts';

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

test('Windows storage walks start after the complete drive or UNC share root', () => {
  for (const [path, root] of [
    [String.raw`C:\Users\fixture\private`, 'C:\\'],
    [String.raw`\\?\C:\Users\fixture\private`, '\\\\?\\C:\\'],
    [String.raw`\\server\share\fixture\private`, '\\\\server\\share\\'],
    [String.raw`\\?\UNC\server\share\fixture\private`, '\\\\?\\UNC\\server\\share\\'],
    [String.raw`\\?\unc\server\share`, '\\\\?\\unc\\server\\share\\'],
  ] as const) {
    assert.equal(windowsStorageRoot(path), root);
    assert.equal(win32.isAbsolute(root), true);
  }
});

test('private directory creation secures every new level on its first attempt', async t => {
  const root = await fixture(t);
  const first = join(root, 'private');
  const second = join(first, 'nested');
  const last = join(second, 'storage');
  // Do not retry: a second attempt can conceal a partially initialized tree.
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

test('Windows processes can concurrently initialize private directories and their shared empty lock',
  { skip: process.platform !== 'win32' ? 'Atomic security descriptors require native Windows.' : false, timeout: 30_000 }, async t => {
    // Deliberately retain the ordinary temporary parent's inherited permissions.
    // Every newly published child must already have its own private descriptor.
    const root = await mkdtemp(join(tmpdir(), 'athena-private-race-'));
    const directory = join(root, 'private');
    const children: ChildProcess[] = [];
    const completions: Promise<{ code: number | null; error: string }>[] = [];
    t.after(async () => {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
      await Promise.allSettled(completions);
      await rm(root, { recursive: true, force: true });
    });
    const files = new URL('../runtime/local-credential-files.ts', import.meta.url).href;
    const privateStorage = new URL('../runtime/private-storage.ts', import.meta.url).href;
    const program = `import { once } from 'node:events';
      import { join } from 'node:path';
      import { prepareCredentialDirectory, ensureCredentialLockFile, requireCredentialLockFile } from ${JSON.stringify(files)};
      import { createPrivateDirectory } from ${JSON.stringify(privateStorage)};
      const ready = once(process, 'message'); process.send('ready'); await ready;
      const directory = await prepareCredentialDirectory(process.argv[1]);
      const nested = join(directory, 'nested'); createPrivateDirectory(nested);
      const lock = join(nested, '.lock.sqlite');
      await ensureCredentialLockFile(lock); await requireCredentialLockFile(lock);
      process.disconnect();`;
    const ready = Array.from({ length: 4 }, () => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', program, directory],
        { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
      children.push(child);
      let error = '';
      child.stderr!.setEncoding('utf8').on('data', value => { error += value; });
      completions.push(new Promise(resolve => { child.once('close', code => { resolve({ code, error }); }); }));
      return new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('message', value => { if (value === 'ready') resolve(); else reject(new Error('Unexpected child readiness marker.')); });
        child.once('close', code => { reject(new Error(`Private storage child exited before readiness: ${code}; ${error}`)); });
      });
    });
    await Promise.all(ready);
    for (const child of children) child.send('start');
    for (const result of await Promise.all(completions)) assert.equal(result.code, 0, result.error);
    await assertPrivatePermissions(directory, 0o700);
    await assertPrivatePermissions(join(directory, 'nested'), 0o700);
    await assertPrivatePermissions(join(directory, 'nested', '.lock.sqlite'), 0o600);
    assert.equal((await readFile(join(directory, 'nested', '.lock.sqlite'))).length, 0);
  });

test('Windows atomic creators never repair existing unsafe objects or follow a reparse parent',
  { skip: process.platform !== 'win32' ? 'Atomic security descriptors require native Windows.' : false }, async t => {
    const root = await fixture(t);
    const directory = join(root, 'private');
    createPrivateDirectory(directory);
    const lock = join(directory, '.lock.sqlite');
    writeNewPrivateFileSync(lock, '');
    const nonempty = join(directory, 'nonempty.sqlite');
    writeNewPrivateFileSync(nonempty, 'keep these bytes');
    const executable = fileURLToPath(new URL('../runtime/windows-private-storage.exe', import.meta.url));
    const run = (operation: string, path: string) => spawnSync(executable, [operation], {
      input: path, encoding: 'utf8', timeout: 15_000, windowsHide: true, env: windowsStorageEnvironment(),
    });
    await makePublicPermissions(lock);
    await makePublicPermissions(directory, 0o755);
    for (const [operation, path] of [['create-directory', directory], ['create-lock', lock]] as const) {
      const result = run(operation, path);
      assert.equal(result.status, 1); assert.equal(result.stdout, '');
      assert.equal(result.stderr, 'ATHENA_PRIVATE_STORAGE_REJECTED:external_access');
    }
    await assertPublicPermissions(directory, 0o755);
    await assertPublicPermissions(lock);
    assert.equal((await readFile(lock)).length, 0);
    const occupied = run('create-lock', nonempty);
    assert.equal(occupied.status, 1); assert.equal(occupied.stdout, '');
    assert.equal(await readFile(nonempty, 'utf8'), 'keep these bytes');
    const junction = join(root, 'junction');
    await symlink(directory, junction, 'junction');
    for (const operation of ['create-directory', 'create-lock']) {
      const result = run(operation, join(junction, `must-not-create-${operation}`));
      assert.equal(result.status, 1); assert.equal(result.stdout, '');
      assert.equal(result.stderr, 'ATHENA_PRIVATE_STORAGE_REJECTED:reparse_point');
    }
    assert.deepEqual((await readdir(directory)).sort(), ['.lock.sqlite', 'nonempty.sqlite']);
    await assertPublicPermissions(directory, 0o755);
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
