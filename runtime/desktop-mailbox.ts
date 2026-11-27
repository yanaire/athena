import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DesktopError, checkDesktopPng, maxDesktopPngBytes } from './desktop-control.ts';
import type { DesktopDriver, DesktopWindow } from './desktop-control.ts';
import { writeNewPrivateFileSync } from './private-storage.ts';

const dictionary = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const boundedText = (value: unknown): value is string => typeof value === 'string' && value.length <= 4096;

function readBounded(path: string, limit: number): Buffer | undefined {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (!info) return;
  if (!info.isFile() || info.nlink !== 1 || info.size > limit) {
    throw new DesktopError('failed', 'The app bridge produced an invalid observation.');
  }
  const bytes = readFileSync(path);
  if (bytes.length !== info.size) throw new DesktopError('failed', 'An app bridge observation changed while being read.');
  return bytes;
}

function isWindow(value: unknown, appId: string, pid: number): value is DesktopWindow {
  return dictionary(value) && value.appId === appId && value.pid === pid && boundedText(value.windowId)
    && (value.document === null || boundedText(value.document))
    && Array.isArray(value.viewport) && value.viewport.length === 7 && value.viewport.every(Number.isFinite);
}

/** Mailbox for a trusted bridge loaded into an Athena-owned application process. */
export class DesktopMailbox implements DesktopDriver {
  #revoked = false;
  readonly #directory: string;
  readonly #appId: string;
  readonly #pid: number;
  readonly #exited: AbortSignal;
  readonly #timeoutMs: number;

  constructor(directory: string, appId: string, pid: number, exited: AbortSignal, timeoutMs = 12_000) {
    this.#directory = directory;
    this.#appId = appId;
    this.#pid = pid;
    this.#exited = exited;
    this.#timeoutMs = timeoutMs;
  }

  async #exchange(request: { kind: 'observe' } | { kind: 'activate'; window: DesktopWindow; target: string }, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.#revoked) throw new DesktopError('stopped', 'The app bridge has been revoked.');
    const reply = join(this.#directory, 'reply.json');
    const path = join(this.#directory, 'request.json');
    const id = randomUUID();
    const frame = join(this.#directory, id + '.png');
    const temp = join(this.#directory, id + '.json');
    const deadline = Date.now() + this.#timeoutMs;
    try {
      if (this.#exited.aborted) throw new DesktopError('failed', 'The owned app exited.');
      writeNewPrivateFileSync(temp, JSON.stringify({ ...request, id, deadline }));
      renameSync(temp, path);
      while (Date.now() < deadline) {
        signal.throwIfAborted();
        const bytes = readBounded(reply, 32 * 1024);
        if (bytes) {
          const data: unknown = JSON.parse(bytes.toString('utf8'));
          if (!dictionary(data) || data.id !== id || typeof data.status !== 'string') {
            throw new DesktopError('failed', 'The app bridge returned an invalid action receipt.');
          }
          if (data.status !== 'ok') {
            const code = data.status === 'denied' || data.status === 'unsupported' || data.status === 'stale_observation'
              || data.status === 'indeterminate' || data.status === 'stopped' ? data.status : 'failed';
            throw new DesktopError(code, boundedText(data.message) ? data.message : 'The app bridge could not run the action.');
          }
          if (request.kind === 'activate') return {};
          const png = readBounded(frame, maxDesktopPngBytes);
          if (!isWindow(data.window, this.#appId, this.#pid) || !Array.isArray(data.targets)
            || data.targets.length > 128 || !data.targets.every(boundedText) || !png) {
            throw new DesktopError('failed', 'The observed window did not match the owned app.');
          }
          return { window: data.window, targets: data.targets as string[], png: checkDesktopPng(png) };
        }
        if (this.#exited.aborted) break;
        await sleep(40, undefined, { signal });
      }
      throw new DesktopError(request.kind === 'activate' ? 'indeterminate' : 'failed',
        request.kind === 'activate' ? 'The app did not acknowledge input. Inspect its result before retrying.'
          : 'The owned app did not provide a window observation.');
    } finally {
      for (const file of [path, reply, frame, temp]) rmSync(file, { force: true });
    }
  }

  async observe(signal: AbortSignal) {
    const { window, png, targets } = await this.#exchange({ kind: 'observe' }, signal);
    if (!window || !png || !targets) throw new DesktopError('failed', 'Missing window observation.');
    return { window, png, targets };
  }

  async activate(window: DesktopWindow, target: string, signal: AbortSignal) {
    await this.#exchange({ kind: 'activate', window, target }, signal);
  }

  revoke(): void {
    if (this.#revoked) return;
    writeNewPrivateFileSync(join(this.#directory, 'revoked'), '');
    this.#revoked = true;
    rmSync(join(this.#directory, 'request.json'), { force: true });
  }
}
