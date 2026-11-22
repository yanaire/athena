import type { ModelReference } from './connections.d.ts';

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ProviderAuthMethod = {
  readonly kind: 'api_key' | 'oauth' | 'host' | 'local_endpoint' | 'compatible_endpoint';
  readonly label: string;
  readonly enabled: boolean;
  readonly reason?: string;
  readonly flows?: readonly ('browser' | 'device')[];
};
export type ProviderSummary = {
  readonly id: string;
  readonly name: string;
  readonly methods: readonly ProviderAuthMethod[];
  readonly auth: 'not_checked' | 'unconfigured' | 'configured' | 'refresh_required' | 'error';
  readonly credentialType?: 'api_key' | 'oauth';
  readonly credentialSource?: 'stored' | 'host' | 'keyless';
  readonly oauthExpiresAt?: number;
};
export type CatalogModel = {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
  readonly api: string;
  readonly input: readonly string[];
  readonly contextWindow: number | null;
  readonly maxTokens: number | null;
  readonly reasoning: boolean;
  readonly thinkingLevels: readonly ThinkingLevel[];
  readonly tools: 'unverified';
  readonly cost: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number } | null;
};
export type ProviderCatalog = {
  readonly provider: ProviderSummary;
  readonly models: readonly CatalogModel[];
  /** SDK eligibility or account-list presence, not a successful inference check. */
  readonly availableModelIds: readonly string[];
  readonly source: 'sdk_catalog' | 'refreshed_catalog' | 'endpoint_catalog' | 'chatgpt_account';
  readonly accountRef?: string;
  readonly checkedAt: string;
  readonly error?: 'refresh_failed' | 'availability_failed' | 'account_catalog_failed';
};
export type ModelProfile = ModelReference & {
  readonly id: string;
  readonly name: string;
  readonly revision: number;
  readonly thinkingLevel: ThinkingLevel;
  readonly endpoint?: string;
  readonly authRef: string;
  readonly authMode?: 'chatgpt';
  readonly lastCheck?: ModelCheck;
};
export type ModelCheck = {
  readonly checkedAt: string;
  readonly streaming: 'passed' | 'failed' | 'not_checked';
  readonly tools: 'passed' | 'failed' | 'not_checked';
  readonly error?: 'authentication' | 'permission' | 'rate_limited' | 'model_unavailable' | 'connection' | 'unsupported' | 'timeout';
};
export type ResolvedModelReference = ModelReference & {
  readonly profileId?: string;
  readonly configurationRevision?: number;
  readonly source?: 'conversation' | 'project' | 'app' | 'host';
  readonly endpoint?: string;
  readonly api?: string;
  readonly authMode?: 'chatgpt';
  readonly authRef?: string;
};
export type ModelProfileInput = Pick<ModelProfile, 'name' | 'provider' | 'modelId'> & Partial<Pick<ModelProfile, 'id' | 'revision' | 'thinkingLevel' | 'authMode'>> & { readonly accountRef?: string };
export type ModelProfileList = {
  readonly profiles: readonly ModelProfile[];
  readonly appDefaultProfileId: string | null;
  readonly credentialMode: 'local_file' | 'keychain' | 'operator_key' | 'memory';
  readonly credentialMigration?: 'absent' | 'imported' | 'approval_required' | 'unavailable';
  readonly hostModel: ModelReference | null;
};
export type ProviderOAuthFlow = {
  readonly id: string;
  readonly status: 'pending' | 'succeeded' | 'failed' | 'cancelled';
  readonly authorizeUrl?: string;
  readonly browserReady?: boolean;
  readonly error?: 'authorization_failed' | 'credential_save_failed';
};
export type ChatGPTAccount = {
  readonly authRef: string;
  readonly label: string;
  readonly state: 'connected' | 'signed_out' | 'reauth_required';
  readonly planUsage: 'enabled' | 'disabled';
};
