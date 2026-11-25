import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { isolatedRuntimeEnvironment, resolveDesktopPlatform } from './desktop-platform.mjs';

const exec = promisify(execFile);
const { platform, arch } = resolveDesktopPlatform();
const macOS = platform === 'darwin';
const [bundle, ...extra] = process.argv.slice(2);
assert.ok(bundle && extra.length === 0, 'Usage: node scripts/smoke-installed-desktop.mjs <Athena.app or installed NSIS directory>');
// Tauri rejects executable paths containing symlink components on macOS.
const installation = macOS ? await realpath(bundle) : bundle;
const application = resolve(installation, macOS ? 'Contents/MacOS/athena-desktop' : 'athena-desktop.exe');
assert.ok(existsSync(application), 'The installed desktop executable is missing.');

const powershell = command => exec('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], { timeout: 8000 });
async function probe(pid) {
  if (!macOS) {
    const { stdout } = await powershell(`
      $backend = Get-CimInstance Win32_Process -Filter "ParentProcessId = ${pid} AND Name = 'athena-node.exe'" -ErrorAction Stop
      $webview = Get-CimInstance Win32_Process -Filter "ParentProcessId = ${pid} AND Name = 'msedgewebview2.exe'" -ErrorAction Stop | Select-Object -First 1
      if (-not $backend -or -not $webview.ExecutablePath) { return }
      $tcp = @(Get-NetTCPConnection -OwningProcess $backend.ProcessId -LocalAddress '127.0.0.1' -ErrorAction SilentlyContinue)
      $ports = @($tcp | Where-Object State -eq 'Listen' | ForEach-Object LocalPort)
      $connections = @($tcp | Where-Object { $_.State -eq 'Established' -and $_.RemoteAddress -eq '127.0.0.1' -and $_.LocalPort -in $ports } | ForEach-Object { "$($_.LocalPort):$($_.RemotePort)" })
      @{ pid = $backend.ProcessId; webview = (Get-Item -LiteralPath $webview.ExecutablePath).VersionInfo.ProductVersion; connections = $connections } | ConvertTo-Json -Compress
    `);
    return stdout.trim() ? JSON.parse(stdout) : undefined;
  }

  const { stdout } = await exec('/bin/ps', ['-axww', '-o', 'pid=,ppid=,comm='], { timeout: 8000 });
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match || Number(match[2]) !== pid || basename(match[3]) !== 'athena-node') continue;
    const sidecarPid = Number(match[1]);
    const { stdout: sockets } = await exec('/usr/sbin/lsof', ['-nP', '-a', '-p', match[1], '-iTCP', '-Fn'], { timeout: 8000 })
      .catch(error => { if (error.code === 1 && !error.stderr) return { stdout: '' }; throw error; });
    const listeners = new Set([...sockets.matchAll(/^n(127\.0\.0\.1:\d+)$/gm)].map(entry => entry[1]));
    const connections = [...sockets.matchAll(/^n(127\.0\.0\.1:\d+)->(127\.0\.0\.1:\d+)$/gm)]
      .filter(entry => listeners.has(entry[1])).map(entry => entry[0]);
    return { pid: sidecarPid, webview: 'WKWebView', connections };
  }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function waitFor(check, milliseconds, description) {
  const deadline = performance.now() + milliseconds;
  do {
    const result = await check();
    if (result) return result;
    await delay(500);
  } while (performance.now() < deadline);
  throw new Error(`Timed out waiting for ${description}.`);
}

async function closeWindow(pid) {
  if (!macOS) {
    await powershell(`if (-not (Get-Process -Id ${pid} -ErrorAction Stop).CloseMainWindow()) { throw 'Could not close Athena desktop window.' }`);
    return;
  }
  await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `function run(args) {
    ObjC.import('AppKit');
    const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(args[0]));
    if (!app.terminate) throw new Error('Could not quit Athena desktop.');
  }`, String(pid)], { timeout: 8000 });
}

const home = await mkdtemp(join(await realpath(tmpdir()), 'athena-installed-smoke-'));
const workspace = join(home, 'isolated workspace');
let desktop;
let exit;
let launchError;
let sidecarPid;
try {
  await mkdir(join(home, 'Downloads'));
  desktop = spawn(application, [], { cwd: home, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...isolatedRuntimeEnvironment(home), ATHENA_DATA_DIR: workspace } });
  desktop.once('error', error => { launchError = error; });
  desktop.once('exit', (code, signal) => { exit = { code, signal }; });
  const firstSeen = new Map();
  const ready = await waitFor(async () => {
    if (launchError) throw launchError;
    assert.ok(!exit, 'Installed desktop exited before connecting to its workspace.');
    const state = await probe(desktop.pid);
    if (!state) { firstSeen.clear(); return; }
    sidecarPid = state.pid;
    const now = performance.now();
    for (const socket of firstSeen.keys()) if (!state.connections.includes(socket)) firstSeen.delete(socket);
    for (const socket of state.connections) {
      if (!firstSeen.has(socket)) firstSeen.set(socket, now);
      // The authenticated UI keeps its event stream open past HTTP keep-alive.
      if (now - firstSeen.get(socket) >= 8000 && existsSync(join(workspace, 'workspace.sqlite'))) return state;
    }
  }, 85000, 'the native WebView to sustain a connection to the isolated workspace');
  await closeWindow(desktop.pid);
  const closed = await waitFor(() => exit, 18000, 'the installed desktop to quit');
  assert.deepEqual(closed, { code: 0, signal: null }, 'Installed desktop quit with an error.');
  await waitFor(() => !alive(sidecarPid), 10000, 'the installed desktop sidecar to stop');
  console.log(`Installed desktop startup and shutdown verified (${platform} ${arch}, ${macOS ? ready.webview : `WebView2 ${ready.webview}`}).`);
} finally {
  if (desktop?.pid && !exit) {
    desktop.kill('SIGKILL');
    await waitFor(() => exit, 10000, 'the smoke-test desktop process to stop');
  }
  if (sidecarPid) await waitFor(() => !alive(sidecarPid), 12000, 'the smoke-test sidecar to stop');
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
