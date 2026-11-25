import { createHmac, randomBytes } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import type { CredentialStore } from '@earendil-works/pi-ai';
import { ensureCredentialLockFile, invalidLocalStore, localWriteFailed, prepareCredentialDirectory,
  readPrivateCredentialFile, requireCredentialLockFile, requirePrivateDirectory, writePrivateCredentialFile } from './local-credential-files.ts';

const memoryKeys = new WeakMap<CredentialStore, Buffer>();

async function persistentKey(workspace: string): Promise<Buffer> {
  const directory = await prepareCredentialDirectory(join(await realpath(workspace), 'provider-bindings'));
  const path = join(directory, 'key.v1');
  const lockPath = join(directory, '.key.lock.sqlite');
  await ensureCredentialLockFile(lockPath);
  await requirePrivateDirectory(directory);
  await requireCredentialLockFile(lockPath);
  // As with the credential store, the empty SQLite file is only an OS-released
  // cross-process lock. Publish the key atomically while holding that lock.
  const lock = new DatabaseSync(lockPath);
  try {
    const deadline = performance.now() + 10_000;
    for (;;) {
      try { lock.exec('BEGIN EXCLUSIVE'); break; }
      catch (error) {
        if (!(error instanceof Error && 'errcode' in error && error.errcode === 5)) throw invalidLocalStore();
        if (performance.now() >= deadline) throw localWriteFailed();
        await delay(10);
      }
    }
    let saved = await readPrivateCredentialFile(path, 'text');
    if (saved === undefined) {
      saved = randomBytes(32).toString('hex') + '\n';
      await writePrivateCredentialFile(path, saved);
    }
    if (!/^[a-f0-9]{64}\n$/u.test(saved)) throw invalidLocalStore();
    return Buffer.from(saved.trimEnd(), 'hex');
  } finally { lock.close(); }
}

/** Public references cannot be used to guess credentials without the private host key. */
export class CredentialBindings {
  readonly #store: CredentialStore;
  readonly #directory: string | undefined;
  #key?: Promise<Buffer>;

  constructor(store: CredentialStore, directory?: string) {
    this.#store = store;
    this.#directory = directory;
  }

  async bind(provider: string, material: unknown): Promise<string> {
    this.#key ??= this.#directory ? persistentKey(this.#directory) : Promise.resolve(this.#memoryKey());
    const digest = createHmac('sha256', await this.#key)
      .update(JSON.stringify(['athena-provider-credential-v1', provider, material])).digest('hex');
    return 'credential:v1:' + digest;
  }

  #memoryKey(): Buffer {
    let key = memoryKeys.get(this.#store);
    if (!key) { key = randomBytes(32); memoryKeys.set(this.#store, key); }
    return key;
  }
}
