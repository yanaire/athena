import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (process.platform !== 'win32') throw new Error('This synthetic probe requires Windows.');
const storageURL = pathToFileURL(resolve('runtime/private-storage.ts')).href;
const desktopURL = pathToFileURL(resolve('runtime/desktop-host.ts')).href;
const helpers = await import(pathToFileURL(resolve('tests/platform-test-helpers.ts')).href);
const root = await mkdtemp(join(tmpdir(), 'athena-isolated-acl-probe-'));
await helpers.restorePrivatePermissions(root, 0o700);

const program = `
  const root = process.argv[1];
  const storage = await import(process.argv[2]);
  const desktop = await import(process.argv[3]);
  function failure(error) {
    return { name: error?.name, code: error?.code, errno: error?.errno,
      status: error?.status, signal: error?.signal, killed: error?.killed,
      message: String(error?.message ?? '').startsWith('Command failed:') ? 'Command failed (encoded script omitted)' : String(error?.message ?? '').slice(0,500),
      stdout: error?.stdout?.toString().slice(0,3500), stderr: error?.stderr?.toString().slice(0,3500) };
  }
  for (const [stage, action] of [
    ['direct-acl', () => storage.assertWindowsPrivate(root)],
    ['server-directory', () => storage.createPrivateDirectory(root)],
    ['workspace-lock', () => { const lock = desktop.lockWorkspace(root, true); lock.close(); }],
  ]) {
    const started = performance.now();
    try { action(); console.log(JSON.stringify({ stage, ok: true, durationMs: performance.now() - started })); }
    catch (error) { console.log(JSON.stringify({ stage, ok: false, durationMs: performance.now() - started, error: failure(error) })); process.exitCode = 1; break; }
  }
`;

try {
  const minimal = { ...helpers.systemEnvironment(), HOME: root, USERPROFILE: root,
    ATHENA_DATA_DIR: root, ATHENA_PORT: 'not-a-port' };
  const roaming = join(root, 'AppData', 'Roaming');
  const local = join(root, 'AppData', 'Local');
  await mkdir(roaming, { recursive: true });
  await mkdir(local, { recursive: true });
  for (const [variant, environment] of [
    ['fixture-minimal', minimal],
    ['inherited-os-control', { ...process.env, HOME: root, USERPROFILE: root, ATHENA_DATA_DIR: root }],
    ['isolated-appdata', { ...minimal, APPDATA: roaming, LOCALAPPDATA: local }],
  ]) {
    console.log(JSON.stringify({ variant, suppliedOSKeys: ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'PSModulePath']
      .filter(key => environment[key] !== undefined) }));
    const started = performance.now();
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', program, root, storageURL, desktopURL],
      { cwd: root, env: environment, encoding: 'utf8', timeout: 50_000, windowsHide: true, maxBuffer: 64 * 1024 });
    console.log(JSON.stringify({ variant, status: result.status, signal: result.signal,
      durationMs: performance.now() - started, spawnError: result.error && { name: result.error.name, code: result.error.code },
      stdout: result.stdout, stderr: result.stderr }));
  }
} finally { await rm(root, { recursive: true, force: true }); }
