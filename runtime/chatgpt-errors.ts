import type { ModelCheck } from '../athena-backend-handoff/athena-codex-ui/integrations/model-profiles.d.ts';

export async function readChatGPTError(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (reader) {
    try {
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 64 * 1024) break;
        chunks.push(part.value);
      }
      if (size <= 64 * 1024) return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      // Untrusted transport/parsing failures reveal no upstream text.
      return undefined;
    } finally { await reader.cancel().catch(() => undefined); }
  }
  return undefined;
}

// Prefer specific plan errors, including errors in an already-admitted stream.
export function chatGPTFailureReason(status?: number, code?: unknown, type?: unknown): NonNullable<ModelCheck['error']> {
  switch (code) {
    case 'subscription_sharing_usage_limit_exceeded': return 'usage_limit';
    case 'subscription_sharing_user_not_eligible':
    case 'chatpass_v2_invalid_authorization_context':
    case 'chatpass_v2_scope_not_authorized': return 'permission';
    case 'subscription_sharing_invalid_user': case 'invalid_api_key': return 'authentication';
    case 'model_not_found': return 'model_unavailable';
    case 'rate_limit_exceeded': return 'rate_limited';
    case 'subscription_sharing_route_not_supported':
    case 'subscription_sharing_unsupported_capability': return 'invalid_request';
    case 'subscription_sharing_usage_unavailable':
    case 'subscription_sharing_user_unavailable': return 'service_unavailable';
  }
  if (status === 401 || type === 'authentication_error') return 'authentication';
  if (status === 403 || type === 'permission_error') return 'permission';
  if (status === 429 || type === 'rate_limit_error') return 'rate_limited';
  if (status === 404) return 'model_unavailable';
  if (status === 400 || status === 422 || type === 'invalid_request_error' || code === 'invalid_request_error') return 'invalid_request';
  if ((status !== undefined && status >= 500) || type === 'server_error') return 'service_unavailable';
  return 'connection';
}
