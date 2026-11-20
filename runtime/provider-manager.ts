import { createProvider, getSupportedThinkingLevels, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import type { Api, CredentialStore, Model, Provider } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { CatalogModel, ModelCheck, ProviderCatalog, ProviderSummary } from '../athena-backend-handoff/athena-codex-ui/integrations/model-profiles.d.ts';
import type { ModelReference } from '../athena-backend-handoff/athena-codex-ui/integrations/task-manager.d.ts';
import { providerMethods } from './provider-policy.ts';
import { addCompatibleModels, compatibleEndpoint, fetchCompatibleModels } from './compatible-model.ts';
import { ProviderOAuthController, registerOpenAIOAuth } from './provider-oauth.ts';
import { streamRedactor } from './pi.ts';
import type { PiModelSelection } from './pi.ts';
import { accountModel, CHATGPT_RESOURCE, chatGPTAccountRef, fetchChatGPTCatalog } from './chatgpt-catalog.ts';
import { chatGPTResponsesApi } from './chatgpt-responses.ts';

export type CompatibleProvider = { readonly id: string; readonly name: string; readonly endpoint: string; readonly modelIds: readonly string[] };

export class ProviderError extends Error {
  readonly code: 'UNKNOWN_PROVIDER' | 'UNSUPPORTED_AUTH' | 'CREDENTIAL_FAILURE' | 'INVALID_KEY' | 'MODEL_UNAVAILABLE' | 'AUTH_REQUIRED';
  constructor(code: ProviderError['code'], message: string) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
  }
}

function describe(model: Model<Api>): CatalogModel {
  const { input, output, cacheRead, cacheWrite } = model.cost;
  return { provider: model.provider, id: model.id, name: model.name, api: model.api,
    input: [...model.input], contextWindow: model.contextWindow, maxTokens: model.maxTokens,
    reasoning: model.reasoning, thinkingLevels: getSupportedThinkingLevels(model), tools: 'unverified',
    cost: [input, output, cacheRead, cacheWrite].every(Number.isFinite) ? { input, output, cacheRead, cacheWrite } : null };
}

export class ProviderManager {
  readonly #runtime: ModelRuntime;
  readonly #credentials: CredentialStore;
  readonly #enabledOAuth: ReadonlySet<string>;
  readonly #directory: string | undefined;
  readonly #compatible = new Map<string, CompatibleProvider>();
  readonly oauth: ProviderOAuthController | undefined;

  private constructor(runtime: ModelRuntime, credentials: CredentialStore, directory?: string, chatGPTEnabled = false) {
    this.#runtime = runtime;
    this.#credentials = credentials;
    this.#directory = directory;
    this.#enabledOAuth = new Set(directory && chatGPTEnabled ? ['openai'] : []);
    this.oauth = directory && chatGPTEnabled ? new ProviderOAuthController({ runtime, credentials, deviceIdDirectory: directory }) : undefined;
  }

  static async create(credentials: CredentialStore, directory?: string, options: { readonly chatGPTEnabled?: boolean } = {}) {
    // Never import a companion CLI's auth.json, models.json, or endpoint overrides.
    const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
    return new ProviderManager(runtime, credentials, directory, options.chatGPTEnabled);
  }

  model(provider: string, model: string) { return this.#runtime.getPhysicalModel(provider, model); }

  endpoint(provider: string): string | undefined { return this.#compatible.get(provider)?.endpoint; }

  #knownResponseModel(id: string): Model<'openai-responses'> | undefined {
    const model = this.model('openai', id);
    return model?.api === 'openai-responses' ? { ...model, api: 'openai-responses', compat: undefined } : undefined;
  }

  async #accountModels(authRef: string, access: string, signal: AbortSignal) {
    const entries = await fetchChatGPTCatalog(access, signal).catch((error: unknown) => {
      if (!(error instanceof Error)) throw error;
      throw new ProviderError('MODEL_UNAVAILABLE', 'OpenAI did not return the ChatGPT account catalog. Check the account and try again.');
    });
    const current = await this.#credentials.read('openai', { signal });
    if (current?.type !== 'oauth' || current.access !== access || chatGPTAccountRef(current) !== authRef) {
      throw new ProviderError('AUTH_REQUIRED', 'The ChatGPT credential changed while loading models. Load the catalog again.');
    }
    return entries.map(entry => {
      const known = this.#knownResponseModel(entry.slug);
      return { model: accountModel(entry, known), known: known !== undefined };
    });
  }

