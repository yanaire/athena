import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { ModelCheck, ModelProfile, ResolvedModelReference } from '../athena-backend-handoff/athena-codex-ui/integrations/model-profiles.d.ts';
import { object } from './connections.ts';
import { ManagerError } from './orchestration.ts';
import type { CompatibleProvider } from './provider-manager.ts';

type CatalogLookup = (provider: string, model: string) => Model<Api> | undefined;

function field(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\x00-\x1f\x7f]/u.test(value)) {
    throw new ManagerError('INVALID_PROFILE', `Enter a valid ${label}.`);
  }
  return value.trim();
}

function decode(body: unknown): ModelProfile {
  if (typeof body !== 'string') throw new ManagerError('INVALID_PROFILE', 'The stored model profile could not be read.');
  const profile: ModelProfile = JSON.parse(body);
  return profile;
}

export class ModelProfiles {
  readonly #db: DatabaseSync;
  readonly #lookup: CatalogLookup;
  readonly #endpoint: (provider: string) => string | undefined;

  constructor(directory: string, lookup: CatalogLookup, endpoint: (provider: string) => string | undefined = () => undefined) {
    this.#lookup = lookup;
    this.#endpoint = endpoint;
    this.#db = new DatabaseSync(join(directory, 'connections.sqlite'));
    this.#db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS model_profiles (
      id TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS model_profile_default (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT REFERENCES model_profiles(id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS compatible_providers (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;`);
  }

  compatibleProviders(): readonly CompatibleProvider[] {
    return this.#db.prepare('SELECT body FROM compatible_providers ORDER BY rowid').all().map(row => {
      if (typeof row.body !== 'string') throw new Error('Invalid stored endpoint.');
      const provider: CompatibleProvider = JSON.parse(row.body);
      return provider;
    });
  }

  saveEndpoint(provider: CompatibleProvider): void {
    this.#db.prepare('INSERT INTO compatible_providers VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body')
      .run(provider.id, JSON.stringify(provider));
  }

  list(): readonly ModelProfile[] {
    return this.#db.prepare('SELECT body FROM model_profiles ORDER BY rowid').all().map(row => decode(row.body));
  }

  get(id: string): ModelProfile {
    const row = this.#db.prepare('SELECT body FROM model_profiles WHERE id=?').get(id);
    if (!row) throw new ManagerError('PROFILE_NOT_FOUND', 'The selected model profile no longer exists.');
    return decode(row.body);
  }

  get appDefaultProfileId(): string | null {
    const value = this.#db.prepare('SELECT id FROM model_profile_default WHERE singleton=1').get()?.id;
    return typeof value === 'string' ? value : null;
  }

  setAppDefault(id: string | null): void {
    if (id !== null) this.get(id);
    this.#db.prepare('INSERT INTO model_profile_default VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET id=excluded.id').run(id);
  }

  save(input: unknown): ModelProfile {
    if (!object(input)) throw new ManagerError('INVALID_PROFILE', 'Expected a model profile.');
    const id = input.id === undefined ? randomUUID() : field(input.id, 'profile ID');
    const old = input.id === undefined ? undefined : this.get(id);
    if (old && input.revision !== old.revision) throw new ManagerError('PROFILE_CONFLICT', 'The profile changed. Reload it before saving.');
    const name = field(input.name, 'profile name');
    const provider = field(input.provider, 'provider');
    const modelId = field(input.modelId, 'model ID');
    const model = this.#lookup(provider, modelId);
    if (!model) throw new ManagerError('MODEL_UNAVAILABLE', 'This model is not in the selected provider catalog.');
    const thinkingLevel = getSupportedThinkingLevels(model).find(level => level === (input.thinkingLevel ?? 'off'));
    if (thinkingLevel === undefined) throw new ManagerError('MODEL_UNAVAILABLE', 'The model does not support the requested reasoning level.');
    const endpoint = this.#endpoint(provider);
    const profile: ModelProfile = { id, name, provider, modelId, thinkingLevel,
      revision: (old?.revision ?? 0) + 1, authRef: provider, ...(endpoint ? { endpoint } : {}) };
    this.#db.prepare(`INSERT INTO model_profiles VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,body=excluded.body`)
      .run(id, profile.revision, JSON.stringify(profile));
    return profile;
  }

  remove(id: string, revision: unknown): void {
    const profile = this.get(id);
    if (profile.revision !== revision) throw new ManagerError('PROFILE_CONFLICT', 'The profile changed. Reload it before deleting.');
    if (this.appDefaultProfileId === id) throw new ManagerError('PROFILE_IN_USE', 'Clear the app default before deleting this profile.');
    this.#db.prepare('DELETE FROM model_profiles WHERE id=? AND revision=?').run(id, profile.revision);
  }

  recordCheck(id: string, revision: number, lastCheck: ModelCheck): ModelProfile {
    const profile = this.get(id);
    if (profile.revision !== revision) throw new ManagerError('PROFILE_CONFLICT', 'The profile changed during verification. Check the new revision.');
    const update = { ...profile, lastCheck };
    this.#db.prepare('UPDATE model_profiles SET body=? WHERE id=? AND revision=?').run(JSON.stringify(update), id, revision);
    return update;
  }

  resolve(conversation: string | null | undefined, project: string | null | undefined): ResolvedModelReference | null {
    const id = conversation ?? project ?? this.appDefaultProfileId;
    if (id === null) return null;
    const profile = this.get(id);
    const model = this.#lookup(profile.provider, profile.modelId);
    if (!model) throw new ManagerError('MODEL_UNAVAILABLE', 'The selected profile model is no longer in its provider catalog.');
    return { provider: profile.provider, modelId: profile.modelId, thinkingLevel: profile.thinkingLevel,
      profileId: profile.id, configurationRevision: profile.revision, api: model.api,
      ...(profile.endpoint ? { endpoint: profile.endpoint } : {}), source: conversation ? 'conversation' : project ? 'project' : 'app' };
  }

  close(): void { this.#db.close(); }
}
