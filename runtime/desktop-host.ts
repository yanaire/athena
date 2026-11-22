import { timingSafeEqual } from 'node:crypto';
import { writeSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CredentialVaultError } from './provider-credentials.ts';

const MAX_STARTUP_BYTES = 1024;
const STARTUP_TIMEOUT_MS = 60_000;
const MIGRATION_TIMEOUT_MS = 305_000;
const LOWER_HEX = /^[0-9a-f]{64}$/u;

// Match the small ASCII JSON grammar before inspecting the fields, so duplicate keys
// cannot be normalized away by JSON.parse. Rust writes plain, unescaped values.
const STARTUP_LINE = /^[\t\r ]*\{[\t\r ]*"token"[\t\r ]*:[\t\r ]*"([0-9a-f]{64})"[\t\r ]*\}[\t\r ]*$/u;
const MIGRATION_LINE = /^\{"migration":"([0-9a-fA-F]{64}|unavailable)"\}$/u;

type StartupErrorCode = 'WORKSPACE_BUSY' | 'STARTUP_FAILED' | CredentialVaultError['code'];
export class DesktopStartupError extends Error {
  readonly name = 'DesktopStartupError';
  readonly code: StartupErrorCode;
  constructor(code: StartupErrorCode) { super(code); this.code = code; }
}

export function reportDesktopStartupError(error: unknown): void {
  const code = error instanceof DesktopStartupError ? error.code : 'STARTUP_FAILED';
  process.exitCode = 1;
  try { writeSync(1, `ATHENA_DESKTOP_ERROR ${code}\n`); }
  catch (cause) {
    if (!(cause instanceof Error) || !('code' in cause) || cause.code !== 'EPIPE') throw cause;
  }
}

export function lockWorkspace(directory: string, desktop: boolean): DatabaseSync {
  // OS-owned lock, also released on process death. Two hosts must not recover/dispatch in the same workspace.
  const lock = new DatabaseSync(join(directory, 'host.lock.sqlite'));
  try { lock.exec('BEGIN EXCLUSIVE'); }
  catch (error) {
    lock.close();
    if (!desktop) throw new Error('This Athena data directory is in use by another host.');
    if (error instanceof Error && 'errcode' in error && error.errcode === 5) throw new DesktopStartupError('WORKSPACE_BUSY'); // SQLITE_BUSY
    throw error;
  }
  return lock;
}

export type DesktopStartup = {
  readonly token: Buffer;
  readonly disconnected: AbortSignal;
  readonly requestMigrationKey: (account: string) => Promise<Buffer | undefined>;
};

export function readDesktopStartup(): Promise<DesktopStartup> {
  const input = process.stdin;
  const lifetime = new AbortController();
  const { promise, resolve, reject } = Promise.withResolvers<DesktopStartup>();
  const line = Buffer.alloc(MAX_STARTUP_BYTES);
  let used = 0;
  let started = false;
  let migration: {
    readonly resolve: (value: Buffer | undefined) => void;
    readonly reject: (reason: DesktopStartupError) => void;
    readonly timeout: ReturnType<typeof setTimeout>;
  } | undefined;
  const timeout = setTimeout(fail, STARTUP_TIMEOUT_MS);

  function requestMigrationKey(account: string): Promise<Buffer | undefined> {
    if (!LOWER_HEX.test(account) || migration || lifetime.signal.aborted) {
      return Promise.reject(new DesktopStartupError('STARTUP_FAILED'));
    }
    const result = Promise.withResolvers<Buffer | undefined>();
    migration = { resolve: result.resolve, reject: result.reject, timeout: setTimeout(fail, MIGRATION_TIMEOUT_MS) };
    try { writeSync(1, `ATHENA_DESKTOP_IMPORT ${account}\n`); }
    catch { fail(); }
    return result.promise;
  }

  function fail() {
    const error = new DesktopStartupError('STARTUP_FAILED');
    clearTimeout(timeout);
    clearTimeout(migration?.timeout);
    migration?.reject(error);
    migration = undefined;
    line.fill(0);
    input.destroy();
    if (started) lifetime.abort(error);
    else reject(error);
  }

  input.once('end', () => {
    if (!started) { fail(); return; }
    clearTimeout(migration?.timeout);
    migration?.reject(new DesktopStartupError('STARTUP_FAILED'));
    migration = undefined;
    lifetime.abort();
  });
  input.once('error', fail);
  input.on('data', (chunk: Buffer) => {
    const newline = chunk.indexOf(0x0a);
    const length = newline < 0 ? chunk.length : newline;
    if ((started && !migration) || (newline >= 0 && newline !== chunk.length - 1)) {
      fail();
      return;
    }
    if (used + length > MAX_STARTUP_BYTES) {
      fail();
      return;
    }
    chunk.copy(line, used, 0, length);
    used += length;
    if (newline < 0) return;

    const message = line.toString('utf8', 0, used);
    line.fill(0);
    used = 0;
    if (started) {
      const key = MIGRATION_LINE.exec(message)?.[1];
      if (!key || !migration) { fail(); return; }
      const pending = migration;
      migration = undefined;
      clearTimeout(pending.timeout);
      pending.resolve(key === 'unavailable' ? undefined : Buffer.from(key, 'hex'));
      return;
    }
    const token = STARTUP_LINE.exec(message)?.[1];
    if (!token) {
      fail();
      return;
    }
    started = true;
    clearTimeout(timeout);
    resolve({ token: Buffer.from(token, 'hex'), disconnected: lifetime.signal, requestMigrationKey });
    // Stay in flowing mode for EOF (also delivered when the parent dies).
  });
  return promise;
}

