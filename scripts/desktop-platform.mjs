import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, win32 } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const NODE_VERSION = '24.22.3';

// Pinned upstream checksums, verified against:
// https://nodejs.org/dist/v24.22.3/SHASUMS256.txt
const platforms = Object.freeze({
  'darwin-arm64': {
    target: 'aarch64-apple-darwin', exe: '', bundle: 'app',
    archiveSha256: 'ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd',
  },
  'darwin-x64': {
    target: 'x86_64-apple-darwin', exe: '', bundle: 'app',
    archiveSha256: '977614af0504c81045e7fd85596dbca0e5f951b96681516dadafedcca8c447f7',
  },
  'win32-x64': {
    target: 'x86_64-pc-windows-msvc', exe: '.exe', bundle: 'nsis',
    archiveSha256: 'e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f',
  },
});

export function resolveDesktopPlatform({ platform = process.platform, arch = process.arch,
  target = process.env.TAURI_ENV_TARGET_TRIPLE ?? process.env.ATHENA_DESKTOP_TARGET } = {}) {
  const selected = platforms[`${platform}-${arch}`];
  if (!selected) throw new Error('Athena desktop requires native macOS arm64/x64 or Windows x64 Node.js.');
  if (target && target !== selected.target) {
    throw new Error(`Desktop target ${target} does not match this ${platform}/${arch} build host (${selected.target}). Use a native runner for that target.`);
  }
  const release = `node-v${NODE_VERSION}-${platform === 'win32' ? 'win' : platform}-${arch}`;
  const archive = `${release}.${platform === 'win32' ? 'zip' : 'tar.gz'}`;
  return Object.freeze({ ...selected, platform, arch, version: NODE_VERSION, release, archive,
    nodeInArchive: `${release}/${platform === 'win32' ? 'node.exe' : 'bin/node'}`,
    url: `https://nodejs.org/dist/v${NODE_VERSION}/${archive}` });
}

// Shell-free tool invocation works from PowerShell, cmd and Unix shells, even
// when a user account or checkout path contains spaces.
export function buildEnvironment(environment = process.env) {
  const key = Object.keys(environment).find(name => name.toLowerCase() === 'path') ?? 'PATH';
  return { ...environment, [key]: [join(homedir(), '.cargo', 'bin'), environment[key] ?? ''].join(delimiter) };
}

export function runNpm(args, { cwd, env = buildEnvironment(), ...options } = {}) {
  const candidate = process.env.npm_execpath;
  const cli = candidate && isAbsolute(candidate) && existsSync(candidate) ? candidate
    : join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(cli)) return execFileSync(process.execPath, [cli, ...args], { cwd, env, ...options });
  if (process.platform === 'win32') throw new Error('Run desktop preparation through npm run desktop:prepare so npm-cli.js can be located safely.');
  return execFileSync('npm', args, { cwd, env, ...options });
}

export function isolatedRuntimeEnvironment(home, environment = process.env, platform = process.platform) {
  if (platform !== 'win32') return { PATH: '/usr/bin:/bin', HOME: home };
  // Preserve only Windows loader/OS locations, never Node or provider overrides.
  const result = {};
  for (const name of ['SystemRoot', 'WINDIR', 'SystemDrive', 'COMSPEC', 'TEMP', 'TMP']) {
    const key = Object.keys(environment).find(key => key.toLowerCase() === name.toLowerCase());
    if (key) result[name] = environment[key];
  }
  const windows = result.SystemRoot ?? result.WINDIR;
  if (!windows || !win32.isAbsolute(windows)) throw new Error('A Windows system directory is required to verify the bundled runtime.');
  return { ...result, PATH: [win32.join(windows, 'System32'), windows].join(';'),
    HOME: home, USERPROFILE: home, APPDATA: win32.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: win32.join(home, 'AppData', 'Local') };
}

export function macOSImageAttachment(images, path, mount, mountedHere) {
  const entries = images.filter(entry => entry['image-path'] === path);
  if (entries.length === 0 && !mountedHere) return { state: 'detached' };
  const entities = entries[0]?.['system-entities'];
  if (entries.length !== 1 || !Array.isArray(entities)) return { state: 'ambiguous' };
  const mounted = entities.filter(entity => entity['mount-point']);
  if (mountedHere ? mounted.length !== 1 || mounted[0]['mount-point'] !== mount : mounted.length !== 0) {
    return { state: 'ambiguous' };
  }

  // A detached filesystem can leave its backing GPT disk and HFS partition registered.
  const whole = entities.filter(entity => entity['content-hint'] === 'GUID_partition_scheme'
    && /^\/dev\/disk\d+$/.test(entity['dev-entry']));
  if (whole.length !== 1) return { state: 'ambiguous' };
  const device = whole[0]['dev-entry'];
  const partitions = (mountedHere ? mounted : entities).filter(entity => {
    const name = entity['dev-entry'];
    return typeof name === 'string' && name.startsWith(`${device}s`) && /^\d+$/.test(name.slice(device.length + 1));
  });
  if (partitions.length !== 1) return { state: 'ambiguous' };
  return { state: mountedHere ? 'mounted' : 'unmounted', device, partition: partitions[0]['dev-entry'] };
}

export function macOSEjectTarget(attachment, ownership) {
  if (attachment.state === 'detached') return attachment;
  if (ownership && attachment.device === ownership.device && attachment.partition === ownership.partition) {
    return { ...attachment, target: ownership.uuid };
  }
  return { state: 'ambiguous' };
}

export const MACOS_IMAGE_EJECT_ATTEMPTS = 4;

// Packaging owns these CLI children. Stop a timed-out child even if it handles
// SIGTERM; disk-image ownership and detachment still need separate verification.
export function runPackagingCommand(command, args, { timeout, ...options } = {}) {
  if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new TypeError('Packaging commands require a positive timeout.');
  return execFileSync(command, args, { ...options, timeout, killSignal: 'SIGKILL' });
}

export async function detachMacOSImage(readAttachment, eject, attempts = MACOS_IMAGE_EJECT_ATTEMPTS,
  waitForAttachment = milliseconds => delay(milliseconds), now = () => performance.now()) {
  const failures = [];
  let attachment = readAttachment();
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attachment.state === 'detached') break;
    // Recheck ownership immediately before another eject command.
    if (attempt > 0) attachment = readAttachment();
    if (!attachment.target) break;
    try { eject(attachment.target); }
    catch (error) { failures.push(error); }
    const deadline = now() + 10_000;
    attachment = readAttachment();
    // Disk Arbitration can still be settling when the owned image is recognized
    // as attached, as well as when the registry and mount table disagree.
    for (let probe = 0; attachment.state !== 'detached' && probe < 10; probe += 1) {
      const remaining = deadline - now();
      if (remaining <= 0) break;
      await waitForAttachment(Math.min(1_000, remaining));
      if (now() >= deadline) break;
      attachment = readAttachment();
    }
  }
  if (attachment.state !== 'detached') {
    throw new AggregateError(failures, 'The scratch disk image is still attached or its mount cannot be confirmed.');
  }
}
