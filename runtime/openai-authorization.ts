import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { CredentialStore, OAuthAuth, OAuthCredential } from '@earendil-works/pi-ai';
import { object } from './connections.ts';
import { CHATGPT_RESOURCE } from './chatgpt-catalog.ts';

// https://developers.openai.com/siwc/token-sharing-open-source/sign-in
const issuer = 'https://auth.openai.com';
export const OPENAI_AUTHORIZE_URL = `${issuer}/api/accounts/authorize`;
const tokenUrl = `${issuer}/api/accounts/oauth/token`;
const jwksUrl = `${issuer}/.well-known/jwks.json`;
const resource = CHATGPT_RESOURCE;
const loopback = '127.0.0.1';
const callbackPath = '/auth/callback';
const dynamicClient = 'dynamic_agent_client';
const directScope = 'chatgpt.tokens.use.direct';
const requestedScope = `openid profile email offline_access resource.invoke ${directScope}`;
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu;
const jwtSegment = /^[\w-]+$/u;

export interface OpenAIAuthorizationOptions {
  readonly credentials: Pick<CredentialStore, 'read'>;
  readonly getDeviceId: () => Promise<string>;
  readonly previousRegistration?: { readonly clientId: string; readonly subject: string };
  readonly nativeBrowser?: boolean;
  readonly requestConsent?: boolean;
  readonly fetch?: typeof fetch;
}

class OpenAIAuthorizationError extends Error {
  readonly name = 'OpenAIAuthorizationError';
}

const terminalRefreshCodes = new Set([
  'invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired',
  'refresh_token_invalidated', 'refresh_token_reused',
]);

export class OpenAIRefreshRejected extends Error {
  constructor() { super('The ChatGPT session must be reauthorized.'); }
}

function opaque(value: unknown): value is string {
  return typeof value === 'string' && /^[!-~]{1,32768}$/u.test(value);
}

function issuedClient(value: unknown): value is string {
  return typeof value === 'string' && /^oaiapp_[\w-]{1,248}$/u.test(value);
}

function registration(value: OAuthCredential | undefined) {
  if (value?.issuer === issuer && issuedClient(value.clientId) && opaque(value.subject) && opaque(value.idToken)) {
    return { issuer, clientId: value.clientId, subject: value.subject, idToken: value.idToken };
  }
}

function hasDirectScope(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(opaque) && value.includes(directScope);
}

function decode(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

function matchesAudience(audience: unknown, azp: unknown, clientId: string): boolean {
  if (azp !== undefined && azp !== clientId) return false;
  return audience === clientId || (Array.isArray(audience) && audience.every(opaque)
    && audience.includes(clientId) && (audience.length === 1 || azp === clientId));
}

async function authorizeCallback(input: {
  readonly state: string;
  readonly clientId?: string;
  readonly signal: AbortSignal;
  readonly announce: (redirectUri: string) => void;
}) {
  const callback = Promise.withResolvers<{ code: string; clientId: string } | undefined>();
  let redirect: URL;
  let consumed = false;
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.setHeader('Connection', 'close');
    const url = request.url;
    if (request.method !== 'GET' || request.headers.host !== redirect.host
      || url?.split('?', 1)[0] !== callbackPath) {
      response.writeHead(404).end('Not found.');
      return;
    }
    const params = new URL(url, redirect).searchParams;
    const states = params.getAll('state');
    if (consumed || states.length !== 1 || states[0] !== input.state) {
      response.writeHead(400).end('Invalid sign-in callback.');
      return;
    }
    consumed = true;
    const codes = params.getAll('code');
    const clientIds = params.getAll('client_id');
    const clientId = clientIds[0] ?? input.clientId;
    if (params.has('error') || codes.length !== 1 || !opaque(codes[0]) || clientIds.length > 1
      || !issuedClient(clientId) || (input.clientId !== undefined && input.clientId !== clientId)) {
      response.writeHead(400).end('ChatGPT sign-in did not complete. You can close this window.');
      callback.resolve(undefined);
      return;
    }
    response.writeHead(202).end('Callback received. Check Athena for the sign-in result.');
    callback.resolve({ code: codes[0], clientId });
  });
  const abort = () => callback.resolve(undefined);
  input.signal.addEventListener('abort', abort, { once: true });
  server.on('error', abort);
  try {
    input.signal.throwIfAborted();
    const listening = once(server, 'listening', { signal: input.signal });
    server.listen({ host: loopback, port: 0, signal: input.signal, exclusive: true });
    await listening;
    const address = server.address();
    if (!address || typeof address === 'string' || address.address !== loopback) {
      throw new OpenAIAuthorizationError('Could not bind the OpenAI sign-in loopback listener.');
    }
    redirect = new URL(`http://${loopback}:${address.port}${callbackPath}`);
    input.announce(redirect.href);
    const result = await callback.promise;
    input.signal.throwIfAborted();
    if (!result) throw new OpenAIAuthorizationError('OpenAI did not complete authorization.');
    return { ...result, redirectUri: redirect.href };
  } finally {
    input.signal.removeEventListener('abort', abort);
    server.close();
    server.closeAllConnections();
  }
}