export const desktopCsp = (origin: string): string => [
  "default-src 'none'",
  `script-src ${origin} 'unsafe-inline'`,
  `style-src ${origin} 'unsafe-inline'`,
  `img-src ${origin} data: blob:`,
  `connect-src ${origin}`,
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const COOKIE_NAME = 'athena_desktop';
const COOKIE_NAME_SYNTAX = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;

export function hasDesktopSession(req: IncomingMessage, token: Buffer): boolean {
  const headers = req.headersDistinct.cookie;
  const header = headers?.[0];
  if (headers?.length !== 1 || !header || header.includes(',')) return false;
  let session: string | undefined;
  for (const field of header.split(';')) {
    const pair = field.trim();
    const separator = pair.indexOf('=');
    if (separator < 1) return false;
    const name = pair.slice(0, separator);
    if (!COOKIE_NAME_SYNTAX.test(name)) return false;
    if (name !== COOKIE_NAME) continue;
    if (session !== undefined) return false;
    session = pair.slice(separator + 1);
  }
  return session !== undefined && LOWER_HEX.test(session) && timingSafeEqual(Buffer.from(session, 'hex'), token);
}

type HttpHost = {
  readonly port: number;
  readonly desktop: DesktopStartup | undefined;
  readonly streams: ReadonlySet<ServerResponse>;
  readonly serve: (req: IncomingMessage, res: ServerResponse, draining: boolean) => Promise<void>;
  readonly dispose: () => Promise<void>;
};

export function listenHost({ port, desktop, streams, serve, dispose }: HttpHost): void {
  let draining = false;
  const requests = new Set<Promise<void>>();
  const server = createServer((req, res) => {
    res.once('finish', () => { if (draining) server.closeIdleConnections(); });
    const request = serve(req, res, draining).catch(() => {
      res.destroy();
      console.error('Athena HTTP response failed.');
    });
    requests.add(request);
    void request.then(() => requests.delete(request));
  });
  server.requestTimeout = 30_000;

  async function stop() {
    if (draining) return;
    draining = true;
    if (desktop) process.stdin.destroy();
    const closed = new Promise<void>(done => server.close(() => done()));
    for (const stream of streams) stream.end();
    // Drain in-flight responses without letting an incomplete upload hold the desktop open.
    const deadline = desktop ? setTimeout(() => server.closeAllConnections(), 5_000).unref() : undefined;
    try {
      await closed;
      await Promise.allSettled(requests);
      await dispose();
    } catch {
      console.error('Athena shutdown failed.');
      process.exitCode = 1;
    } finally { clearTimeout(deadline); }
  }

  function parentDisconnected() {
    if (desktop?.disconnected.reason instanceof DesktopStartupError) reportDesktopStartupError(desktop.disconnected.reason);
    void stop();
  }
  function listenFailed(error: unknown) {
    reportDesktopStartupError(error);
    void stop();
  }
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  if (desktop?.disconnected.aborted) { parentDisconnected(); return; }
  desktop?.disconnected.addEventListener('abort', parentDisconnected, { once: true });
  if (desktop) server.once('error', listenFailed);
  server.listen(port, '127.0.0.1', () => {
    server.off('error', listenFailed);
    const address = server.address();
    if (!address || typeof address === 'string' || draining) return;
    if (desktop) {
      try { writeSync(1, `ATHENA_DESKTOP_READY ${address.port}\n`); }
      catch (error) { listenFailed(error); }
    } else console.log(`Athena listening at http://127.0.0.1:${address.port}`);
  });
}
