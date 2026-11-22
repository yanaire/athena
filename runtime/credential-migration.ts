import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { isMissing } from './local-credential-files.ts';
import type { LocalCredentialStore } from './local-credentials.ts';
import { CredentialVaultError, readLegacyCredentials } from './provider-credentials.ts';

type MigrationStatus = 'absent' | 'imported' | 'approval_required' | 'unavailable';
type KeyReader = (account: string) => Promise<Buffer | undefined>;

export class CredentialMigration {
  readonly #requestKey: KeyReader | undefined;
  readonly #store: LocalCredentialStore;
  readonly #legacyPath: string;
  readonly #source: string;

  constructor(options: { readonly workspace: string; readonly requestKey?: KeyReader | undefined; readonly store: LocalCredentialStore }) {
    this.#requestKey = options.requestKey;
    this.#store = options.store;
    this.#source = createHash('sha256').update(options.workspace).digest('hex');
    this.#legacyPath = join(options.workspace, 'provider-secrets.v1');
  }

  async status(): Promise<MigrationStatus> {
    if (await this.#store.migrated(this.#source)) return 'imported';
    try {
      const info = await lstat(this.#legacyPath);
      if (!info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1
        || (info.mode & 0o7777) !== 0o600 || info.size < 30 || info.size > 4 * 1024 * 1024) return 'unavailable';
      return this.#requestKey ? 'approval_required' : 'unavailable';
    } catch (error) { return isMissing(error) ? 'absent' : 'unavailable'; }
  }

  async importWithApproval(): Promise<{ readonly status: 'imported'; readonly added: number }> {
    const status = await this.status();
    if (status === 'imported') return { status, added: 0 };
    const unavailable = new CredentialVaultError('VAULT_KEY_MISMATCH', 'Athena could not access the old login. The older vault is unchanged. Connect the provider again in Settings.');
    if (status !== 'approval_required' || !this.#requestKey) throw unavailable;
    const key = await this.#requestKey(this.#source).catch(() => undefined);
    if (!key) throw unavailable;
    try {
      if (key.length !== 32) throw unavailable;
      const credentials = await readLegacyCredentials(this.#legacyPath, key);
      const added = await this.#store.importLegacy(this.#source, credentials);
      return { status: 'imported', added };
    } finally { key.fill(0); }
  }
}
