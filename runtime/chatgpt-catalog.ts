import { createHash } from 'node:crypto';
import type { Model, OAuthCredential } from '@earendil-works/pi-ai';
import { object } from './connections.ts';

export const CHATGPT_RESOURCE = 'https://api.openai.com/v1';

export function chatGPTAccountRef(credential: OAuthCredential): string | undefined {
  const { clientId, subject } = credential;
  if (credential.issuer !== 'https://auth.openai.com' || typeof clientId !== 'string' || !/^oaiapp_[\w-]+$/u.test(clientId)
    || typeof subject !== 'string' || !subject) return undefined;
  return 'chatgpt:' + createHash('sha256').update(JSON.stringify([clientId, subject])).digest('hex');
}

export type ChatGPTCatalogEntry = { readonly slug: string; readonly label: string };

export async function fetchChatGPTCatalog(access: string, signal: AbortSignal): Promise<readonly ChatGPTCatalogEntry[]> {
  const response = await fetch(CHATGPT_RESOURCE + '/models', {
    headers: { Authorization: `Bearer ${access}`, Accept: 'application/json' }, redirect: 'error', cache: 'no-store', signal,
  });
  if (!response.ok || !response.body) throw new Error('The ChatGPT account list could not be loaded.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 2 * 1024 * 1024) throw new RangeError('ChatGPT model list exceeds the response limit.');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
  }
  const payload: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!object(payload) || !Array.isArray(payload.models)) throw new TypeError('Expected the ChatGPT account model list.');
  const entries = new Map<string, ChatGPTCatalogEntry>();
  for (const item of payload.models) {
    if (!object(item) || item.visibility !== 'list' || typeof item.slug !== 'string' || !/^[\w.-]{1,256}$/u.test(item.slug)
      || typeof item.display_name !== 'string' || !item.display_name.trim() || item.display_name.length > 256
      || /[\u0000-\u001f\u007f]/u.test(item.display_name) || item.slug.includes(access)
      || item.display_name.includes(access) || entries.has(item.slug)) continue;
    entries.set(item.slug, { slug: item.slug, label: item.display_name });
  }
  return [...entries.values()];
}

export function accountModel(entry: ChatGPTCatalogEntry, known?: Model<'openai-responses'>): Model<'openai-responses'> {
  // Pi needs internal budgets even when the service supplies no capabilities. These are not advertised as provider limits.
  return {
    input: ['text'], reasoning: false, contextWindow: 8192, maxTokens: 2048,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ...known,
    id: entry.slug, name: entry.label, api: 'openai-responses', provider: 'openai', baseUrl: CHATGPT_RESOURCE,
  };
}
