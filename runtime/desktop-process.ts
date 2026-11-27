import { spawn } from 'node:child_process';
import { accessSync, constants, statSync, realpathSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { DesktopError } from './desktop-control.ts';

/** Discovery is host configuration. Project and model inputs never select a program. */
export function localExecutable(candidates: readonly string[], names: RegExp): string | undefined {
  for (const path of candidates) {
    if (!isAbsolute(path)) throw new DesktopError('denied', 'A local app must be configured by absolute executable path.');
    try {
      const executable = realpathSync(path);
      if (!names.test(basename(executable)) || !statSync(executable).isFile()) {
        throw new DesktopError('denied', 'The configured path does not identify the expected local executable.');
      }
      accessSync(executable, constants.X_OK);
      return executable;
    } catch (cause) {
      if (cause instanceof DesktopError) throw cause;
      if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') continue;
      throw new DesktopError('denied', 'The configured local app could not be accessed.', { cause });
    }
  }
}

export function applicationEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'WINDIR', 'SystemDrive',
    'TMPDIR', 'TEMP', 'TMP', 'PATH', 'LANG', 'LC_ALL', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY',
    'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'SESSIONNAME'];
  return Object.fromEntries(allowed.flatMap(name => {
    const match = Object.keys(source).find(key => process.platform === 'win32'
      ? key.toLowerCase() === name.toLowerCase() : key === name);
    return match && source[match] !== undefined ? [[name, source[match]]] : [];
  }));
}

export function launchOwnedApp(executable: string, args: readonly string[], options: {
  readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly background?: boolean; readonly captureOutput?: boolean;
}) {
  const child = spawn(executable, args, { cwd: options.cwd, env: options.env, windowsHide: options.background === true,
    stdio: ['ignore', options.captureOutput ? 'pipe' : 'ignore', 'ignore'], shell: false });
  const exited = new AbortController();
  let stdout = Buffer.alloc(0);
  let overflow = false;
  child.stdout?.on('data', (bytes: Buffer) => {
    if (overflow || stdout.length + bytes.length > 64 * 1024) { overflow = true; return; }
    stdout = Buffer.concat([stdout, bytes]);
  });
  let startError: NodeJS.ErrnoException | undefined;
  const started = new Promise<number>((resolve, reject) => {
    child.once('spawn', () => resolve(child.pid!));
    child.once('error', (error: NodeJS.ErrnoException) => {
      startError = error;
      const code = error.code === 'EACCES' || error.code === 'EPERM' ? 'denied'
        : error.code === 'ENOENT' ? 'unsupported' : 'failed';
      reject(new DesktopError(code, 'The approved local app could not start.', { cause: error }));
    });
  });
  const closed = new Promise<{ code: number | null; stdout: string; error?: NodeJS.ErrnoException }>(resolve => {
    child.once('close', code => {
      exited.abort();
      resolve({ code, stdout: overflow ? '' : stdout.toString('utf8'), error: startError });
    });
  });
  return { started, closed, exited: exited.signal,
    terminate: () => !exited.signal.aborted && child.exitCode === null && child.signalCode === null && child.kill('SIGKILL') };
}
