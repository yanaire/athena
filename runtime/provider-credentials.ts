import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { link, lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai';
import { object } from './connections.ts';

export type CredentialMode = 'keychain' | 'operator_key' | 'memory';
export type DesktopVaultKey = { readonly key: string; readonly source: Exclude<CredentialMode, 'memory'> };

export class CredentialPersistenceError extends Error {
  readonly name = 'CredentialPersistenceError';
}

export class CredentialVaultError extends Error {
  readonly name = 'CredentialVaultError';
  readonly code: 'VAULT_KEY_MISMATCH' | 'VAULT_INVALID' | 'VAULT_WRITE_FAILED';
  constructor(code: CredentialVaultError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

// Historical/synthetic fixture access. Desktop startup never opens this store.
export async function openProviderCredentials(directory: string, desktop?: DesktopVaultKey): Promise<{ readonly mode: CredentialMode; readonly store: CredentialStore }> {
  const root = await realpath(directory);
  const secret = desktop?.key ?? process.env.ATHENA_CREDENTIAL_KEY;
  const mode: CredentialMode = desktop?.source ?? (secret === undefined ? 'memory' : 'operator_key');
  const path = join(root, 'provider-secrets.v1');
  const existing = await lstat(path).catch((cause: unknown) => {
    if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') return undefined;
    throw new CredentialVaultError('VAULT_INVALID', 'The Athena credential vault cannot be inspected.');
  });
  if (!secret && mode === 'memory' && !existing) return { mode, store: new InMemoryCredentialStore() };
  if (!secret || !/^[a-fA-F0-9]{64}$/u.test(secret)) throw new CredentialVaultError('VAULT_KEY_MISMATCH', 'The Athena credential vault requires its original 32-byte hex key.');
  const key = Buffer.from(secret, 'hex');
  const entries = new Map<string, Credential>();
  if (existing) for (const [id, item] of await readLegacyCredentials(path, key)) entries.set(id, item);
  const store = new EncryptedCredentialStore(root, path, key, entries);
  if (desktop && !existing) await store.initialize();
  return { mode, store };
}

export async function readLegacyCredentials(path: string, key: Buffer): Promise<Map<string, Credential>> {
    const entries = new Map<string, Credential>();
    const invalid = new CredentialVaultError('VAULT_INVALID', 'The Athena credential vault is damaged, unreadable, or has unsafe permissions.');
    let bytes: Buffer;
    try {
      const { constants } = await import('node:fs');
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1
          || (stat.mode & 0o7777) !== 0o600 || stat.size < 30 || stat.size > 4 * 1024 * 1024) throw invalid;
        bytes = await file.readFile();
      } finally { await file.close(); }
    } catch { throw invalid; }
    if (bytes.length < 30) throw invalid;
    let plaintext: Buffer;
    try {
      const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      plaintext = Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]);
    } catch {
      // For v1, altered ciphertext and an incorrect key both fail the same AEAD check.
      throw new CredentialVaultError('VAULT_KEY_MISMATCH', 'The Athena credential vault could not be decrypted. No credentials were overwritten.');
    }
    try {
      const data: unknown = JSON.parse(plaintext.toString('utf8'));
      if (!object(data)) throw new TypeError('Invalid vault.');
      for (const [id, item] of Object.entries(data)) {
        if (!object(item)) throw new TypeError('Invalid credential.');
        if (item.type === 'api_key' && typeof item.key === 'string') entries.set(id, { type: 'api_key', key: item.key });
        else if (item.type === 'oauth' && typeof item.access === 'string' && typeof item.refresh === 'string' && typeof item.expires === 'number') {
          entries.set(id, { ...item, type: 'oauth', access: item.access, refresh: item.refresh, expires: item.expires });
        } else throw new TypeError('Invalid credential.');
      }
    } catch { throw invalid; }
    finally { plaintext.fill(0); }
    return entries;
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

  async initialize(): Promise<void> {
    try { await this.#persist(this.#entries, true); }
    catch { throw new CredentialVaultError('VAULT_WRITE_FAILED', 'The encrypted Athena vault could not be initialized.'); }
  }

  async #persist(entries: Map<string, Credential>, initialize = false): Promise<void> {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, nonce);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(Object.fromEntries(entries)), 'utf8'), cipher.final()]);
    const temporary = join(this.#root, `provider-secrets-${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(Buffer.concat([nonce, cipher.getAuthTag(), encrypted])); await file.sync(); }
      finally { await file.close(); }
      if (initialize) await link(temporary, this.#path);
      else await rename(temporary, this.#path);
      this.#entries = entries;
    } catch (error) {
      throw new CredentialPersistenceError('The credential vault write failed.', { cause: error });
    } finally {
      await unlink(temporary).catch(() => undefined);
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
