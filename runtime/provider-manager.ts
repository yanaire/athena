import { createProvider, getSupportedThinkingLevels, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import type { Api, CredentialStore, Model, Provider } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { CatalogModel, ModelCheck, ProviderCatalog, ProviderSummary } from '../athena-backend-handoff/athena-codex-ui/integrations/model-profiles.d.ts';
import type { ModelReference } from '../athena-backend-handoff/athena-codex-ui/integrations/task-manager.d.ts';
import { providerMethods } from './provider-policy.ts';
import { addCompatibleModels, compatibleEndpoint, fetchCompatibleModels } from './compatible-model.ts';
import { loadDeviceId, ProviderOAuthController, registerOpenAIOAuth } from './provider-oauth.ts';
import { streamRedactor } from './pi.ts';
import type { PiModelSelection } from './pi.ts';
import { accountModel, CHATGPT_RESOURCE, ChatGPTCatalogFailure, chatGPTAccountRef, fetchChatGPTCatalog } from './chatgpt-catalog.ts';
import { OpenAIRequestUnavailable } from './openai-authorization.ts';
import { chatGPTFailureReason } from './chatgpt-errors.ts';
import { chatGPTResponsesApi } from './chatgpt-responses.ts';
import { ChatGPTRegistrationError, ChatGPTRegistrations } from './chatgpt-registrations.ts';
import { CredentialBindings } from './credential-binding.ts';

export type CompatibleProvider = { readonly id: string; readonly name: string; readonly endpoint: string; readonly modelIds: readonly string[] };

export class ProviderError extends Error {
  readonly code: 'UNKNOWN_PROVIDER' | 'UNSUPPORTED_AUTH' | 'CREDENTIAL_FAILURE' | 'INVALID_KEY' | 'MODEL_UNAVAILABLE' | 'AUTH_REQUIRED';
  readonly reason?: ModelCheck['error'];
  constructor(code: ProviderError['code'], message: string, reason?: ModelCheck['error']) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.reason = reason;
  }
}

function describe(model: Model<Api>): CatalogModel {
  const { input, output, cacheRead, cacheWrite } = model.cost;
  return { provider: model.provider, id: model.id, name: model.name, api: model.api,
    input: [...model.input], contextWindow: model.contextWindow, maxTokens: model.maxTokens,
    reasoning: model.reasoning, thinkingLevels: getSupportedThinkingLevels(model), tools: 'unverified',
    cost: [input, output, cacheRead, cacheWrite].every(Number.isFinite) ? { input, output, cacheRead, cacheWrite } : null };
}

const orderedEntries = (value: Readonly<Record<string, unknown>> | undefined) =>
  Object.entries(value ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);

export class ProviderManager {
  readonly #runtime: ModelRuntime;
  readonly #credentials: CredentialStore;
  readonly #enabledOAuth: ReadonlySet<string>;
  readonly #chatGPTEnabled: boolean;
  readonly #directory: string | undefined;
  readonly #nativeBrowser: boolean;
  readonly #registrations?: ChatGPTRegistrations;
  readonly #bindings: CredentialBindings;
  readonly #compatible = new Map<string, CompatibleProvider>();
  readonly oauth: ProviderOAuthController | undefined;

