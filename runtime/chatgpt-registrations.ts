import type { AuthOperationOptions, Credential, CredentialStore, OAuthCredential } from '@earendil-works/pi-ai';
import { ModelsError } from '@earendil-works/pi-ai/models';
import { setTimeout as delay } from 'node:timers/promises';
import { chatGPTAccountRef } from './chatgpt-catalog.ts';
import { object } from './connections.ts';
import { OpenAIRefreshRejected } from './openai-authorization.ts';

const issuer = 'https://auth.openai.com';
const discoveryUrl = `${issuer}/.well-known/openid-configuration`;
const prefix = 'chatgpt:';
const hostPattern = /^(?:urn:uuid:)?([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})$/iu;

export type ChatGPTRegistrationState = 'connected' | 'signed_out' | 'reauth_required';
export interface ChatGPTRegistrationLabels {
  readonly label?: string;
  readonly email?: string;
  readonly displayName?: string;
  readonly workspaceName?: string;
}
export interface ChatGPTRegistration extends ChatGPTRegistrationLabels {
  readonly authRef: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly subject: string;
  readonly extAgentHostId: string;
  readonly state: ChatGPTRegistrationState;
  readonly planUsage: 'enabled' | 'disabled';
  readonly label: string;
  /** Unix milliseconds; null for legacy records whose event time is unknown. */
  readonly lastAuthenticatedAt: number | null;
  readonly lastRefreshedAt: number | null;
}
export interface ChatGPTRegistrationsOptions {
  readonly credentials: CredentialStore;
  readonly currentHostId?: string;
  readonly fetch?: typeof fetch;
  readonly requestTimeoutMs?: number;
}
export type ChatGPTSignOutResult = {
  readonly registration: ChatGPTRegistration;
  readonly remote: 'revoked' | 'not_needed' | 'unconfirmed';
  readonly remoteFailure?: 'request_failed' | 'invalid_discovery' | 'revocation_rejected';
};

export class ChatGPTRegistrationError extends Error {
  readonly name = 'ChatGPTRegistrationError';
  readonly code: 'INVALID_REGISTRATION' | 'HOST_MISMATCH' | 'AUTH_REQUIRED' | 'SCOPED_PROVIDER';
  constructor(code: ChatGPTRegistrationError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

function invalid(): never {
  throw new ChatGPTRegistrationError('INVALID_REGISTRATION', 'Invalid ChatGPT registration.');
}

function opaque(value: unknown): value is string {
  return typeof value === 'string' && /^[!-~]{1,32768}$/u.test(value);
}

function host(value: unknown): string {
  const match = typeof value === 'string' ? hostPattern.exec(value) : null;
  if (!match?.[1]) return invalid();
  return `urn:uuid:${match[1].toLowerCase()}`;
}

function identity(value: Credential | undefined) {
  if (value?.type !== 'oauth' || value.issuer !== issuer || typeof value.clientId !== 'string'
    || !/^oaiapp_[\w-]{1,248}$/u.test(value.clientId) || !opaque(value.subject)) return undefined;
  const authRef = chatGPTAccountRef(value);
  if (!authRef) return undefined;
  return { authRef, issuer, clientId: value.clientId, subject: value.subject };
}

function labels(value: unknown, credential: OAuthCredential): ChatGPTRegistrationLabels {
  if (!object(value)) return {};
  const result: { label?: string; email?: string; displayName?: string; workspaceName?: string } = {};
  for (const key of ['label', 'email', 'displayName', 'workspaceName'] as const) {
    const text = value[key];
    if (text === undefined) continue;
    if (typeof text !== 'string' || !text.trim() || text.length > 256 || /[\u0000-\u001f\u007f]/u.test(text)
      || [credential.access, credential.refresh, credential.idToken].some(token =>
        typeof token === 'string' && token.length > 0 && text.includes(token))) return invalid();
    result[key] = text.trim();
  }
  return result;
}

function timestamps(metadata: unknown) {
  const value = object(metadata) ? metadata : {};
  const authenticated = value.lastAuthenticatedAt ?? null;
  const refreshed = value.lastRefreshedAt ?? null;
  for (const timestamp of [authenticated, refreshed]) {
    if (timestamp !== null && (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp) || timestamp < 0)) invalid();
  }
  // Narrow each field independently so stored, untyped metadata never leaks.
  if (authenticated !== null && typeof authenticated !== 'number') return invalid();
  if (refreshed !== null && typeof refreshed !== 'number') return invalid();
  return { lastAuthenticatedAt: authenticated, lastRefreshedAt: refreshed };
}

/**
 * Protected registration records live in the existing Pi vault. Reads fall
 * back to legacy `openai`; verified sign-in always writes the dedicated authRef
 * record. Migration never deletes or replaces the legacy provider key.
 * No operation changes an active account.
 *
 * registerVerified must receive only the result of the app's verified OpenAI
 * authorization flow, never a credential constructed from UI input/JWT decoding.
 */
export class ChatGPTRegistrations {
  readonly #credentials: CredentialStore;
  readonly #currentHostId: string | undefined;
  readonly #send: typeof fetch;
  readonly #timeout: number;

