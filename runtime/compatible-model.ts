import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import { baseURL, object } from './connections.ts';

export function compatibleEndpoint(input: string): { readonly url: string; readonly loopback: boolean } {
  const url = baseURL(input);
  return { url, loopback: ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname) };
}

/** A credential and its destination are captured together. Redirects are never followed. */
export function addCompatibleModels(runtime: ModelRuntime, provider: string, name: string,
  endpoint: ReturnType<typeof compatibleEndpoint>, ids: readonly string[], key?: string): Promise<void> {
  runtime.registerProvider(provider, {
    name, baseUrl: endpoint.url, api: 'openai-completions', authHeader: Boolean(key),
    streamSimple: (model, context, options) => streamSimple({ ...model, api: 'openai-completions', baseUrl: endpoint.url }, context, {
      ...options, fetch: (input, init) => {
        const target = new URL(input instanceof Request ? input.url : String(input));
        if (target.origin !== new URL(endpoint.url).origin) throw new Error('The inference destination changed.');
        return fetch(input, { ...init, redirect: 'error' });
      }, ...(!key && endpoint.loopback ? { headers: { ...options?.headers, Authorization: null } } : {}),
    }),
    models: ids.map(id => ({ id, name: id, reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsDeveloperRole: false, supportsStore: false, supportsUsageInStreaming: true } })),
  });
  return key || endpoint.loopback ? runtime.setRuntimeApiKey(provider, key || 'athena-loopback') : Promise.resolve();
}

export async function fetchCompatibleModels(endpoint: ReturnType<typeof compatibleEndpoint>, key: string | undefined, signal: AbortSignal) {
  if (!endpoint.loopback && !key) throw new Error('Add this endpoint’s API key before checking it.');
  const response = await fetch(endpoint.url + '/models', {
    headers: key ? { Authorization: `Bearer ${key}` } : {}, redirect: 'error', signal,
  });
  if (!response.ok) throw new Error(`Model listing failed (HTTP ${response.status}).`);
  const stream = response.body?.getReader();
  if (!stream) throw new Error('Endpoint returned no model list.');
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const part = await stream.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > 1024 * 1024) throw new Error('The model list is too large.');
      chunks.push(part.value);
    }
  } finally { await stream.cancel().catch(() => undefined); }
  const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!object(body) || !Array.isArray(body.data)) throw new Error('Endpoint returned no compatible model list.');
  return [...new Set(body.data.filter(object).map(m => m.id).filter((id): id is string =>
    typeof id === 'string' && id.length > 0 && id.length <= 256 && !/[\x00-\x1f\x7f]/u.test(id) && (!key || !id.includes(key))))].slice(0, 1024);
}