  async authorChatGPTProfile(modelId: string, accountRef: unknown) {
    const signal = AbortSignal.timeout(10_000);
    const credential = await this.#credentials.read('openai', { signal });
    if (!this.oauth || credential?.type !== 'oauth' || typeof accountRef !== 'string' || chatGPTAccountRef(credential) !== accountRef) {
      throw new ProviderError('AUTH_REQUIRED', 'Use the current ChatGPT account catalog to save this profile.');
    }
    const access = await this.#chatGPTAccess(this.#runtime, signal);
    const selected = (await this.#accountModels(accountRef, access, signal)).find(entry => entry.model.id === modelId);
    if (!selected) throw new ProviderError('MODEL_UNAVAILABLE', 'This model was not listed for the ChatGPT account.');
    return { model: selected.model, authRef: accountRef };
  }

  async #chatGPTAccess(runtime: ModelRuntime, signal: AbortSignal): Promise<string> {
    const auth = await runtime.getAuth('openai', { signal }).catch((error: unknown) => {
      if (!(error instanceof Error)) throw error;
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
    const credential = await this.#credentials.read(id);
    if (reference.authMode === 'chatgpt' && (id !== 'openai' || !this.oauth || credential?.type !== 'oauth')) {
      throw new ProviderError('AUTH_REQUIRED', 'Reconnect the ChatGPT registration saved with this profile.');
    }
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
    if (credential?.type === 'oauth') {
      const vault = this.#credentials;
      const account = chatGPTAccountRef(credential);
      if (id !== 'openai' || !this.oauth || !account || reference.authRef !== account) throw new ProviderError('AUTH_REQUIRED', 'Reconnect the ChatGPT registration saved with this profile.');
      const scoped = (current: Awaited<ReturnType<CredentialStore['read']>>) => {
        if (current?.type !== 'oauth' || chatGPTAccountRef(current) !== account) throw new ProviderError('AUTH_REQUIRED', 'The run’s OAuth account was disconnected.');
        remember(current.access); remember(current.refresh);
        if (typeof current.idToken === 'string') remember(current.idToken);
        return current;
      };
      credentials = {
        read: async (provider, options) => provider === id ? scoped(await vault.read(id, options)) : undefined,
        list: async options => (await vault.list(options)).filter(item => item.providerId === id && item.type === 'oauth'),
        modify: async (provider, modify, options) => {
          if (provider !== id) throw new ProviderError('UNSUPPORTED_AUTH', 'This runtime owns a different provider.');
          return vault.modify(id, async current => {
            const next = await modify(scoped(current));
            return next === undefined ? undefined : scoped(next);
          }, options);
        },
        delete: async () => { throw new ProviderError('UNSUPPORTED_AUTH', 'Cannot remove credentials from a research runtime.'); },
      };
    }
    const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
    const signal = AbortSignal.timeout(12_000);
    const compatible = this.#compatible.get(id);
    if (compatible) {
      const key = credential?.type === 'api_key' ? credential.key : undefined;
      const endpoint = compatibleEndpoint(compatible.endpoint);
      if (!key && !endpoint.loopback) throw new ProviderError('AUTH_REQUIRED', 'Register a key for this remote endpoint.');
      await addCompatibleModels(runtime, id, compatible.name, endpoint, [reference.modelId], key);
    } else if (credential?.type === 'oauth') {
      if (id !== 'openai' || !this.#directory) throw new ProviderError('UNSUPPORTED_AUTH', 'This provider’s stored OAuth credential is not allowed in Athena.');
      registerOpenAIOAuth(runtime, { credentials, deviceIdDirectory: this.#directory });
      const ref = chatGPTAccountRef(credential);
      if (!ref || ref !== reference.authRef) throw new ProviderError('AUTH_REQUIRED', 'The selected ChatGPT registration has changed.');
      const access = await this.#chatGPTAccess(runtime, signal);
      const selected = (await this.#accountModels(ref, access, signal)).find(entry => entry.model.id === reference.modelId)?.model;
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
    for (const value of Object.values(auth.auth.headers ?? {})) if (typeof value === 'string') remember(value);
    if (!compatible && credential?.type !== 'oauth' && auth.auth.apiKey) await runtime.setRuntimeApiKey(id, auth.auth.apiKey, { signal });
    return { modelRuntime: runtime, model: structuredClone(catalogModel), thinkingLevel, ...streamRedactor(secrets) };
  }

  async verify(reference: ModelReference): Promise<ModelCheck> {
    const checkedAt = new Date().toISOString();
    let streaming: ModelCheck['streaming'] = 'not_checked';
    let tools: ModelCheck['tools'] = 'not_checked';
    let status: number | undefined;
    const signal = AbortSignal.timeout(25_000);
    try {
      const { modelRuntime, model, thinkingLevel } = await this.pin(reference);
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
        return { checkedAt, streaming, tools, error: checkError(message.errorMessage, status, signal) };
      }
      streaming = 'passed'; status = undefined;
      const second = modelRuntime.streamSimple(model, { messages: [prompt('Call the athena_connection_check tool with no arguments. Do not answer in text.')],
        tools: [{ name: 'athena_connection_check', description: 'Confirm tool calling; takes no arguments.', parameters: { type: 'object', properties: {}, additionalProperties: false } }] }, options);
      const reply = await second.result();
      tools = reply.stopReason === 'toolUse' && reply.content.some(part => part.type === 'toolCall' &&
        part.name === 'athena_connection_check' && part.arguments && Object.keys(part.arguments).length === 0) ? 'passed' : 'failed';
      return { checkedAt, streaming, tools, ...(tools === 'failed' ? { error: reply.stopReason === 'error' ? checkError(reply.errorMessage, status, signal) : 'unsupported' } : {}) };
    } catch (error) {
      return { checkedAt, streaming, tools, error: error instanceof ProviderError && error.code === 'AUTH_REQUIRED' ? 'authentication'
        : error instanceof ProviderError && error.code === 'MODEL_UNAVAILABLE' ? 'model_unavailable' : checkError(undefined, status, signal) };
    }
  }

  #provider(id: string): Provider {
    const provider = this.#runtime.getProvider(id);
    if (!provider) throw new ProviderError('UNKNOWN_PROVIDER', 'The installed Pi SDK does not register this provider.');
    return provider;
  }

  #summary(provider: Provider, auth: ProviderSummary['auth'], credentialType?: ProviderSummary['credentialType']): ProviderSummary {
    const endpoint = this.#compatible.get(provider.id);
    return { id: provider.id, name: provider.name, methods: endpoint ? [{ kind: 'api_key', label: 'Endpoint API key', enabled: true }]
      : providerMethods(provider, this.#enabledOAuth), auth,
      ...(credentialType ? { credentialType } : {}) };
  }

  providers(query = ''): readonly ProviderSummary[] {
    const needle = query.trim().toLowerCase();
    return this.#runtime.getProviders().filter(p => `${p.id} ${p.name}`.toLowerCase().includes(needle))
      .map(p => this.#summary(p, 'not_checked'));
  }

  async catalog(id: string, { query = '', refresh = false }: { readonly query?: string; readonly refresh?: boolean } = {},
    persistCompatible?: (provider: CompatibleProvider) => void): Promise<ProviderCatalog> {
    const provider = this.#provider(id);
    const signal = AbortSignal.timeout(10_000);
    let source: ProviderCatalog['source'] = 'sdk_catalog';
    let error: ProviderCatalog['error'];
    let summary = this.#summary(provider, 'not_checked');
    let availableModelIds: readonly string[] = [];
    try {
      const credential = await this.#credentials.read(id, { signal });
      const oauthAllowed = providerMethods(provider, this.#enabledOAuth).some(method => method.kind === 'oauth' && method.enabled);
      if (id === 'openai' && credential?.type === 'oauth') {
        const accountRef = chatGPTAccountRef(credential);
        const result = (auth: ProviderSummary['auth'], models: readonly CatalogModel[], error?: ProviderCatalog['error']): ProviderCatalog => ({
          provider: this.#summary(provider, auth, 'oauth'), models, availableModelIds: models.map(model => model.id),
          source: 'chatgpt_account', checkedAt: new Date().toISOString(), ...(accountRef ? { accountRef } : {}), ...(error ? { error } : {}),
        });
        if (!oauthAllowed || !accountRef) return result('unconfigured', []);
        if (!refresh && credential.expires <= Date.now()) return result('refresh_required', []);
        let access: string;
        try { access = await this.#chatGPTAccess(this.#runtime, signal); }
        catch (cause) {
          if (!(cause instanceof ProviderError)) throw cause;
          return result('refresh_required', [], 'refresh_failed');
        }
        try {
          const needle = query.trim().toLowerCase();
          const models = (await this.#accountModels(accountRef, access, signal))
            .filter(({ model }) => `${model.id} ${model.name}`.toLowerCase().includes(needle))
            .map(({ model, known }) => ({ ...describe(model), cost: null, ...(!known ? { contextWindow: null, maxTokens: null } : {}) }));
          return result('configured', models);
        } catch (cause) {
          if (!(cause instanceof ProviderError)) throw cause;
          return result('error', [], 'account_catalog_failed');
        }
      }
      if (credential?.type === 'oauth' && !oauthAllowed) {
        summary = this.#summary(provider, 'unconfigured');
      } else if (!refresh && credential?.type === 'oauth' && credential.expires <= Date.now()) {
        summary = this.#summary(provider, 'refresh_required', 'oauth');
      } else {
        // An explicit refresh can rotate an expired token; ordinary reads never refresh it.
        if (refresh && credential?.type === 'oauth' && credential.expires <= Date.now()) {
          const refreshed = await this.#runtime.getAuth(id, { signal }).catch((cause: unknown) => {
            if (!(cause instanceof Error)) throw cause;
            return undefined;
          });
          if (!refreshed) {
            summary = this.#summary(provider, 'refresh_required', 'oauth');
            error = 'refresh_failed';
          }
        }
        if (error === undefined) {
          const checked = await this.#runtime.checkAuth(id, { signal });
          summary = this.#summary(provider, checked ? 'configured' : 'unconfigured', checked?.type);
          if (checked && refresh) {
            const endpoint = this.#compatible.get(id);
            if (endpoint) {
              try {
                const modelIds = await fetchCompatibleModels(compatibleEndpoint(endpoint.endpoint), credential?.type === 'api_key' ? credential.key : undefined, signal);
                if (modelIds.length === 0) throw new ProviderError('MODEL_UNAVAILABLE', 'The endpoint returned no usable model IDs.');
                const updated = { ...endpoint, modelIds };
                persistCompatible?.(updated);
                await this.mountCompatible(updated);
                source = 'refreshed_catalog';
              } catch { error = 'refresh_failed'; }
            } else {
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
      error = 'availability_failed';
    }
    const needle = query.trim().toLowerCase();
    const models = this.#runtime.getModels(id)
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

function checkError(message: string | undefined, status: number | undefined, signal: AbortSignal): NonNullable<ModelCheck['error']> {
  if (signal.aborted) return 'timeout';
  if (status === 401 || /\b401\b|invalid.api.key|unauthenticated/i.test(message ?? '')) return 'authentication';
  if (status === 403 || /\b403\b|permission.denied/i.test(message ?? '')) return 'permission';
  if (status === 429 || /\b429\b|rate.limit/i.test(message ?? '')) return 'rate_limited';
  if (status === 404 || /\b404\b|model.not.found/i.test(message ?? '')) return 'model_unavailable';
  return 'connection';
}