export function createOpenAIAuthorization(options: OpenAIAuthorizationOptions): OAuthAuth {
  const send = options.fetch ?? globalThis.fetch;
  let cachedKeys: { readonly keys: readonly unknown[]; readonly expires: number } | undefined;

  async function request(url: string, signal: AbortSignal, body?: URLSearchParams): Promise<unknown> {
    try {
      const response = await send(url, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        ...(body ? { method: 'POST', body } : {}), headers: { Accept: 'application/json' } });
      if (!response.ok) {
        if (url === tokenUrl && body?.get('grant_type') === 'refresh_token' && [400, 401].includes(response.status)) {
          const failure: unknown = await response.json();
          if (object(failure) && typeof failure.error === 'string' && terminalRefreshCodes.has(failure.error)) {
            throw new OpenAIRefreshRejected();
          }
        }
        throw new OpenAIAuthorizationError('OpenAI declined the OAuth request.');
      }
      return await response.json();
    } catch (error) {
      if (error instanceof OpenAIRefreshRejected) throw error;
      signal.throwIfAborted();
      throw new OpenAIAuthorizationError('OpenAI OAuth request failed.');
    }
  }

  async function signingKey(kid: string, signal: AbortSignal) {
    const match = (value: unknown) => object(value) && value.kid === kid;
    if (!cachedKeys || cachedKeys.expires <= Date.now() || !cachedKeys.keys.some(match)) {
      const jwks = await request(jwksUrl, signal);
      if (!object(jwks) || !Array.isArray(jwks.keys)) throw new OpenAIAuthorizationError('Invalid OpenAI signing keys.');
      cachedKeys = { keys: jwks.keys, expires: Date.now() + 300_000 };
    }
    const keys = cachedKeys.keys.filter(match);
    const key = keys[0];
    if (keys.length !== 1 || !object(key) || key.kty !== 'RSA' || key.use !== 'sig' || key.alg !== 'RS256'
      || typeof key.n !== 'string' || typeof key.e !== 'string') {
      throw new OpenAIAuthorizationError('Unknown OpenAI signing key.');
    }
    return createPublicKey({ key: { kty: 'RSA', n: key.n, e: key.e }, format: 'jwk' });
  }

  async function identity(idToken: string, expected: { readonly clientId: string; readonly nonce?: string }, signal: AbortSignal) {
    const invalid = new OpenAIAuthorizationError('OpenAI ID token could not be verified.');
    try {
      const parts = idToken.split('.');
      const [headerPart, payloadPart, signaturePart] = parts;
      if (parts.length !== 3 || !headerPart || !payloadPart || !signaturePart || !parts.every(part => jwtSegment.test(part))) throw invalid;
      const header = decode(headerPart);
      if (!object(header) || header.alg !== 'RS256' || !opaque(header.kid) || header.crit !== undefined) throw invalid;
      const key = await signingKey(header.kid, signal);
      if (!verify('RSA-SHA256', Buffer.from(`${headerPart}.${payloadPart}`), key, Buffer.from(signaturePart, 'base64url'))) throw invalid;
      const claims = decode(payloadPart);
      const now = Date.now() / 1000;
      if (!object(claims) || claims.iss !== issuer || !opaque(claims.sub) || !matchesAudience(claims.aud, claims.azp, expected.clientId)
        || typeof claims.exp !== 'number' || !Number.isSafeInteger(claims.exp) || claims.exp <= now
        || (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || !Number.isSafeInteger(claims.nbf) || claims.nbf > now))
        || (expected.nonce !== undefined && claims.nonce !== expected.nonce)) throw invalid;
      const displayName = typeof claims.name === 'string' && /^[^\u0000-\u001f\u007f]{1,256}$/u.test(claims.name) ? claims.name.trim() : '';
      const email = claims.email_verified === true && typeof claims.email === 'string' && /^[^\s\u0000-\u001f\u007f@]+@[^\s\u0000-\u001f\u007f@]+$/u.test(claims.email)
        && claims.email.length <= 256 ? claims.email : '';
      return { issuer, subject: claims.sub, clientId: expected.clientId, idToken,
        ...(displayName ? { displayName } : {}), ...(email ? { email } : {}) };
    } catch {
      signal.throwIfAborted();
      throw invalid;
    }
  }

  async function exchange(form: Record<string, string>, signal: AbortSignal) {
    const token = await request(tokenUrl, signal, new URLSearchParams({ ...form, resource }));
    signal.throwIfAborted();
    if (!object(token) || typeof token.scope !== 'string' || !token.scope.trim()) {
      throw new OpenAIAuthorizationError('Invalid OpenAI OAuth token response.');
    }
    const scopes = token.scope.trim().split(/\s+/u);
    if (!scopes.every(opaque)) throw new OpenAIAuthorizationError('Invalid OpenAI OAuth scopes.');
    // Identity-only grants need not include access or renewable-session tokens.
    const direct = hasDirectScope(scopes);
    const access = token.access_token === undefined ? '' : token.access_token;
    const refresh = token.refresh_token === undefined ? '' : token.refresh_token;
    const seconds = token.expires_in === undefined ? 0 : token.expires_in;
    if (typeof access !== 'string' || typeof refresh !== 'string'
      || (access ? !opaque(access) : direct) || (refresh ? !opaque(refresh) : direct)
      || ((access || token.token_type !== undefined) && (typeof token.token_type !== 'string' || token.token_type.toLowerCase() !== 'bearer'))
      || typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds < 0 || seconds > 86_400
      || (access && seconds === 0)) throw new OpenAIAuthorizationError('Invalid OpenAI OAuth token response.');
    const lifetime = seconds * 1000;
    return { type: 'oauth', access, refresh,
      expires: lifetime ? Date.now() + lifetime - Math.min(180_000, lifetime / 10) : 0, scopes, idToken: token.id_token } as const;
  }

  return {
    name: 'OpenAI (ChatGPT subscription)', loginLabel: 'Continue with ChatGPT', isSubscription: true,
    async login(interaction) {
      const signal = AbortSignal.any([interaction.signal, AbortSignal.timeout(300_000)]);
      const deviceId = await options.getDeviceId();
      if (!uuid.test(deviceId)) throw new OpenAIAuthorizationError('Invalid Athena OAuth device ID.');
      const extAgentHostId = `urn:uuid:${deviceId.toLowerCase()}`;
      const stored = await options.credentials.read('openai', { signal });
      const retained = registration(stored?.type === 'oauth' ? stored : undefined);
      const previous = options.previousRegistration ?? retained;
      if (stored?.type === 'oauth' && stored.extAgentHostId !== undefined && stored.extAgentHostId !== extAgentHostId) {
        throw new OpenAIAuthorizationError('This ChatGPT registration belongs to another host.');
      }
      const [state, nonce, verifier] = Array.from({ length: 3 }, () => randomBytes(32).toString('base64url'));
      if (!state || !nonce || !verifier) throw new OpenAIAuthorizationError('Could not prepare OpenAI sign-in.');
      const callback = await authorizeCallback({ state, clientId: previous?.clientId, signal, announce(redirectUri) {
        const url = new URL(OPENAI_AUTHORIZE_URL);
        // Omit optional ID-token/email hints: this link is returned to the client for polling.
        url.search = new URLSearchParams({ client_id: previous?.clientId ?? dynamicClient,
          ...(previous ? {} : { agent_name_hint: 'Athena' }), ext_agent_host_id: extAgentHostId,
          response_type: 'code', redirect_uri: redirectUri, resource, scope: requestedScope, state, nonce,
          ...(options.requestConsent || (retained && !hasDirectScope(stored?.type === 'oauth' ? stored.scopes : undefined))
            ? { prompt: 'consent' } : {}),
          code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') }).toString();
        if (options.nativeBrowser && retained && retained.clientId === previous?.clientId && retained.subject === previous.subject) {
          url.searchParams.set('id_token_hint', retained.idToken);
        }
        interaction.notify({ type: 'auth_url', url: url.href });
      } });
      const tokens = await exchange({ grant_type: 'authorization_code', client_id: callback.clientId, code: callback.code,
        code_verifier: verifier, redirect_uri: callback.redirectUri }, signal);
      if (!opaque(tokens.idToken)) throw new OpenAIAuthorizationError('OpenAI did not return an ID token.');
      const account = await identity(tokens.idToken, { clientId: callback.clientId, nonce }, signal);
      if (previous && previous.subject !== account.subject) throw new OpenAIAuthorizationError('OpenAI account did not match this registration.');
      signal.throwIfAborted();
      return { ...tokens, ...account, extAgentHostId };
    },
    async refresh(credential, signal) {
      const previous = registration(credential);
      if (!previous || !hasDirectScope(credential.scopes) || !opaque(credential.refresh)) {
        throw new OpenAIAuthorizationError('Reconnect ChatGPT to renew this OpenAI credential.');
      }
      const tokens = await exchange({ grant_type: 'refresh_token', client_id: previous.clientId, refresh_token: credential.refresh }, signal);
      const account = tokens.idToken === undefined ? previous : opaque(tokens.idToken)
        ? await identity(tokens.idToken, { clientId: previous.clientId }, signal) : undefined;
      if (account?.subject !== previous.subject) throw new OpenAIAuthorizationError('OpenAI account did not match this registration.');
      signal.throwIfAborted();
      return { ...tokens, ...account };
    },
    async toAuth(credential) {
      if (!registration(credential) || !hasDirectScope(credential.scopes) || !opaque(credential.access)) {
        throw new OpenAIAuthorizationError('Reconnect ChatGPT to use this OpenAI credential.');
      }
      return { apiKey: credential.access, baseUrl: resource };
    },
  };
}
