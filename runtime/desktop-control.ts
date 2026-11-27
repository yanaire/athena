import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createPrivateDirectory, hasPrivatePermissions, writeNewPrivateFileSync } from './private-storage.ts';

export type DesktopErrorCode =
  | 'unsupported' | 'denied' | 'indeterminate' | 'failed'
  | 'busy' | 'stale_observation' | 'stopped' | 'invalid_result';

export class DesktopError extends Error {
  readonly code: DesktopErrorCode;
  constructor(code: DesktopErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = 'DesktopError';
  }
}

export type DesktopWindow = Readonly<{
  appId: string;
  pid: number;
  windowId: string;
  document: string | null;
  viewport: readonly number[];
}>;

export type DesktopFrame = Readonly<{
  window: DesktopWindow;
  targets: readonly string[];
  png: Uint8Array;
}>;

export interface DesktopDriver {
  observe(signal: AbortSignal): Promise<DesktopFrame>;
  activate(window: DesktopWindow, target: string, signal: AbortSignal): Promise<void>;
  revoke(): void;
}

const pngMagic = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export const maxDesktopPngBytes = 2 * 1024 * 1024;

export function checkDesktopPng(bytes: Uint8Array): Buffer {
  const png = Buffer.from(bytes);
  if (png.length < 33 || png.length > maxDesktopPngBytes || !png.subarray(0, 8).equals(pngMagic)
    || png.toString('ascii', 12, 16) !== 'IHDR' || png.readUInt32BE(8) !== 13
    || png.readUInt32BE(16) < 1 || png.readUInt32BE(16) > 4096
    || png.readUInt32BE(20) < 1 || png.readUInt32BE(20) > 4096) {
    throw new DesktopError('failed', 'The app did not return a bounded PNG window capture.');
  }
  return png;
}

/** Same-user Athena hosts share one input lease, including across data directories. */
export function acquireDesktopInput(directory = process.platform === 'linux'
  ? join('/tmp', 'athena-desktop-control-' + process.getuid!())
  : join(homedir(), '.athena', 'desktop-control')): () => void {
  return acquireLocalLock(directory, 'input.sqlite', 'Another Athena task has desktop input control.');
}

export function acquireLocalLock(directory: string, filename: string, busy: string): () => void {
  try {
    createPrivateDirectory(directory);
    const path = join(directory, filename);
    try { writeNewPrivateFileSync(path, ''); }
    catch (cause) {
      if (!(cause instanceof Error && 'code' in cause && cause.code === 'EEXIST')) throw cause;
    }
    const file = lstatSync(path);
    if (!file.isFile() || file.nlink !== 1 || !hasPrivatePermissions(path, file)) {
      throw new Error('Invalid input lock file.');
    }
    const db = new DatabaseSync(path);
    try { db.exec('BEGIN EXCLUSIVE'); }
    catch (cause) {
      db.close();
      if (cause instanceof Error && 'errcode' in cause && cause.errcode === 5) {
        throw new DesktopError('busy', busy, { cause });
      }
      throw cause;
    }
    return () => db.close();
  } catch (cause) {
    if (cause instanceof DesktopError) throw cause;
    throw new DesktopError('denied', 'Athena could not acquire the local app automation lock.', { cause });
  }
}

/** A fresh frame authorizes one observed target. There is no queue of inputs. */
export class DesktopControl {
  readonly #driver: DesktopDriver;
  readonly #releaseInput: () => void;
  readonly #abort = new AbortController();
  #last?: DesktopFrame & { readonly id: string };
  #active?: Promise<unknown>;
  #closing?: Promise<void>;

  constructor(driver: DesktopDriver, releaseInput: () => void) {
    this.#driver = driver;
    this.#releaseInput = releaseInput;
  }

  #run<T>(action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.#abort.signal.throwIfAborted();
    if (this.#active) throw new DesktopError('busy', 'Wait for the current desktop operation to settle.');
    const running = Promise.resolve().then(() => {
      this.#abort.signal.throwIfAborted();
      return action(this.#abort.signal);
    });
    this.#active = running;
    return running.finally(() => { this.#active = undefined; });
  }

  observe(): Promise<DesktopFrame & { readonly id: string }> {
    return this.#run(async signal => {
      this.#last = undefined;
      const frame = await this.#driver.observe(signal);
      signal.throwIfAborted();
      this.#last = { ...frame, png: checkDesktopPng(frame.png), id: randomUUID() };
      return this.#last;
    });
  }

  activate(observation: string, target: string): Promise<void> {
    return this.#run(async signal => {
      const frame = this.#last;
      this.#last = undefined;
      if (!frame || observation !== frame.id || !frame.targets.includes(target)) {
        throw new DesktopError('stale_observation', 'Observe the current app window before selecting a displayed control.');
      }
      await this.#driver.activate(frame.window, target, signal);
      signal.throwIfAborted();
    });
  }

  stop(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#last = undefined;
    this.#abort.abort(new DesktopError('stopped', 'Athena released desktop input control.'));
    let revokeError: unknown;
    // Publish revocation now, including when an action is waiting for a reply.
    try { this.#driver.revoke(); }
    catch (error) { revokeError = error; }
    this.#closing = Promise.resolve(this.#active).catch(() => {}).then(() => {
      try { if (revokeError) this.#driver.revoke(); }
      finally { this.#releaseInput(); }
    });
    return this.#closing;
  }
}
