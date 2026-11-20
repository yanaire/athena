import type { ModelReference } from './connections.d.ts';

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ProviderAuthMethod = {
  readonly kind: 'api_key' | 'oauth' | 'host';
  readonly label: string;
  readonly enabled: boolean;
  readonly reason?: string;
};
export type ProviderSummary = {
  readonly id: string;
  readonly name: string;
  readonly methods: readonly ProviderAuthMethod[];
  readonly auth: 'not_checked' | 'unconfigured' | 'configured' | 'refresh_required' | 'error';
  readonly credentialType?: 'api_key' | 'oauth';
};
export type CatalogModel = {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
  readonly api: string;
  readonly input: readonly string[];
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly reasoning: boolean;
  readonly thinkingLevels: readonly ThinkingLevel[];
  readonly tools: 'unverified';
  readonly cost: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number } | null;
};
export type ProviderCatalog = {
  readonly provider: ProviderSummary;
  readonly models: readonly CatalogModel[];
  /** SDK eligibility, not an entitlement or successful inference check. */
  readonly availableModelIds: readonly string[];
  readonly source: 'sdk_catalog' | 'refreshed_catalog';
  readonly checkedAt: string;
  readonly error?: 'refresh_failed' | 'availability_failed';
};
export type ModelProfile = ModelReference & {
  readonly id: string;
  readonly name: string;
  readonly revision: number;
  readonly thinkingLevel: ThinkingLevel;
  readonly endpoint?: string;
  readonly authRef: string;
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
};
export type ModelProfileInput = Pick<ModelProfile, 'name' | 'provider' | 'modelId'> & Partial<Pick<ModelProfile, 'id' | 'revision' | 'thinkingLevel'>>;
export type ModelProfileList = {
  readonly profiles: readonly ModelProfile[];
  readonly appDefaultProfileId: string | null;
  readonly credentialMode: 'keychain' | 'operator_key' | 'memory';
  readonly hostModel: ModelReference | null;
};
export type ProviderOAuthFlow = {
  readonly id: string;
  readonly status: 'pending' | 'succeeded' | 'failed' | 'cancelled';
  readonly authorizeUrl?: string;
  readonly error?: 'authorization_failed' | 'credential_save_failed';
};
