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
}

export interface ProviderOAuthControllerOptions extends OpenAIOAuthRegistrationOptions {
  readonly runtime: ModelRuntime;
}

export class ProviderOAuthError extends Error {
  readonly name = 'ProviderOAuthError';
  readonly code: 'UNSUPPORTED_AUTH' | 'CLOSED' | 'DEVICE_ID';

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

async function loadDeviceId(directory: string): Promise<string> {
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
    getDeviceId: () => loadDeviceId(options.deviceIdDirectory) });
  runtime.registerNativeProvider({ ...provider, auth: { ...provider.auth, oauth } });
  registered.set(runtime, oauth);
}

const authorizeParameters = new Set(['client_id', 'agent_name_hint', 'ext_agent_host_id', 'response_type', 'redirect_uri',
  'resource', 'scope', 'state', 'nonce', 'code_challenge_method', 'code_challenge']);

function publicAuthorizeUrl(raw: string): string {
  const url = new URL(raw);
  if (`${url.origin}${url.pathname}` !== OPENAI_AUTHORIZE_URL || url.username || url.password || url.hash
    || [...url.searchParams].some(([key]) => !authorizeParameters.has(key) || url.searchParams.getAll(key).length !== 1)) {
    throw new ProviderOAuthError('UNSUPPORTED_AUTH', 'Unexpected OpenAI sign-in URL.');
  }
  return url.href;
}

type TerminalStatus = Exclude<ProviderOAuthFlow['status'], 'pending'>;

interface ActiveFlow {
  readonly id: string;
  readonly controller: AbortController;
  readonly done: Promise<void>;
  authorizeUrl?: string;
}

export class ProviderOAuthController {
  readonly #runtime: ModelRuntime;
  readonly #terminal = new Map<string, ProviderOAuthFlow>();
  #active?: ActiveFlow;
  #closed = false;

  constructor(options: ProviderOAuthControllerOptions) {
    registerOpenAIOAuth(options.runtime, options);
    this.#runtime = options.runtime;
  }

  start(providerId: string): ProviderOAuthFlow {
    if (this.#closed) throw new ProviderOAuthError('CLOSED', 'Athena OAuth is closed.');
    if (providerId !== 'openai') throw new ProviderOAuthError('UNSUPPORTED_AUTH', 'This provider has no Athena OAuth flow.');
    if (this.#active) return { id: this.#active.id, status: 'pending' };
    const id = randomUUID();
    const controller = new AbortController();
    const done = this.#runtime.login('openai', 'oauth', {
      signal: controller.signal,
      notify: event => {
        if (event.type === 'auth_url' && this.#active?.id === id && !controller.signal.aborted) {
          this.#active.authorizeUrl = publicAuthorizeUrl(event.url);
        }
      },
      prompt: async () => { throw new ProviderOAuthError('UNSUPPORTED_AUTH', 'OpenAI sign-in requires the loopback callback.'); },
    }).then(() => this.#finish(id, 'succeeded'), (error: unknown) => {
      // Pi can abort a queued write, but once its commit starts, it owns the write.
      // A synchronization error is raised only after Pi commits the credential.
      if (error instanceof CredentialSynchronizationError) this.#finish(id, 'succeeded');
      else if (error instanceof Error && error.cause instanceof CredentialPersistenceError) this.#finish(id, 'failed', 'credential_save_failed');
      else if (controller.signal.aborted) this.#finish(id, 'cancelled');
      else this.#finish(id, 'failed', 'authorization_failed');
    });
    this.#active = { id, controller, done };
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
      return { id, status: 'pending', ...(url ? { authorizeUrl: url } : {}) };
    }
    return this.#terminal.get(id);
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
