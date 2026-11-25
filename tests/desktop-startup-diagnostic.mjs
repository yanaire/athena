// Diagnostic branch only: run on Windows with synthetic, newly created roots.
// Do not include this script in the integration or product branch.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { assertPrivatePermissions, restorePrivatePermissions, systemEnvironment } from './platform-test-helpers.ts';

if (process.platform !== 'win32') throw new Error('This diagnostic requires a native Windows runner.');

const privateStorage = new URL('../runtime/private-storage.ts', import.meta.url).href;
const desktopHost = new URL('../runtime/desktop-host.ts', import.meta.url).href;
const prohibitKeychain = `import cp from 'node:child_process';
  import { syncBuiltinESMExports } from 'node:module';
  const original = cp.execFile;
  cp.execFile = function(file, ...args) {
    if (file === '/usr/bin/security') process.exit(84);
    return original.call(this, file, ...args);
  };
  syncBuiltinESMExports();`;

const source = `
  import { performance } from 'node:perf_hooks';
  import { assertWindowsPrivate, createPrivateDirectory } from ${JSON.stringify(privateStorage)};
  import { lockWorkspace } from ${JSON.stringify(desktopHost)};
  const root = process.argv[1];
  function errorDetails(error, depth = 0) {
    if (!error || typeof error !== 'object' || depth > 3) return String(error);
    const message = String(error.message ?? '');
    return {
      name: error.name,
      message: message.startsWith('Command failed:') ? 'The fixed private-storage PowerShell command failed.' : message,
      code: error.code, status: error.status, signal: error.signal,
      stdout: error.stdout == null ? undefined : String(error.stdout).slice(0, 16000),
      stderr: error.stderr == null ? undefined : String(error.stderr).slice(0, 16000),
      cause: error.cause ? errorDetails(error.cause, depth + 1) : undefined,
    };
  }
  for (const [name, action] of [
    ['assertWindowsPrivate', () => assertWindowsPrivate(root)],
    ['createPrivateDirectory', () => createPrivateDirectory(root)],
    ['lockWorkspace', () => { const lock = lockWorkspace(root, true); lock.close(); }],
  ]) {
    const started = performance.now();
    try { action(); console.log(JSON.stringify({name, result: 'passed', ms: performance.now() - started})); }
    catch (error) { console.log(JSON.stringify({name, result: 'failed', ms: performance.now() - started, error: errorDetails(error)})); }
  }
  process.stdin.destroy();
`;

const variants = ['inherited', 'inherited-fixture-home', 'isolated', 'isolated-keychain-mock', 'isolated-windows-cache'];
for (const variant of variants) {
  const directory = await mkdtemp(join(tmpdir(), 'athena-desktop-diagnostic-'));
  try {
    // Establish the same private-root precondition independently before testing
    // the launch environment. No existing user directory is repaired.
    await restorePrivatePermissions(directory, 0o700);
    await assertPrivatePermissions(directory, 0o700);
    const isolated = variant.startsWith('isolated');
    const env = isolated ? systemEnvironment() : { ...process.env };
    if (variant !== 'inherited') { env.HOME = directory; env.USERPROFILE = directory; }
    env.ATHENA_DATA_DIR = directory;
    env.ATHENA_PORT = 'not-a-port';
    if (variant === 'isolated-keychain-mock' || variant === 'isolated-windows-cache') {
      env.NODE_OPTIONS = '--import=data:text/javascript,' + encodeURIComponent(prohibitKeychain);
    }
    if (variant === 'isolated-windows-cache') {
      for (const key of ['APPDATA', 'LOCALAPPDATA']) {
        if (process.env[key] !== undefined) env[key] = process.env[key];
      }
    }
    console.log(JSON.stringify({case: variant, phase: 'starting', protectedSyntheticRoot: true}));
    const started = performance.now();
    // Deliberately keep stdin open until the probe exits, matching launch().
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, directory], {
      cwd: directory, env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', spawnError;
    let timedOut = false;
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', error => { spawnError = {name: error.name, code: error.code, message: error.message}; });
    const deadline = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 60_000);
    try {
      const result = await new Promise(resolve => child.once('close', (code, signal) => resolve({code, signal})));
      for (const line of stdout.trim().split('\n').filter(Boolean)) {
        try { console.log(JSON.stringify({case: variant, ...JSON.parse(line)})); }
        catch { console.log(JSON.stringify({case: variant, unexpectedOutput: line.slice(0, 2000)})); }
      }
      console.log(JSON.stringify({case: variant, phase: 'finished', ...result, timedOut,
        ms: performance.now() - started, spawnError, stderr: stderr.slice(0, 16000)}));
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      child.stdin.destroy();
    }
  } finally { await rm(directory, {recursive: true, force: true}); }
}
