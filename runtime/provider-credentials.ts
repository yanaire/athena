import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai';
import { object } from './connections.ts';

export type CredentialMode = 'keychain' | 'operator_key' | 'memory';
const exec = promisify(execFile);
const service = 'Athena provider vault v1';

export class CredentialPersistenceError extends Error {
  readonly name = 'CredentialPersistenceError';
}

export async function openProviderCredentials(directory: string): Promise<{ readonly mode: CredentialMode; readonly store: CredentialStore }> {
  const root = await realpath(directory);
  let secret = process.env.ATHENA_CREDENTIAL_KEY;
  let mode: CredentialMode = secret === undefined ? 'memory' : 'operator_key';
  // The operator pre-provisions a vault key in Keychain. Athena never puts a key on a command line.
  if (secret === undefined && process.platform === 'darwin') {
    try {
      const account = createHash('sha256').update(root).digest('hex');
      const { stdout } = await exec('/usr/bin/security', ['find-generic-password', '-s', service, '-a', account, '-w'],
        { timeout: 3000, maxBuffer: 4096 });
      secret = stdout.trim();
      mode = 'keychain';
    } catch (cause) {
      if (!(cause instanceof Error) || !('code' in cause) || cause.code !== 44) {
        throw new Error('The Athena Keychain entry could not be read. Unlock the login keychain or supply the vault key.');
      }
    }
  }
  const path = join(root, 'provider-secrets.v1');
  const existing = await lstat(path).catch((cause: unknown) => {
    if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') return undefined;
    throw cause;
  });
  if (!secret && mode === 'memory' && !existing) return { mode, store: new InMemoryCredentialStore() };
  if (!secret || !/^[a-fA-F0-9]{64}$/u.test(secret)) throw new Error('The Athena credential vault requires its 32-byte hex key.');
  const key = Buffer.from(secret, 'hex');
  const entries = new Map<string, Credential>();
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink() || (existing.mode & 0o077) !== 0) throw new Error('The Athena credential vault is not an owner-only regular file.');
    try {
      const { constants } = await import('node:fs');
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Buffer;
      try { bytes = await file.readFile(); } finally { await file.close(); }
      const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      const data: unknown = JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'));
      if (!object(data)) throw new TypeError('Invalid vault.');
      for (const [id, item] of Object.entries(data)) {
        if (!object(item)) throw new TypeError('Invalid credential.');
        if (item.type === 'api_key' && typeof item.key === 'string') entries.set(id, { type: 'api_key', key: item.key });
        else if (item.type === 'oauth' && typeof item.access === 'string' && typeof item.refresh === 'string' && typeof item.expires === 'number') {
          entries.set(id, { ...item, type: 'oauth', access: item.access, refresh: item.refresh, expires: item.expires });
        } else throw new TypeError('Invalid credential.');
      }
    } catch {
      throw new Error('The Athena credential vault could not be decrypted. No credentials were overwritten.');
    }
  }
  return { mode, store: new EncryptedCredentialStore(root, path, key, entries) };
}

class EncryptedCredentialStore implements CredentialStore {
  readonly #root: string;
  readonly #path: string;
  readonly #key: Buffer;
  #entries: Map<string, Credential>;
  #tail: Promise<void> = Promise.resolve();

  constructor(root: string, path: string, key: Buffer, entries: Map<string, Credential>) {
    this.#root = root;
    this.#path = path;
    this.#key = key;
    this.#entries = entries;
  }

  async read(id: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    return structuredClone(this.#entries.get(id));
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    return [...this.#entries].map(([providerId, credential]) => ({ providerId, type: credential.type }));
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async #persist(entries: Map<string, Credential>): Promise<void> {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, nonce);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(Object.fromEntries(entries)), 'utf8'), cipher.final()]);
    const temporary = join(this.#root, `provider-secrets-${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(Buffer.concat([nonce, cipher.getAuthTag(), encrypted])); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, this.#path);
      this.#entries = entries;
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw new CredentialPersistenceError('The credential vault write failed.', { cause: error });
    }
  }

  modify(id: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions): Promise<Credential | undefined> {
    return this.#serialize(async () => {
      const current = await this.read(id, options);
      const next = await fn(current);
      if (next !== undefined) {
        await this.#persist(new Map(this.#entries).set(id, structuredClone(next)));
      }
      return next ?? current;
    });
  }

  delete(id: string, options?: AuthOperationOptions): Promise<void> {
    return this.#serialize(async () => {
      options?.signal?.throwIfAborted();
      const next = new Map(this.#entries);
      if (next.delete(id)) await this.#persist(next);
    });
  }
}
