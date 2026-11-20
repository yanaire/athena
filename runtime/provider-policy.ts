import type { Provider } from '@earendil-works/pi-ai';
import type { ProviderAuthMethod } from '../athena-backend-handoff/athena-codex-ui/integrations/model-profiles.d.ts';

// Policies describe exceptional authentication requirements; SDK discovery owns the inventory.
const hostSetup: Readonly<Record<string, string>> = Object.freeze({
  'amazon-bedrock': 'Configure AWS credentials and region on the Athena host.',
  'google-vertex': 'Configure Google Cloud credentials, project and location on the Athena host.',
  azure: 'Configure the Azure OpenAI key, resource and deployment on the Athena host.',
  'cloudflare-ai-gateway': 'Configure the Cloudflare account, gateway and provider credentials on the Athena host.',
  'cloudflare-workers-ai': 'Configure the Cloudflare account and API token on the Athena host.',
});

const oauthReasons: Readonly<Record<string, string>> = Object.freeze({
  anthropic: 'Anthropic restricts Claude subscription login to its own applications. Use a Claude Console API key.',
  'openai-codex': 'The SDK uses the native Codex client registration. Athena has no authorization to reuse that registration.',
});

export function providerMethods(provider: Provider, enabledOAuth: ReadonlySet<string>): readonly ProviderAuthMethod[] {
  const methods: ProviderAuthMethod[] = [];
  const setup = Object.hasOwn(hostSetup, provider.id) ? hostSetup[provider.id] : undefined;
  if (provider.auth.apiKey) {
    methods.push(setup || !provider.auth.apiKey.login
      ? { kind: 'host', label: provider.auth.apiKey.name, enabled: true, reason: setup ?? 'Configure this credential on the Athena host.' }
      : { kind: 'api_key', label: provider.auth.apiKey.name, enabled: true });
  }
  if (provider.auth.oauth && provider.id !== 'anthropic') {
    const enabled = enabledOAuth.has(provider.id) && !Object.hasOwn(oauthReasons, provider.id);
    methods.push({ kind: 'oauth', label: provider.auth.oauth.loginLabel ?? provider.auth.oauth.name, enabled,
      ...(!enabled ? { reason: (Object.hasOwn(oauthReasons, provider.id) ? oauthReasons[provider.id] : undefined)
        ?? 'The SDK advertises OAuth; this provider has no policy-verified Athena login integration.' } : {}) });
  }
  return methods;
}