  private constructor(runtime: ModelRuntime, credentials: CredentialStore, directory?: string,
    registrations?: ChatGPTRegistrations, openRouterEnabled = false, nativeBrowser = false) {
    this.#runtime = runtime;
    this.#credentials = credentials;
    this.#directory = directory;
    this.#nativeBrowser = nativeBrowser;
    this.#registrations = registrations;
    this.#bindings = new CredentialBindings(credentials, directory);
    this.#chatGPTEnabled = registrations !== undefined;
    this.#enabledOAuth = new Set([...(this.#chatGPTEnabled ? ['openai'] : []), ...(directory && openRouterEnabled ? ['openrouter'] : [])]);
    this.oauth = directory && this.#enabledOAuth.size ? new ProviderOAuthController({ runtime, credentials, deviceIdDirectory: directory,
      openAI: this.#chatGPTEnabled, openRouter: this.#enabledOAuth.has('openrouter'), nativeBrowser,
      ...(registrations ? { prepareOpenAI: (ref, signal) => this.#prepareChatGPTLogin(ref, signal) } : {}) }) : undefined;
  }

  static async create(credentials: CredentialStore, directory?: string, options: { readonly chatGPTEnabled?: boolean; readonly openRouterEnabled?: boolean; readonly nativeBrowser?: boolean } = {}) {
    // Never import a companion CLI's auth.json, models.json, or endpoint overrides.
    const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
    const registrations = options.chatGPTEnabled && directory
      ? new ChatGPTRegistrations({ credentials, currentHostId: await loadDeviceId(directory) }) : undefined;
    return new ProviderManager(runtime, credentials, directory, registrations, options.openRouterEnabled, options.nativeBrowser);
  }

  async #prepareChatGPTLogin(ref: string | undefined, signal: AbortSignal): Promise<ModelRuntime> {
    const registrations = this.#registrations;
    if (!registrations || !this.#directory) throw new ProviderError('UNSUPPORTED_AUTH', 'ChatGPT sign-in is unavailable.');
    const previous = ref ? await registrations.lookup(ref, { signal }) : undefined;
    if (ref && !previous) throw new ProviderError('AUTH_REQUIRED', 'The selected ChatGPT registration no longer exists.');
    const local = new InMemoryCredentialStore();
    const credentials: CredentialStore = {
      read: (id, options) => local.read(id, options),
      list: options => local.list(options),
      modify: (id, modify, options) => local.modify(id, async current => {
        const next = await modify(current);
        if (id !== 'openai' || next?.type !== 'oauth' || (ref && chatGPTAccountRef(next) !== ref)) {
          throw new ProviderError('AUTH_REQUIRED', 'ChatGPT did not return the selected registration.');
        }
        const displayName = typeof next.displayName === 'string' ? next.displayName : undefined;
        const email = typeof next.email === 'string' ? next.email : undefined;
        await registrations.registerVerified(next, { label: email ?? displayName, email, displayName }, options);
        return next;
      }, options),
      delete: async () => { throw new ProviderError('UNSUPPORTED_AUTH', 'Use account sign-out to remove this credential.'); },
    };
    const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
    registerOpenAIOAuth(runtime, { credentials: ref ? registrations.forAuthorization(ref) : credentials,
      deviceIdDirectory: this.#directory, previousRegistration: previous, nativeBrowser: this.#nativeBrowser,
      requestConsent: previous?.state === 'connected' && previous.planUsage === 'disabled' });
    return runtime;
  }

  async chatGPTAccounts() {
    return (await this.#registrations?.list({ signal: AbortSignal.timeout(3000) }) ?? [])
      .map(({ authRef, label, state, planUsage, lastAuthenticatedAt, lastRefreshedAt }) => ({ authRef, label, state, planUsage, lastAuthenticatedAt, lastRefreshedAt }));
  }

  async signOutChatGPT(authRef: string) {
    if (!this.#registrations) throw new ProviderError('UNSUPPORTED_AUTH', 'ChatGPT sign-in is unavailable.');
    const { remote, remoteFailure } = await this.#registrations.signOut(authRef);
    return { remote, ...(remoteFailure ? { remoteFailure } : {}) };
  }

  #accountStore(ref: string): CredentialStore {
    if (!this.#registrations) throw new ProviderError('AUTH_REQUIRED', 'ChatGPT sign-in is unavailable.');
    return this.#registrations.forRegistration(ref);
  }

  async #accountRuntime(credentials: CredentialStore): Promise<ModelRuntime> {
    if (!this.#directory) throw new ProviderError('UNSUPPORTED_AUTH', 'ChatGPT sign-in is unavailable.');
    const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
    registerOpenAIOAuth(runtime, { credentials, deviceIdDirectory: this.#directory });
    return runtime;
  }

  model(provider: string, model: string) { return this.#runtime.getModel(provider, model); }

  endpoint(provider: string): string | undefined { return this.#compatible.get(provider)?.endpoint; }

  #knownResponseModel(id: string): Model<'openai-responses'> | undefined {
    const model = this.model('openai', id);
    return model?.api === 'openai-responses' ? { ...model, api: 'openai-responses', compat: undefined } : undefined;
  }

  async #accountModels(authRef: string, access: string, signal: AbortSignal, store = this.#accountStore(authRef)) {
    const entries = await fetchChatGPTCatalog(access, signal).catch((error: unknown) => {
      if (!(error instanceof Error)) throw error;
      if (signal.aborted) throw new ProviderError('MODEL_UNAVAILABLE', 'ChatGPT account catalog request timed out.', 'timeout');
      if (error instanceof ChatGPTCatalogFailure) throw new ProviderError('MODEL_UNAVAILABLE', error.message, error.reason);
      throw new ProviderError('MODEL_UNAVAILABLE', 'OpenAI did not return the ChatGPT account catalog. Check the account and try again.');
    });
    const current = await store.read('openai', { signal }).catch((error: unknown) => {
      if (!(error instanceof Error)) throw error;
      throw new ProviderError('AUTH_REQUIRED', 'Reconnect the ChatGPT registration saved with this profile.');
    });
    if (current?.type !== 'oauth' || current.access !== access || chatGPTAccountRef(current) !== authRef) {
      throw new ProviderError('AUTH_REQUIRED', 'The ChatGPT credential changed while loading models. Load the catalog again.');
    }
    const models = entries.map(entry => {
      const known = this.#knownResponseModel(entry.slug);
      return { model: accountModel(entry, known), known: known !== undefined };
    });
    return { models, expires: current.expires };
  }

  async authorChatGPTProfile(modelId: string, accountRef: unknown) {
    const signal = AbortSignal.timeout(10_000);
    if (typeof accountRef !== 'string' || (await this.#accountInfo(accountRef, signal))?.planUsage !== 'enabled') {
      throw new ProviderError('AUTH_REQUIRED', 'Use the current ChatGPT account catalog to save this profile.');
    }
    const access = await this.#chatGPTAccess(await this.#accountRuntime(this.#accountStore(accountRef)), signal);
    const selected = (await this.#accountModels(accountRef, access, signal)).models.find(entry => entry.model.id === modelId);
    if (!selected) throw new ProviderError('MODEL_UNAVAILABLE', 'This model was not listed for the ChatGPT account.');
    return { model: selected.model, authRef: accountRef };
  }

  async #accountInfo(ref: string, signal: AbortSignal) {
    try { return await this.#registrations?.lookup(ref, { signal }); }
    catch (error) {
      if (!(error instanceof ChatGPTRegistrationError)) throw error;
      throw new ProviderError('AUTH_REQUIRED', 'Reconnect the ChatGPT registration saved with this profile.');
    }
  }

  async #chatGPTAccess(runtime: ModelRuntime, signal: AbortSignal): Promise<string> {
    const auth = await runtime.getAuth('openai', { signal }).catch((error: unknown) => {
      if (!(error instanceof Error)) throw error;
      if (signal.aborted) throw new ProviderError('AUTH_REQUIRED', 'ChatGPT authorization timed out. Try again.', 'timeout');
      if (error.cause instanceof OpenAIRequestUnavailable) {
        throw new ProviderError('AUTH_REQUIRED', 'ChatGPT token refresh failed. Try again later.', error.cause.reason);
      }
      throw new ProviderError('AUTH_REQUIRED', 'ChatGPT authorization could not be renewed. Sign in again.');
    });
    if (auth?.auth.baseUrl !== CHATGPT_RESOURCE || !auth.auth.apiKey) {
      throw new ProviderError('AUTH_REQUIRED', 'ChatGPT plan usage requires an authorized OAuth credential.');
    }
    return auth.auth.apiKey;
  }

  async mountCompatible(provider: CompatibleProvider): Promise<void> {
    const stored = await this.#credentials.read(provider.id);
    const key = stored?.type === 'api_key' ? stored.key : undefined;
    await addCompatibleModels(this.#runtime, provider.id, provider.name, compatibleEndpoint(provider.endpoint), provider.modelIds, key);
    this.#compatible.set(provider.id, provider);
  }

  async registerCompatible(input: Omit<CompatibleProvider, 'modelIds'>, key?: string): Promise<CompatibleProvider> {
    const endpoint = compatibleEndpoint(input.endpoint);
    if (key !== undefined) validKey(key);
    const modelIds = await fetchCompatibleModels(endpoint, key, AbortSignal.timeout(10_000));
    if (!modelIds.length) throw new ProviderError('MODEL_UNAVAILABLE', 'The endpoint returned no usable model IDs.');
    if (key !== undefined) await this.#credentials.modify(input.id, async () => ({ type: 'api_key', key }));
    const provider = { ...input, endpoint: endpoint.url, modelIds };
    await this.mountCompatible(provider);
    return provider;
  }

  async pin(reference: ModelReference): Promise<PiModelSelection> {
    const id = reference.provider;
    if (id === 'openai-codex') throw new ProviderError('UNSUPPORTED_AUTH', 'The independent Codex OAuth provider is not supported.');
    const signal = AbortSignal.timeout(12_000);
    const ref = reference.authMode === 'chatgpt' ? reference.authRef : undefined;
    if (reference.authMode === 'chatgpt') {
      const account = id === 'openai' && ref ? await this.#accountInfo(ref, signal) : undefined;
      if (account?.state !== 'connected') throw new ProviderError('AUTH_REQUIRED', 'Reconnect the ChatGPT registration saved with this profile.');
      if (account.planUsage !== 'enabled') throw new ProviderError('AUTH_REQUIRED', 'Enable ChatGPT plan usage for this registration.', 'permission');
    }
    const accountStore = ref ? this.#accountStore(ref) : undefined;
    const credential = await (accountStore ?? this.#credentials).read(id, { signal });
    if (id === 'openai' && credential?.type === 'oauth' && reference.authMode !== 'chatgpt') {
      throw new ProviderError('AUTH_REQUIRED', 'This profile uses the OpenAI API key route. Save a ChatGPT profile from the account catalog.');
    }
    let catalogModel = this.model(id, reference.modelId);
    const secrets = new Set<string>();
    const remember = (value: string | undefined) => { if (value) secrets.add(value); };
    const runtimeStore = new InMemoryCredentialStore();
    if (credential) await runtimeStore.modify(id, async () => credential);
    // OAuth rotations may update a pinned account, but no other credential can replace it mid-run.
    let credentials: CredentialStore = runtimeStore;
    if (credential?.type === 'oauth' && !this.#enabledOAuth.has(id)) {
      throw new ProviderError('UNSUPPORTED_AUTH', 'This provider’s stored OAuth credential is not allowed in Athena.');
    }
    if (accountStore) {
      const scoped = (current: Awaited<ReturnType<CredentialStore['read']>>) => {
        if (current?.type === 'oauth') {
          remember(current.access); remember(current.refresh);
          if (typeof current.idToken === 'string') remember(current.idToken);
        }
        return current;
      };
      credentials = {
        ...accountStore,
        read: async (provider, options) => scoped(await accountStore.read(provider, options)),
        modify: async (provider, modify, options) => accountStore.modify(provider, async current => scoped(await modify(scoped(current))), options),
      };
    }
    const runtime = accountStore ? await this.#accountRuntime(credentials)
      : await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
    const compatible = this.#compatible.get(id);
    if (compatible) {
      const key = credential?.type === 'api_key' ? credential.key : undefined;
      const endpoint = compatibleEndpoint(compatible.endpoint);
      if (!key && !endpoint.loopback) throw new ProviderError('AUTH_REQUIRED', 'Register a key for this remote endpoint.');
      await addCompatibleModels(runtime, id, compatible.name, endpoint, [reference.modelId], key);
    } else if (ref) {
      const access = await this.#chatGPTAccess(runtime, signal);
      const selected = (await this.#accountModels(ref, access, signal)).models.find(entry => entry.model.id === reference.modelId)?.model;
      const openai = runtime.getProvider(id);
      if (!selected || !openai) throw new ProviderError('MODEL_UNAVAILABLE', 'The selected model is not in this ChatGPT account’s list.');
      runtime.registerNativeProvider(createProvider({ id, name: openai.name, baseUrl: CHATGPT_RESOURCE,
        auth: { oauth: openai.auth.oauth }, models: [selected], api: chatGPTResponsesApi() }));
      catalogModel = selected;
    }
    const thinkingLevel = catalogModel && getSupportedThinkingLevels(catalogModel).find(level => level === (reference.thinkingLevel ?? 'off'));
    if (!catalogModel || !thinkingLevel) throw new ProviderError('MODEL_UNAVAILABLE', 'The selected model or reasoning level is no longer available.');
    const auth = await runtime.getAuth(catalogModel, { signal }).catch(() => {
      throw new ProviderError('AUTH_REQUIRED', 'The provider credential could not be resolved. Check authentication or sign in again.');
    });
    if (!auth) throw new ProviderError('AUTH_REQUIRED', 'Configure credentials for the selected provider.');
    remember(auth.auth.apiKey);
    remember(credential?.type === 'api_key' ? credential.key : undefined);
    if (credential?.type === 'oauth') { remember(credential.access); remember(credential.refresh); }
    for (const value of Object.values(auth.auth.headers ?? {})) if (typeof value === 'string') remember(value);
    if (!compatible && credential?.type !== 'oauth' && auth.auth.apiKey) await runtime.setRuntimeApiKey(id, auth.auth.apiKey, { signal });
    // ChatGPT binds its registration, so access/refresh token rotations retain
    // identity. API-key routes bind the exact captured credential, including env
    // credentials. OpenRouter's OAuth route also returns a persistent API key.
    const keyless = !credential && compatible;
    const resolvedKey = Boolean(auth.auth.apiKey) || Object.values(auth.auth.headers ?? {}).some(value => typeof value === 'string' && value.length > 0);
    const authRef = ref ?? (keyless ? `${id}:keyless` : resolvedKey ? await this.#bindings.bind(id, {
      type: credential?.type ?? 'host',
      ...(credential?.type === 'api_key' ? { key: credential.key ?? null, env: orderedEntries(credential.env) } : {}),
      resolved: { apiKey: auth.auth.apiKey ?? null, headers: orderedEntries(auth.auth.headers), env: orderedEntries(auth.env) },
    }) : `${id}:host`);
    // Older provider/type references cannot prove which credential was used and
    // must not silently adopt the currently configured key on manual recovery.
    if (reference.authRef && !ref &&
        (reference.authRef !== authRef || authRef === `${id}:host`)) {
      throw new ProviderError('MODEL_UNAVAILABLE', 'The original credential binding is unavailable or has changed. Start a new request with the current profile.');
    }
    return { modelRuntime: runtime, model: structuredClone(catalogModel), thinkingLevel,
      endpoint: auth.auth.baseUrl ?? catalogModel.baseUrl, authRef, ...streamRedactor(secrets) };
  }

  async verify(reference: ModelReference): Promise<ModelCheck> {
    const checkedAt = new Date().toISOString();
    let streaming: ModelCheck['streaming'] = 'not_checked';
    let tools: ModelCheck['tools'] = 'not_checked';
    let status: number | undefined;
    const signal = AbortSignal.timeout(25_000);
    try {
      // Verification of an editable API profile checks its current configuration.
      // Unlike saved run bindings, its authRef is only the bare provider ID.
      const current = reference.authMode !== 'chatgpt' && reference.authRef === reference.provider
        ? { ...reference, authRef: undefined } : reference;
      const { modelRuntime, model, thinkingLevel } = await this.pin(current);
      const options = { signal, maxRetries: 0, maxTokens: Math.min(256, model.maxTokens),
        ...(thinkingLevel !== 'off' ? { reasoning: thinkingLevel } : {}),
        onResponse: (response: { status: number }) => { status = response.status; } };
      const prompt = (content: string) => ({ role: 'user' as const, content, timestamp: Date.now() });
      const first = modelRuntime.streamSimple(model, { messages: [prompt('Reply with the single word Athena.')] }, options);
      let delta = false;
      for await (const event of first) if (event.type === 'text_delta' && event.delta) delta = true;
      const message = await first.result();
      if (message.stopReason === 'error' || message.stopReason === 'aborted' || !delta) {
        streaming = 'failed';
        return { checkedAt, streaming, tools, error: checkError(message.errorMessage, status, signal, reference.authMode) };
      }
      streaming = 'passed'; status = undefined;
      const second = modelRuntime.streamSimple(model, { messages: [prompt('Call the athena_connection_check tool with no arguments. Do not answer in text.')],
        tools: [{ name: 'athena_connection_check', description: 'Confirm tool calling; takes no arguments.', parameters: { type: 'object', properties: {}, additionalProperties: false } }] }, options);
      const reply = await second.result();
      tools = reply.stopReason === 'toolUse' && reply.content.some(part => part.type === 'toolCall' &&
        part.name === 'athena_connection_check' && part.arguments && Object.keys(part.arguments).length === 0) ? 'passed' : 'failed';
      if (tools === 'passed') return { checkedAt, streaming, tools };
      const error = reply.stopReason === 'error' || reply.stopReason === 'aborted'
        ? checkError(reply.errorMessage, status, signal, reference.authMode) : 'unsupported';
      return { checkedAt, streaming, tools, error };
    } catch (error) {
      return { checkedAt, streaming, tools, error: error instanceof ProviderError && error.reason ? error.reason
        : error instanceof ProviderError && error.code === 'AUTH_REQUIRED' ? 'authentication'
        : error instanceof ProviderError && error.code === 'MODEL_UNAVAILABLE' ? 'model_unavailable' : checkError(undefined, status, signal) };
    }
  }

  #provider(id: string): Provider {
    const provider = this.#runtime.getProvider(id);
    if (!provider) throw new ProviderError('UNKNOWN_PROVIDER', 'The installed Pi SDK does not register this provider.');
    return provider;
  }

  #summary(provider: Provider, auth: ProviderSummary['auth'], details: Omit<ProviderSummary, 'id' | 'name' | 'auth' | 'methods'> = {}): ProviderSummary {
    const endpoint = this.#compatible.get(provider.id);
    const methods: ProviderSummary['methods'] = endpoint ? [
      compatibleEndpoint(endpoint.endpoint).loopback
        ? { kind: 'local_endpoint', label: 'Local endpoint', enabled: true, reason: 'Run its model server on this Mac. An API key is optional.' }
        : { kind: 'compatible_endpoint', label: 'Custom compatible endpoint', enabled: true, reason: 'An API key is required for remote endpoints.' },
      { kind: 'api_key', label: 'Endpoint API key', enabled: true },
    ] : providerMethods(provider, this.#enabledOAuth);
    return { id: provider.id, name: provider.name, methods, auth, ...details };
  }

  providers(query = ''): readonly ProviderSummary[] {
    const needle = query.trim().toLowerCase();
    return this.#runtime.getProviders().filter(p => `${p.id} ${p.name}`.toLowerCase().includes(needle))
      .map(p => this.#summary(p, 'not_checked'));
  }

  async listProviders(query = ''): Promise<readonly ProviderSummary[]> {
    // Reading metadata has no network or CLI side effects. Use checkAuth for
    // the one provider explicitly selected for a status/availability check.
    const signal = AbortSignal.timeout(3000);
    const stored = new Map((await this.#credentials.list({ signal })).map(item => [item.providerId, item.type]));
    return this.providers(query).map(row => {
      const credentialType = stored.get(row.id);
      if (credentialType === 'api_key' && row.methods.some(method => method.kind === 'api_key' && method.enabled)) {
        return { ...row, auth: 'configured', credentialType, credentialSource: 'stored' };
      }
      if (credentialType === 'oauth' && this.#enabledOAuth.has(row.id)) return { ...row, credentialType, credentialSource: 'stored' };
      if (row.methods.every(method => method.kind !== 'host' && method.kind !== 'local_endpoint')
        && !row.methods.some(method => method.kind === 'oauth' && method.enabled)) return { ...row, auth: 'unconfigured' };
      return row;
    });
  }

  async catalog(id: string, { query = '', refresh = false, accountRef }: { readonly query?: string; readonly refresh?: boolean; readonly accountRef?: string | null } = {},
    persistCompatible?: (provider: CompatibleProvider) => void): Promise<ProviderCatalog> {
    const provider = this.#provider(id);
    const signal = AbortSignal.timeout(10_000);
    const explicitAccount = id === 'openai' && typeof accountRef === 'string';
    let source: ProviderCatalog['source'] = explicitAccount ? 'chatgpt_account' : 'sdk_catalog';
    let error: ProviderCatalog['error'];
    let summary = this.#summary(provider, 'not_checked');
    let availableModelIds: readonly string[] = [];
    try {
      const credential = explicitAccount ? undefined : await this.#credentials.read(id, { signal });
      const oauthAllowed = providerMethods(provider, this.#enabledOAuth).some(method => method.kind === 'oauth' && method.enabled);
      const selectedAccount = id === 'openai' ? accountRef === undefined && credential?.type === 'oauth'
        ? chatGPTAccountRef(credential) : accountRef : undefined;
      if (explicitAccount || (id === 'openai' && accountRef === undefined && credential?.type === 'oauth')) {
        source = 'chatgpt_account';
        const info = oauthAllowed && selectedAccount ? await this.#accountInfo(selectedAccount, signal) : undefined;
        const store = info?.planUsage === 'enabled' && selectedAccount ? this.#accountStore(selectedAccount) : undefined;
        const saved = await store?.read(id, { signal });
        let expires = saved?.type === 'oauth' ? saved.expires : undefined;
        const result = (auth: ProviderSummary['auth'], models: readonly CatalogModel[], error?: ProviderCatalog['error'], errorReason?: ModelCheck['error']): ProviderCatalog => ({
          provider: this.#summary(provider, auth, info ? { credentialType: 'oauth', credentialSource: 'stored',
            ...(expires === undefined ? {} : { oauthExpiresAt: expires }) } : {}),
          models, availableModelIds: models.map(model => model.id),
          source: 'chatgpt_account', checkedAt: new Date().toISOString(), ...(info ? { accountRef: info.authRef } : {}), ...(error ? { error } : {}), ...(errorReason ? { errorReason } : {}),
        });
        if (!info || info.state === 'signed_out') return result('unconfigured', []);
        if (!store || saved?.type !== 'oauth' || (!refresh && saved.expires <= Date.now())) return result('refresh_required', []);
        let access: string;
        try { access = await this.#chatGPTAccess(await this.#accountRuntime(store), signal); }
        catch (cause) {
          if (!(cause instanceof ProviderError)) throw cause;
          return result('refresh_required', [], 'refresh_failed', cause.reason ?? 'authentication');
        }
        try {
          const needle = query.trim().toLowerCase();
          const current = await this.#accountModels(info.authRef, access, signal, store);
          expires = current.expires;
          const models = current.models
            .filter(({ model }) => `${model.id} ${model.name}`.toLowerCase().includes(needle))
            .map(({ model, known }) => ({ ...describe(model), cost: null, ...(!known ? { contextWindow: null, maxTokens: null } : {}) }));
          return result('configured', models);
        } catch (cause) {
          if (!(cause instanceof ProviderError)) throw cause;
          return result('error', [], 'account_catalog_failed', cause.reason);
        }
      }
      if (credential?.type === 'oauth' && (!oauthAllowed || id === 'openai')) {
        summary = this.#summary(provider, 'unconfigured');
      } else if (!refresh && credential?.type === 'oauth' && credential.expires <= Date.now()) {
        summary = this.#summary(provider, 'refresh_required', { credentialType: 'oauth', credentialSource: 'stored', oauthExpiresAt: credential.expires });
      } else {
        // An explicit refresh can rotate an expired token; ordinary reads never refresh it.
        if (refresh && credential?.type === 'oauth' && credential.expires <= Date.now()) {
          const refreshed = await this.#runtime.getAuth(id, { signal }).catch((cause: unknown) => {
            if (!(cause instanceof Error)) throw cause;
            return undefined;
          });
          if (!refreshed) {
            summary = this.#summary(provider, 'refresh_required', { credentialType: 'oauth', credentialSource: 'stored', oauthExpiresAt: credential.expires });
            error = 'refresh_failed';
          }
        }
        if (error === undefined) {
          const checked = await this.#runtime.checkAuth(id, { signal });
          const compatible = this.#compatible.get(id);
          const credentialSource = credential ? 'stored' : compatible && compatibleEndpoint(compatible.endpoint).loopback ? 'keyless' : 'host';
          summary = this.#summary(provider, checked ? 'configured' : 'unconfigured', checked ? {
            credentialType: checked.type, credentialSource,
            ...(credential?.type === 'oauth' ? { oauthExpiresAt: credential.expires } : {}),
          } : {});
          if (compatible) source = 'endpoint_catalog';
          if (checked && refresh) {
            const endpoint = this.#compatible.get(id);
            if (endpoint) {
              try {
                const modelIds = await fetchCompatibleModels(compatibleEndpoint(endpoint.endpoint), credential?.type === 'api_key' ? credential.key : undefined, signal);
                if (modelIds.length === 0) throw new ProviderError('MODEL_UNAVAILABLE', 'The endpoint returned no usable model IDs.');
                const updated = { ...endpoint, modelIds };
                persistCompatible?.(updated);
                await this.mountCompatible(updated);
              } catch { error = 'refresh_failed'; }
            } else if (provider.refreshModels) {
              const result = await this.#runtime.refresh({ providers: [id], force: true, allowNetwork: true, signal });
              if (result.aborted || result.errors.has(id)) error = 'refresh_failed';
              else source = 'refreshed_catalog';
            }
          }
          if (checked) availableModelIds = (await this.#runtime.getAvailable(id, { signal })).map(model => model.id);
        }
      }
    } catch (cause) {
      if (!(cause instanceof Error)) throw cause;
      summary = this.#summary(provider, 'error');
      error = source === 'chatgpt_account' ? 'account_catalog_failed' : 'availability_failed';
    }
    const needle = query.trim().toLowerCase();
    const models = (source === 'chatgpt_account' ? [] : this.#runtime.getModels(id))
      .filter(m => `${m.id} ${m.name} ${m.provider}`.toLowerCase().includes(needle)).map(describe);
    const visible = new Set(models.map(model => model.id));
    return { provider: summary, models, availableModelIds: availableModelIds.filter(id => visible.has(id)),
      source, checkedAt: new Date().toISOString(), ...(error ? { error } : {}) };
  }

  async saveApiKey(id: string, apiKey: string): Promise<void> {
    const provider = this.#provider(id);
    validKey(apiKey);
    const endpoint = this.#compatible.get(id);
    if (endpoint) {
      try {
        await this.#credentials.modify(id, async () => ({ type: 'api_key', key: apiKey }));
        await this.mountCompatible(endpoint);
      } catch { throw new ProviderError('CREDENTIAL_FAILURE', 'The Athena credential store could not confirm that the key was saved.'); }
      return;
    }
    if (!providerMethods(provider, this.#enabledOAuth).some(method => method.kind === 'api_key' && method.enabled)) {
      throw new ProviderError('UNSUPPORTED_AUTH', 'Use the authentication method listed for this provider.');
    }
    try {
      await this.#runtime.login(id, 'api_key', { signal: AbortSignal.timeout(10_000), notify: () => {},
        prompt: async prompt => {
          if (prompt.type !== 'secret') throw new ProviderError('UNSUPPORTED_AUTH', 'This provider requires additional host settings.');
          return apiKey;
        } });
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('CREDENTIAL_FAILURE', 'The Athena credential store could not confirm that the key was saved.');
    }
  }

  async logout(id: string): Promise<void> {
    this.#provider(id);
    try {
      await this.#runtime.logout(id, { signal: AbortSignal.timeout(10_000) });
      if (await this.#credentials.read(id)) throw new Error('The credential was not removed.');
      const endpoint = this.#compatible.get(id);
      if (endpoint) await this.mountCompatible(endpoint);
    } catch {
      throw new ProviderError('CREDENTIAL_FAILURE', 'The Athena credential store could not confirm sign-out.');
    }
  }

  async close(): Promise<void> { await this.oauth?.close(); await this.#runtime.settleCredentialWrites(); }
}

function validKey(apiKey: string): void {
  if (!apiKey || apiKey.length > 8192 || /\s|[\x00-\x1f\x7f]/u.test(apiKey)) {
    throw new ProviderError('INVALID_KEY', 'Enter a nonempty API key without whitespace. Use Remove to delete it.');
  }
}

function checkError(message: string | undefined, status: number | undefined, signal: AbortSignal, authMode?: ModelReference['authMode']): NonNullable<ModelCheck['error']> {
  if (signal.aborted) return 'timeout';
  if (authMode === 'chatgpt') {
    // The adapter sanitizes both HTTP errors and in-stream failure events.
    const http = message?.match(/ChatGPT HTTP request failed \(status=(\d{3});/u);
    return chatGPTFailureReason(http ? Number(http[1]) : status,
      message?.match(/\bcode=(\w+)/u)?.[1], message?.match(/\btype=(\w+)/u)?.[1]);
  }
  if (status === 401 || /\b401\b|invalid.api.key|unauthenticated/i.test(message ?? '')) return 'authentication';
  if (status === 403 || /\b403\b|permission.denied/i.test(message ?? '')) return 'permission';
  if (status === 429 || /\b429\b|rate.limit/i.test(message ?? '')) return 'rate_limited';
  if (status === 404 || /\b404\b|model.not.found/i.test(message ?? '')) return 'model_unavailable';
  return 'connection';
}
