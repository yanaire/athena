import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { NonsecretModelConfiguration, ConnectionSnapshot, ModelReference } from '../athena-backend-handoff/athena-codex-ui/integrations/connections.d.ts';

export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Credentials are bound to the operator's endpoint, never to a URL supplied by a browser.
export function baseURL(value: string) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))) {
    throw new TypeError('Use HTTPS, or HTTP on loopback, without credentials, query or fragment.');
  }
  return url.href.replace(/\/+$/, '');
}

export class Connections {
  readonly db: DatabaseSync;
  readonly defaults: NonsecretModelConfiguration;
  readonly model: ModelReference;
  #verification: NonNullable<ConnectionSnapshot['verification']> = { status: 'not_checked' };
  #key: string | undefined;

  constructor(directory: string, endpoint: string, model: ModelReference, key?: string) {
    this.model = model;
    this.#key = key;
    this.defaults = { version: 1, provider: 'openai-compatible', endpoint: baseURL(endpoint), defaultModel: model.modelId,
      roleModels: { main: '', researcher: '', analyst: '', reviewer: '', writer: '' }, parallelLimit: 1,
      contextBudget: 32768, outputBudget: 4096 };
    this.db = new DatabaseSync(join(directory, 'connections.sqlite'));
    this.db.exec(`CREATE TABLE IF NOT EXISTS config (singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      id TEXT NOT NULL, revision INTEGER NOT NULL, configuration TEXT NOT NULL) STRICT`);
  }

  #parse(input: unknown): NonsecretModelConfiguration {
    if (!object(input) || input.version !== 1 || typeof input.endpoint !== 'string' ||
        baseURL(input.endpoint) !== this.defaults.endpoint || input.defaultModel !== this.model.modelId) {
      throw new TypeError('Use the endpoint and model configured on the Athena host.');
    }
    const provider = input.provider;
    if (provider !== 'local' && provider !== 'openai-compatible' && provider !== 'custom') throw new TypeError('Unknown connection preset.');
    const roles = input.roleModels;
    if (input.parallelLimit !== 1 || input.contextBudget !== 32768 || input.outputBudget !== 4096 || !object(roles) ||
        Object.keys(this.defaults.roleModels).some(k => roles[k] !== '')) throw new TypeError('This host supports one agent and fixed model budgets.');
    return { ...this.defaults, provider };
  }

  getState() {
    const row = this.db.prepare('SELECT * FROM config WHERE singleton=1').get();
    // Changing the operator pin must never silently reuse an old connection receipt.
    const saved = row && JSON.parse(String(row.configuration)) as NonsecretModelConfiguration | undefined;
    const matches = saved?.endpoint === this.defaults.endpoint && saved.defaultModel === this.model.modelId;
    return { status: this.#verification.status === 'connected' ? 'connected' : this.#verification.status === 'failed' ? 'error' : matches ? 'configured' : 'disconnected',
      ...(row && matches ? { configurationId: String(row.id), revision: Number(row.revision) } : {}),
      defaultModel: this.model, configuration: matches ? saved : this.defaults, verification: this.#verification } as const;
  }

  saveConfig(input: unknown) {
    const config = this.#parse(input);
    const row = this.db.prepare(`INSERT INTO config VALUES(1,?,1,?) ON CONFLICT(singleton) DO UPDATE SET
      id=excluded.id,revision=config.revision+1,configuration=excluded.configuration RETURNING id,revision`).get(randomUUID(), JSON.stringify(config));
    if (!row) throw new Error('Settings were not saved.');
    return { saved: true, configurationId: String(row.id), revision: Number(row.revision), configuration: config, defaultModel: this.model } as const;
  }

  async verifyConnection(input: unknown) {
    try {
      const config = this.#parse(input);
      const r = await fetch(config.endpoint + '/models', { headers: this.#key ? { Authorization: `Bearer ${this.#key}` } : {}, redirect: 'error', signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? `Authentication failed (HTTP ${r.status}).` : `Model listing unavailable (HTTP ${r.status}).`);
      const body: unknown = await r.json();
      if (!object(body) || !Array.isArray(body.data)) throw new Error('Endpoint returned no compatible model list.');
      if (!body.data.some(entry => object(entry) && entry.id === config.defaultModel)) throw new Error('The configured model was not found on this endpoint.');
      this.#verification = { status: 'connected', checkedAt: new Date().toISOString() };
      return { ...this.#verification, models: [this.model] };
    } catch (error) {
      this.#verification = { status: 'failed', checkedAt: new Date().toISOString(), message: error instanceof Error ? error.message : 'Connection check failed.' };
      return this.#verification;
    }
  }

  close() { this.db.close(); }
}
