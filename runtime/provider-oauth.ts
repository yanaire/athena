import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, open, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CredentialStore } from '@earendil-works/pi-ai';
import { CredentialSynchronizationError } from '@earendil-works/pi-coding-agent';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createOpenAIAuthorization, OPENAI_AUTHORIZE_URL } from './openai-authorization.ts';
import { CredentialPersistenceError } from './provider-credentials.ts';
import type { ProviderOAuthFlow } from '../athena-backend-handoff/athena-codex-ui/integrations/model-profiles.d.ts';

export interface OpenAIOAuthRegistrationOptions {
  readonly credentials: Pick<CredentialStore, 'read'>;
  readonly deviceIdDirectory: string;
  readonly fetch?: typeof fetch;
  readonly previousRegistration?: { readonly clientId: string; readonly subject: string };
  readonly nativeBrowser?: boolean;
  readonly requestConsent?: boolean;
}

export interface ProviderOAuthControllerOptions extends OpenAIOAuthRegistrationOptions {
  readonly runtime: ModelRuntime;
  readonly openAI?: boolean;
  readonly openRouter?: boolean;
  readonly prepareOpenAI?: (accountRef: string | undefined, signal: AbortSignal) => Promise<ModelRuntime>;
}

export class ProviderOAuthError extends Error {
  readonly name = 'ProviderOAuthError';
  readonly code: 'UNSUPPORTED_AUTH' | 'CLOSED' | 'DEVICE_ID' | 'BROWSER_FAILED';

  constructor(code: ProviderOAuthError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

async function readDeviceId(path: string): Promise<string | undefined> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size !== 37) {
        throw new ProviderOAuthError('DEVICE_ID', 'Invalid Athena OAuth device ID file.');
      }
      return (await file.readFile('utf8')).trimEnd();
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function loadDeviceId(directory: string): Promise<string> {
  const path = join(directory, 'openai-oauth-device.v1');
  const saved = await readDeviceId(path);
  if (saved !== undefined) return saved;
  const id = randomUUID();
  const temporary = join(directory, `openai-oauth-device-${randomUUID()}.tmp`);
  await writeFile(temporary, `${id}\n`, { flag: 'wx', mode: 0o600 });
  try {
    // Publish a complete ID without ever replacing an existing installation's ID.
    await link(temporary, path);
    return id;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      const winner = await readDeviceId(path);
      if (winner !== undefined) return winner;
    }
    throw error;
  } finally {
    await unlink(temporary);
  }
}

const registered = new WeakMap<ModelRuntime, ReturnType<typeof createOpenAIAuthorization>>();

/** Replace only OAuth; retain the registered OpenAI model catalog and its native API. */
export function registerOpenAIOAuth(runtime: ModelRuntime, options: OpenAIOAuthRegistrationOptions): void {
  const provider = runtime.getProvider('openai');
  if (!provider) throw new ProviderOAuthError('UNSUPPORTED_AUTH', 'This runtime does not register OpenAI.');
  if (registered.has(runtime) && registered.get(runtime) === provider.auth.oauth) return;
  const oauth = createOpenAIAuthorization({ credentials: options.credentials, fetch: options.fetch,
    previousRegistration: options.previousRegistration, nativeBrowser: options.nativeBrowser, requestConsent: options.requestConsent,
    getDeviceId: () => loadDeviceId(options.deviceIdDirectory) });
  runtime.registerNativeProvider({ ...provider, auth: { ...provider.auth, oauth } });
  registered.set(runtime, oauth);
}

const authorizeParameters = new Set(['client_id', 'agent_name_hint', 'ext_agent_host_id', 'response_type', 'redirect_uri',
  'resource', 'scope', 'state', 'nonce', 'code_challenge_method', 'code_challenge', 'prompt']);

const openRouterAuthorizeParameters = new Set(['callback_url', 'code_challenge', 'code_challenge_method']);

function checkedAuthorizeUrl(providerId: string, raw: string, nativeBrowser: boolean): string {
  const url = new URL(raw);
  const openAI = providerId === 'openai';
  const endpoint = openAI ? OPENAI_AUTHORIZE_URL : 'https://openrouter.ai/auth';
  const allowed = openAI ? authorizeParameters : openRouterAuthorizeParameters;
  if (raw.length > 36_000 || `${url.origin}${url.pathname}` !== endpoint || url.username || url.password || url.hash
    || (openAI && url.searchParams.has('prompt') && url.searchParams.get('prompt') !== 'consent')
    || [...url.searchParams].some(([key]) => (!allowed.has(key) && !(openAI && nativeBrowser && key === 'id_token_hint')) || url.searchParams.getAll(key).length !== 1)) {
    throw new ProviderOAuthError('UNSUPPORTED_AUTH', 'Unexpected provider sign-in URL.');
  }
  const redirect = new URL(url.searchParams.get(openAI ? 'redirect_uri' : 'callback_url') ?? '');
  const validPath = openAI ? redirect.pathname === '/auth/callback'
    : /^\/oauth\/callback\/[0-9a-f-]{36}$/u.test(redirect.pathname);
  if (redirect.protocol !== 'http:' || redirect.hostname !== '127.0.0.1' || !redirect.port || !validPath
    || redirect.username || redirect.password || redirect.search || redirect.hash || url.searchParams.get('code_challenge_method') !== 'S256') {
    throw new ProviderOAuthError('UNSUPPORTED_AUTH', 'Unexpected provider callback URL.');
  }
  return url.href;
}

