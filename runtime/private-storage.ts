import { execFileSync } from 'node:child_process';
import { closeSync, constants, lstatSync, mkdirSync, openSync, rmSync, writeFileSync, type Stats } from 'node:fs';
import { isAbsolute, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

export function windowsPowerShell(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot || !win32.isAbsolute(systemRoot)) throw new Error('Windows system directory is unavailable.');
  return win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export function windowsPowerShellEnvironment(executable = windowsPowerShell(), environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // PowerShell 7 exports its own PSModulePath to child processes. Windows
  // PowerShell 5.1 cannot load those modules; provide its compatible OS module
  // path instead of the inherited list. PowerShell controls its startup paths.
  // Remove every casing so Windows' case-insensitive environment cannot select
  // an inherited duplicate instead of the value below.
  const inherited = Object.fromEntries(Object.entries(environment).filter(([key]) => key.toUpperCase() !== 'PSMODULEPATH'));
  return { ...inherited, PSModulePath: win32.join(win32.dirname(executable), 'Modules') };
}

export function windowsStorageEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // The fixed helper needs OS loader/profile locations, not CLR profiling hooks,
  // Node options, provider secrets, or PowerShell module discovery settings.
  const result: NodeJS.ProcessEnv = {};
  for (const name of ['SystemRoot', 'WINDIR', 'SystemDrive', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
    const key = Object.keys(environment).find(key => key.toUpperCase() === name.toUpperCase());
    if (key) result[name] = environment[key];
  }
  const systemRoot = result.SystemRoot ?? result.WINDIR;
  if (!systemRoot || !win32.isAbsolute(systemRoot)) throw new Error('Windows system directory is unavailable.');
  result.PATH = win32.join(systemRoot, 'System32');
  return result;
}

function windowsAcl(path: string, operation: 'check' | 'protect' | 'create-directory' | 'create-lock'): void {
  if (process.platform !== 'win32') throw new Error('Windows ACL operations require Windows.');
  if (!isAbsolute(path) || path.includes('\0') || path.length > 32767) throw new Error('Expected an absolute storage path.');
  const executable = fileURLToPath(new URL('./windows-private-storage.exe', import.meta.url));
  for (const asset of [executable, `${executable}.config`]) {
    let info: Stats;
    try { info = lstatSync(asset); }
    catch (error) {
      throw new Error('The Windows private-storage helper is missing. Run npm run windows:prepare before starting a source checkout.', { cause: error });
    }
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('The fixed Windows private-storage helper is invalid.');
  }
  // A fresh OS descriptor is checked on every call. The helper has no cache and
  // accepts only one fixed operation plus a bounded data-only path on stdin.
  const response = execFileSync(executable, [operation], {
    input: path, encoding: 'utf8', timeout: 15_000, windowsHide: true,
    maxBuffer: 16 * 1024, stdio: ['pipe', 'pipe', 'pipe'], env: windowsStorageEnvironment(),
  });
  if (response !== 'ATHENA_PRIVATE_STORAGE_OK') throw new Error('Private Windows storage could not be verified.');
}

export function assertWindowsPrivate(path: string): void { windowsAcl(path, 'check'); }

/** Only for a newly created empty directory or unpublished file. Never repair an existing store. */
export function setWindowsPrivate(path: string): void { windowsAcl(path, 'protect'); }

/** Atomically create one private directory; an existing path is validated, never repaired. */
export function createWindowsPrivateDirectory(path: string): void { windowsAcl(path, 'create-directory'); }

/** Atomically create an empty private lock file; never open or modify an existing one. */
export function createWindowsPrivateLock(path: string): void { windowsAcl(path, 'create-lock'); }

/** Create a new, unpublished file; establish its owner and DACL before writing bytes. */
export function writeNewPrivateFileSync(path: string, bytes: string | Uint8Array,
  options: { readonly mode?: number; readonly flush?: boolean } = {}): void {
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    options.mode ?? 0o600);
  try {
    try {
      // An elevated Windows token may default new files to the Administrators
      // group as owner, even when they inherit a private parent directory DACL.
      if (process.platform === 'win32') setWindowsPrivate(path);
      writeFileSync(fd, bytes, { flush: options.flush ?? false });
    } finally { closeSync(fd); }
  } catch (error) {
    try { rmSync(path, { force: true }); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Private file creation and cleanup failed.'); }
    throw error;
  }
}

export function hasPrivatePermissions(path: string, info: Stats, exactMode?: number): boolean {
  if (info.isSymbolicLink()) return false;
  if (process.platform !== 'win32') {
    return info.uid === process.getuid?.() && (exactMode === undefined ? (info.mode & 0o077) === 0 : (info.mode & 0o7777) === exactMode);
  }
  try { assertWindowsPrivate(path); } catch { return false; }
  // Read-only immutable grants retain the Windows read-only file attribute.
  return info.isDirectory() || exactMode === undefined || Boolean(info.mode & 0o200) === Boolean(exactMode & 0o200);
}

/** The complete root of an already-resolved Windows path, including an extended UNC share. */
export function windowsStorageRoot(path: string): string {
  // win32.parse stops at \\?\UNC\, before the required server/share. Walking
  // from that prefix would attempt to inspect incomplete network roots.
  const extendedUnc = /^(\\\\\?\\UNC\\[^\\]+\\[^\\]+)(?:\\|$)/iu.exec(path);
  return extendedUnc ? `${extendedUnc[1]}\\` : win32.parse(path).root;
}

export function createPrivateDirectory(path: string): void {
  const absolute = resolve(path);
  if (process.platform === 'win32') {
    // An elevated token can default to an Administrators owner. Publishing a
    // mkdir result before changing that owner lets concurrent hosts observe an
    // invalid directory, so apply the owner/DACL in the creation syscall itself.
    const root = windowsStorageRoot(absolute);
    let current = root;
    for (const part of absolute.slice(root.length).split(win32.sep).filter(Boolean)) {
      current = win32.join(current, part);
      let info: Stats;
      try { info = lstatSync(current); }
      catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        createWindowsPrivateDirectory(current);
        info = lstatSync(current);
      }
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Expected private storage owned by the current user.');
    }
  } else mkdirSync(absolute, { recursive: true, mode: 0o700 });
  const info = lstatSync(absolute);
  if (!info.isDirectory() || !hasPrivatePermissions(absolute, info)) throw new Error('Expected private storage owned by the current user.');
}
