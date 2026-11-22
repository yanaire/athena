import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai';
import { object } from './connections.ts';
import { clearAbandonedCredentialWrites, ensureCredentialLockFile, invalidLocalStore, localWriteFailed,
  prepareCredentialDirectory, readPrivateCredentialFile, requireCredentialLockFile, requirePrivateDirectory, writePrivateCredentialFile } from './local-credential-files.ts';

const LOCK_WAIT_MS = 60_000;
type Contents = { readonly entries: Map<string, Credential>; readonly migrations: Set<string> };

export function parseStoredCredentials(value: unknown): Map<string, Credential> {
  if (!object(value)) throw invalidLocalStore();
  const records = new Map<string, Credential>();
  for (const [id, item] of Object.entries(value)) {
    if (!id || id.length > 512 || !object(item)) throw invalidLocalStore();
    switch (item.type) {
      case 'api_key': {
        const { key, env } = item;
        if (key !== undefined && typeof key !== 'string') throw invalidLocalStore();
        const parsedEnv = new Map<string, string>();
        if (env !== undefined) {
          if (!object(env)) throw invalidLocalStore();
          for (const [name, setting] of Object.entries(env)) {
            if (typeof setting !== 'string') throw invalidLocalStore();
            parsedEnv.set(name, setting);
          }
        }
        if (key === undefined && parsedEnv.size === 0) throw invalidLocalStore();
        records.set(id, { type: 'api_key', ...(key === undefined ? {} : { key }),
          ...(env === undefined ? {} : { env: Object.fromEntries(parsedEnv) }) });
        break;
      }
      case 'oauth': {
        const { access, refresh, expires } = item;
        if (typeof access !== 'string' || typeof refresh !== 'string' || typeof expires !== 'number'
          || !Number.isSafeInteger(expires) || expires < 0) throw invalidLocalStore();
        records.set(id, { ...item, type: 'oauth', access, refresh, expires });
        break;
      }
      default: throw invalidLocalStore();
    }
  }
  return records;
}

function decode(text: string): Contents {
  try {
    const value: unknown = JSON.parse(text);
    if (!object(value) || value.version !== 2 || !Array.isArray(value.migrations)) throw invalidLocalStore();
    const migrations = new Set<string>();
    for (const entry of value.migrations) {
      if (typeof entry !== 'string' || !/^[a-f0-9]{64}$/u.test(entry) || migrations.has(entry)) throw invalidLocalStore();
      migrations.add(entry);
    }
    return { entries: parseStoredCredentials(value.credentials), migrations };
  } catch { throw invalidLocalStore(); }
}

export class LocalCredentialStore implements CredentialStore {
  readonly #directory: string;
  readonly #file: string;
  readonly #lockFile: string;

  private constructor(directory: string) {
    this.#directory = directory;
    this.#file = join(directory, 'credentials.v2.json');
    this.#lockFile = join(directory, '.credentials.lock.sqlite');
  }

  static async open(directory: string): Promise<LocalCredentialStore> {
    const store = new LocalCredentialStore(await prepareCredentialDirectory(directory));
    await ensureCredentialLockFile(store.#lockFile);
    await store.#exclusive(undefined, async () => {
      await clearAbandonedCredentialWrites(store.#directory);
      const current = await readPrivateCredentialFile(store.#file, 'text');
      if (current === undefined) await store.#save({ entries: new Map(), migrations: new Set() });
      else decode(current);
    });
    return store;
  }

  async #exclusive<T>(options: AuthOperationOptions | undefined, action: () => Promise<T>): Promise<T> {
    const signal = options?.signal;
    signal?.throwIfAborted();
    await requirePrivateDirectory(this.#directory);
    await requireCredentialLockFile(this.#lockFile);
    // SQLite's exclusive transaction is an OS-released, cross-process lock. No
    // credentials go in the database; an async retry doesn't block this host's event loop.
    const lock = new DatabaseSync(this.#lockFile);
    try {
      const deadline = performance.now() + LOCK_WAIT_MS;
      for (;;) {
        signal?.throwIfAborted();
        try { lock.exec('BEGIN EXCLUSIVE'); break; }
        catch (error) {
          if (!(error instanceof Error && 'errcode' in error && error.errcode === 5)) throw invalidLocalStore();
          if (performance.now() >= deadline) throw localWriteFailed();
          await delay(25, undefined, { signal });
        }
      }
      return await action();
    } finally { lock.close(); }
  }

  async #load(options?: AuthOperationOptions): Promise<Contents> {
    options?.signal?.throwIfAborted();
    await requirePrivateDirectory(this.#directory);
    const text = await readPrivateCredentialFile(this.#file, 'text');
    if (text === undefined) throw invalidLocalStore();
    return decode(text);
  }

  async #save(contents: Contents): Promise<void> {
    const text = JSON.stringify({ version: 2, credentials: Object.fromEntries(contents.entries), migrations: [...contents.migrations] }) + '\n';
    decode(text);
    await writePrivateCredentialFile(this.#file, text);
  }

  async read(id: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    return (await this.#load(options)).entries.get(id);
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    return [...(await this.#load(options)).entries].map(([providerId, credential]) => ({ providerId, type: credential.type }));
  }

  modify(id: string, update: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions): Promise<Credential | undefined> {
    return this.#exclusive(options, async () => {
      const contents = await this.#load(options);
      const current = contents.entries.get(id);
      const next = await update(current);
      // Once a provider has rotated a token, persist it even if the caller cancels.
      if (next === undefined) return current;
      contents.entries.set(id, next);
      await this.#save(contents);
      return next;
    });
  }

  delete(id: string, options?: AuthOperationOptions): Promise<void> {
    return this.#exclusive(options, async () => {
      const contents = await this.#load(options);
      if (contents.entries.delete(id)) await this.#save(contents);
    });
  }

  async migrated(source: string): Promise<boolean> {
    return (await this.#load()).migrations.has(source);
  }

  importLegacy(source: string, incoming: ReadonlyMap<string, Credential>): Promise<number> {
    return this.#exclusive(undefined, async () => {
      const contents = await this.#load();
      if (contents.migrations.has(source)) return 0;
      let added = 0;
      for (const [id, credential] of incoming) {
        if (contents.entries.has(id)) continue;
        contents.entries.set(id, credential);
        added++;
      }
      contents.migrations.add(source);
      await this.#save(contents);
      const restored = await this.#load();
      if (!isDeepStrictEqual(restored, contents)) throw invalidLocalStore();
      return added;
    });
  }
}

export const openLocalCredentials = (directory: string): Promise<LocalCredentialStore> => LocalCredentialStore.open(directory);