type TerminalStatus = Exclude<ProviderOAuthFlow['status'], 'pending'>;

interface ActiveFlow {
  readonly id: string;
  readonly controller: AbortController;
  readonly done: Promise<void>;
  readonly providerId: string;
  authorizeUrl?: string;
}

export class ProviderOAuthController {
  readonly #runtime: ModelRuntime;
  readonly #enabled: ReadonlySet<string>;
  readonly #prepareOpenAI: ProviderOAuthControllerOptions['prepareOpenAI'];
  readonly #nativeBrowser: boolean;
  readonly #terminal = new Map<string, ProviderOAuthFlow>();
  #active?: ActiveFlow;
  #closed = false;

  constructor(options: ProviderOAuthControllerOptions) {
    const openAI = options.openAI ?? true;
    if (openAI) registerOpenAIOAuth(options.runtime, options);
    this.#enabled = new Set([...(openAI ? ['openai'] : []), ...(options.openRouter ? ['openrouter'] : [])]);
    this.#runtime = options.runtime;
    this.#prepareOpenAI = options.prepareOpenAI;
    this.#nativeBrowser = options.nativeBrowser === true;
  }

  start(providerId: string, accountRef?: string): ProviderOAuthFlow {
    if (this.#closed) throw new ProviderOAuthError('CLOSED', 'Athena OAuth is closed.');
    if (!this.#enabled.has(providerId)) throw new ProviderOAuthError('UNSUPPORTED_AUTH', 'This provider has no Athena OAuth flow.');
    if (this.#active?.providerId === providerId) return { id: this.#active.id, status: 'pending' };
    if (this.#active) throw new ProviderOAuthError('UNSUPPORTED_AUTH', 'Finish or cancel the current sign-in first.');
    const id = randomUUID();
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(300_000)]);
    const target = providerId === 'openai' && this.#prepareOpenAI ? this.#prepareOpenAI(accountRef, signal) : Promise.resolve(this.#runtime);
    const done = target.then(runtime => runtime.login(providerId, 'oauth', {
      signal,
      notify: event => {
        if (event.type === 'auth_url' && this.#active?.id === id && !controller.signal.aborted) {
          this.#active.authorizeUrl = checkedAuthorizeUrl(providerId, event.url, this.#nativeBrowser);
        }
      },
      prompt: async prompt => {
        if (prompt.type !== 'manual_code' || providerId !== 'openrouter') {
          throw new ProviderOAuthError('UNSUPPORTED_AUTH', 'This sign-in requires the loopback callback.');
        }
        // Pi races manual input against its listener. Keep the manual branch
        // pending until the listener wins or the flow is cancelled.
        const timeout = AbortSignal.any(prompt.signal ? [signal, prompt.signal] : [signal]);
        timeout.throwIfAborted();
        return new Promise<string>((_, reject) => timeout.addEventListener('abort', () => reject(timeout.reason), { once: true }));
      },
    })).then(() => this.#finish(id, 'succeeded'), (error: unknown) => {
      // Pi can abort a queued write, but once its commit starts, it owns the write.
      // A synchronization error is raised only after Pi commits the credential.
      if (error instanceof CredentialSynchronizationError) this.#finish(id, 'succeeded');
      else if (error instanceof Error && error.cause instanceof CredentialPersistenceError) this.#finish(id, 'failed', 'credential_save_failed');
      else if (controller.signal.aborted) this.#finish(id, 'cancelled');
      else this.#finish(id, 'failed', 'authorization_failed');
    });
    this.#active = { id, controller, done, providerId };
    return { id, status: 'pending' };
  }

  #finish(id: string, status: TerminalStatus, error?: ProviderOAuthFlow['error']): void {
    this.#active = undefined;
    this.#terminal.set(id, { id, status, ...(error ? { error } : {}) });
    if (this.#terminal.size > 32) {
      const oldest = this.#terminal.keys().next().value;
      if (oldest !== undefined) this.#terminal.delete(oldest);
    }
  }

  status(id: string): ProviderOAuthFlow | undefined {
    if (this.#active?.id === id) {
      const url = this.#active.controller.signal.aborted ? undefined : this.#active.authorizeUrl;
      return { id, status: 'pending', ...(url ? this.#nativeBrowser ? { browserReady: true } : { authorizeUrl: url } : {}) };
    }
    return this.#terminal.get(id);
  }

  authorizeUrl(id: string): string {
    const url = this.#nativeBrowser && this.#active?.id === id && !this.#active.controller.signal.aborted ? this.#active.authorizeUrl : undefined;
    if (!url) throw new ProviderOAuthError('UNSUPPORTED_AUTH', 'This sign-in has no browser page to open.');
    return url;
  }

  cancel(id: string): ProviderOAuthFlow | undefined {
    if (this.#active?.id === id) this.#active.controller.abort();
    return this.status(id);
  }

  async close(): Promise<void> {
    this.#closed = true;
    const active = this.#active;
    active?.controller.abort();
    await active?.done;
    this.#terminal.clear();
  }
}