  constructor(options: ChatGPTRegistrationsOptions) {
    this.#credentials = options.credentials;
    this.#currentHostId = options.currentHostId === undefined ? undefined : host(options.currentHostId);
    this.#send = options.fetch ?? globalThis.fetch;
    this.#timeout = options.requestTimeoutMs ?? 5000;
    if (!Number.isSafeInteger(this.#timeout) || this.#timeout < 1 || this.#timeout > 15_000) invalid();
  }

  #binding(credential: OAuthCredential): string {
    const stored = credential.extAgentHostId ?? credential.ext_agent_host_id;
    const binding = stored === undefined ? this.#currentHostId : host(stored);
    if (!binding) return invalid();
    if (this.#currentHostId && binding !== this.#currentHostId) {
      throw new ChatGPTRegistrationError('HOST_MISMATCH', 'This ChatGPT registration belongs to another host.');
    }
    return binding;
  }

  #public(credential: OAuthCredential): ChatGPTRegistration {
    const account = identity(credential);
    if (!account) return invalid();
    const metadata = object(credential.registration) ? credential.registration : {};
    const state = metadata.state ?? (credential.access && credential.refresh ? 'connected' : 'signed_out');
    if (state !== 'connected' && state !== 'signed_out' && state !== 'reauth_required') return invalid();
    const publicLabels = labels(metadata.labels, credential);
    return { ...account, ...publicLabels, ...timestamps(metadata), extAgentHostId: this.#binding(credential), state,
      planUsage: state === 'connected' && Array.isArray(credential.scopes)
        && credential.scopes.includes('chatgpt.tokens.use.direct') ? 'enabled' : 'disabled',
      label: `${publicLabels.label ?? 'ChatGPT'} (${account.authRef.slice(-12)})` };
  }

  async #key(authRef: string, options?: AuthOperationOptions): Promise<string> {
    if (!/^chatgpt:[a-f\d]{64}$/u.test(authRef)) return invalid();
    const direct = await this.#credentials.read(authRef, options);
    if (direct !== undefined) {
      if (identity(direct)?.authRef !== authRef) return invalid();
      return authRef;
    }
    if (identity(await this.#credentials.read('openai', options))?.authRef === authRef) return 'openai';
    return authRef;
  }

  #checked(value: Credential | undefined, authRef: string): OAuthCredential {
    if (value?.type !== 'oauth' || identity(value)?.authRef !== authRef) {
      throw new ChatGPTRegistrationError('AUTH_REQUIRED', 'Reconnect the selected ChatGPT registration.');
    }
    this.#public(value);
    return value;
  }

  #tokens(credential: OAuthCredential): void {
    if (!opaque(credential.idToken)
      || !Number.isSafeInteger(credential.expires) || credential.expires < 0
      || !Array.isArray(credential.scopes) || credential.scopes.length === 0 || !credential.scopes.every(opaque)) invalid();
    const direct = credential.scopes.includes('chatgpt.tokens.use.direct');
    if ((!opaque(credential.access) && (direct || credential.access !== ''))
      || (!opaque(credential.refresh) && (direct || credential.refresh !== ''))) invalid();
  }

  #record(credential: OAuthCredential, publicLabels: ChatGPTRegistrationLabels,
    state: ChatGPTRegistrationState, times = timestamps(credential.registration)): OAuthCredential {
    const account = identity(credential);
    if (!account) return invalid();
    return { type: 'oauth', issuer, clientId: account.clientId, subject: account.subject,
      extAgentHostId: this.#binding(credential), access: credential.access, refresh: credential.refresh,
      expires: credential.expires, ...(credential.idToken === undefined ? {} : { idToken: credential.idToken }),
      ...(credential.scopes === undefined ? {} : { scopes: structuredClone(credential.scopes) }),
      registration: { version: 1, labels: publicLabels, state, ...times } };
  }

  async list(options?: AuthOperationOptions): Promise<readonly ChatGPTRegistration[]> {
    const result = new Map<string, ChatGPTRegistration>();
    for (const entry of await this.#credentials.list(options)) {
      if (entry.providerId !== 'openai' && !entry.providerId.startsWith(prefix)) continue;
      const value = await this.#credentials.read(entry.providerId, options);
      const account = identity(value);
      if (!account || value?.type !== 'oauth') continue;
      if (entry.providerId !== 'openai' && entry.providerId !== account.authRef) return invalid();
      const info = this.#public(value);
      if (!result.has(info.authRef) || entry.providerId !== 'openai') result.set(info.authRef, info);
    }
    return [...result.values()];
  }

  async lookup(authRef: string, options?: AuthOperationOptions): Promise<ChatGPTRegistration | undefined> {
    const value = await this.#credentials.read(await this.#key(authRef, options), options);
    return value === undefined ? undefined : this.#public(this.#checked(value, authRef));
  }

  async registerVerified(credential: OAuthCredential, publicLabels: ChatGPTRegistrationLabels = {},
    options?: AuthOperationOptions): Promise<ChatGPTRegistration> {
    const account = identity(credential);
    if (!account) return invalid();
    this.#tokens(credential);
    const safeLabels = labels(publicLabels, credential);
    const legacy = await this.#credentials.read('openai', options);
    const legacyAccount = identity(legacy)?.authRef === account.authRef ? legacy : undefined;
    const saved = await this.#credentials.modify(account.authRef, async current => {
      const previousValue = current ?? legacyAccount;
      const previous = previousValue === undefined ? undefined : this.#checked(previousValue, account.authRef);
      const binding = previous === undefined ? this.#binding(credential) : this.#binding(previous);
      const bound = { ...credential, extAgentHostId: credential.extAgentHostId
        ?? credential.ext_agent_host_id ?? this.#currentHostId ?? binding };
      if (this.#binding(bound) !== binding) {
        throw new ChatGPTRegistrationError('HOST_MISMATCH', 'Cannot change a ChatGPT registration host.');
      }
      const retained = previous && object(previous.registration) ? labels(previous.registration.labels, credential) : {};
      return this.#record(bound, { ...retained, ...safeLabels }, 'connected', {
        lastAuthenticatedAt: Date.now(), lastRefreshedAt: timestamps(previous?.registration).lastRefreshedAt,
      });
    }, options);
    return this.#public(this.#checked(saved, account.authRef));
  }

  /** Runtime-only OAuth selection/hints, including registrations awaiting sign-in.
   * Never serialize read results or hint-bearing authorization URLs to the UI.
   */
  forAuthorization(authRef: string): Pick<CredentialStore, 'read'> {
    return {
      read: async (provider, options) => {
        if (provider !== 'openai') return undefined;
        const value = await this.#credentials.read(await this.#key(authRef, options), options);
        return structuredClone(this.#checked(value, authRef));
      },
    };
  }

  /** Only runtime code may use this facade; its read/modify values contain secrets. */
  forRegistration(authRef: string): CredentialStore {
    const requireProvider = (provider: string) => {
      if (provider !== 'openai') throw new ChatGPTRegistrationError('SCOPED_PROVIDER', 'This store owns only OpenAI.');
    };
    const connected = (value: Credential | undefined) => {
      const credential = this.#checked(value, authRef);
      if (this.#public(credential).planUsage !== 'enabled') {
        throw new ChatGPTRegistrationError('AUTH_REQUIRED', 'Reconnect the selected ChatGPT registration.');
      }
      this.#tokens(credential);
      return credential;
    };
    return {
      read: async (provider, options) => {
        if (provider !== 'openai') return undefined;
        return structuredClone(connected(await this.#credentials.read(await this.#key(authRef, options), options)));
      },
      list: async options => {
        const info = await this.lookup(authRef, options);
        return info?.planUsage === 'enabled' ? [{ providerId: 'openai', type: 'oauth' }] : [];
      },
      modify: async (provider, modify, options) => {
        requireProvider(provider);
        let rejected: ModelsError | undefined;
        const saved = await this.#credentials.modify(await this.#key(authRef, options), async current => {
          const before = connected(current);
          let next: Credential | undefined;
          try { next = await modify(structuredClone(before)); }
          catch (error) {
            if (!(error instanceof ModelsError) || error.code !== 'oauth' || !(error.cause instanceof OpenAIRefreshRejected)) throw error;
            // Clear the exact token set which failed, under the same vault transaction as rotation.
            rejected = error;
            return this.#needsReauthorization(before);
          }
          if (next === undefined) return undefined;
          if (next.type !== 'oauth') return invalid();
          const after = this.#checked({ ...next, extAgentHostId: next.extAgentHostId
            ?? next.ext_agent_host_id ?? this.#binding(before), registration: before.registration }, authRef);
          this.#tokens(after);
          // Refresh implementations may return only token fields plus identity.
          // The registration binding and public metadata remain app-owned.
          if (this.#binding(after) !== this.#binding(before)) {
            throw new ChatGPTRegistrationError('HOST_MISMATCH', 'Cannot change a ChatGPT registration host.');
          }
          const metadata = object(before.registration) ? before.registration : {};
          return this.#record(after, labels(metadata.labels, after), 'connected', {
            ...timestamps(before.registration), lastRefreshedAt: Date.now(),
          });
        }, options);
        if (rejected) throw rejected;
        return saved;
      },
      delete: async () => {
        throw new ChatGPTRegistrationError('SCOPED_PROVIDER', 'Use registration sign-out to revoke and clear tokens.');
      },
    };
  }

  #needsReauthorization(credential: OAuthCredential): OAuthCredential {
    const metadata = object(credential.registration) ? credential.registration : {};
    return this.#record({ ...credential, access: '', refresh: '', expires: 0 }, labels(metadata.labels, credential), 'reauth_required');
  }

  async markReauthorizationRequired(authRef: string, options?: AuthOperationOptions): Promise<void> {
    await this.#credentials.modify(await this.#key(authRef, options), async current => {
      const credential = this.#checked(current, authRef);
      if (this.#public(credential).state === 'signed_out') return undefined;
      return this.#needsReauthorization(credential);
    }, options);
  }

  async #revoke(credential: OAuthCredential, options?: AuthOperationOptions):
    Promise<Pick<ChatGPTSignOutResult, 'remote' | 'remoteFailure'>> {
    if (!credential.refresh) return { remote: 'not_needed' };
    const signal = AbortSignal.any([AbortSignal.timeout(this.#timeout), ...(options?.signal ? [options.signal] : [])]);
    const aborted = Promise.withResolvers<never>();
    const abort = () => aborted.reject(new ChatGPTRegistrationError('AUTH_REQUIRED', 'Revocation request ended.'));
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      return await Promise.race([this.#revokeRequest(credential, signal), aborted.promise]);
    } catch {
      // Remote errors can contain credentials; expose only a fixed public code.
      return { remote: 'unconfirmed', remoteFailure: 'request_failed' };
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }

  async #revokeRequest(credential: OAuthCredential, signal: AbortSignal):
    Promise<Pick<ChatGPTSignOutResult, 'remote' | 'remoteFailure'>> {
    try {
      const response = await this.#send(discoveryUrl, {
        redirect: 'error', cache: 'no-store', headers: { Accept: 'application/json' }, signal,
      });
      signal.throwIfAborted();
      if (!response.ok || !response.body) return { remote: 'unconfirmed', remoteFailure: 'invalid_discovery' };
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const part = await reader.read();
          signal.throwIfAborted();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 64 * 1024) return { remote: 'unconfirmed', remoteFailure: 'invalid_discovery' };
          chunks.push(part.value);
        }
      } finally { await reader.cancel(); }
      const discovery: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!object(discovery) || discovery.issuer !== issuer || typeof discovery.revocation_endpoint !== 'string') {
        return { remote: 'unconfirmed', remoteFailure: 'invalid_discovery' };
      }
      const endpoint = new URL(discovery.revocation_endpoint);
      // Discovery may change the endpoint path, but never the official HTTPS
      // origin. Forbid URL credentials, query and fragment before sending tokens.
      if (endpoint.origin !== issuer || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
        return { remote: 'unconfirmed', remoteFailure: 'invalid_discovery' };
      }
      for (const backoff of [100, 250, 0]) {
        signal.throwIfAborted();
        try {
          const revoked = await this.#send(endpoint.href, {
            method: 'POST', redirect: 'error', cache: 'no-store', signal,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
            body: new URLSearchParams({ token: credential.refresh, token_type_hint: 'refresh_token',
              client_id: String(credential.clientId) }),
          });
          await revoked.body?.cancel();
          if (revoked.status === 200) return { remote: 'revoked' };
          if (revoked.status < 500 || backoff === 0) return { remote: 'unconfirmed', remoteFailure: 'revocation_rejected' };
        } catch {
          if (backoff === 0) return { remote: 'unconfirmed', remoteFailure: 'request_failed' };
        }
        await delay(backoff, undefined, { signal });
      }
      return { remote: 'unconfirmed', remoteFailure: 'request_failed' };
    } catch {
      // Transport and parsing errors are deliberately reduced to a public code;
      // fetch errors/responses may contain tokens and must never reach the UI.
      return { remote: 'unconfirmed', remoteFailure: 'request_failed' };
    }
  }

  async signOut(authRef: string, options?: AuthOperationOptions): Promise<ChatGPTSignOutResult> {
    const key = await this.#key(authRef);
    let remote: Pick<ChatGPTSignOutResult, 'remote' | 'remoteFailure'> = { remote: 'not_needed' };
    const clear = (credential: OAuthCredential) => {
      const metadata = object(credential.registration) ? credential.registration : {};
      return this.#record({ ...credential, access: '', refresh: '', expires: 0, idToken: undefined,
        scopes: undefined }, labels(metadata.labels, credential), 'signed_out');
    };
    // Keep revocation and clearing in the same existing vault lock as refresh.
    // Cancellation of remote work must not cancel the local token clearing.
    const cleared = await this.#credentials.modify(key, async current => {
      const credential = this.#checked(current, authRef);
      remote = await this.#revoke(credential, options);
      return clear(credential);
    });
    if (key !== 'openai') {
      // A pre-migration copy may still hold this registration's tokens. Clear
      // only an exact identity match under its own lock, preserving API keys
      // and other registrations that may now own the legacy provider key.
      await this.#credentials.modify('openai', async current =>
        identity(current)?.authRef === authRef ? clear(this.#checked(current, authRef)) : undefined);
    }
    return { registration: this.#public(this.#checked(cleared, authRef)), ...remote };
  }
}
