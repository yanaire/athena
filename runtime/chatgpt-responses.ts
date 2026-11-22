import { lazyStream } from "@earendil-works/pi-ai/api/lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import type { Api, Model, ProviderStreams, StreamOptions } from "@earendil-works/pi-ai";
import { object } from './connections.ts';
import { CHATGPT_RESOURCE } from './chatgpt-catalog.ts';

const endpoint = CHATGPT_RESOURCE + '/responses';
// Responses fields supported by the ChatGPT plan HTTP route. In particular,
// previous_response_id and prompt_cache_options must not escape SDK defaults.
const fields = new Set([
  "model", "input", "instructions", "tools", "tool_choice", "parallel_tool_calls",
  "reasoning", "text", "include", "prompt_cache_key", "store", "stream",
]);
const inputTypes = new Set([
  "message", "reasoning", "function_call", "function_call_output",
  "custom_tool_call", "custom_tool_call_output", "additional_tools",
]);

class ChatGPTResponsesError extends Error {
  readonly code = "CHATGPT_RESPONSES";
}

const errorCodes = new Set([
  'subscription_sharing_user_not_eligible', 'subscription_sharing_usage_limit_exceeded',
  'subscription_sharing_usage_unavailable', 'subscription_sharing_unsupported_capability',
  'subscription_sharing_route_not_supported', 'subscription_sharing_invalid_user',
  'subscription_sharing_user_unavailable', 'chatpass_v2_scope_not_authorized',
  'chatpass_v2_invalid_authorization_context', 'rate_limit_exceeded', 'invalid_api_key',
]);

function errorFields(value: unknown): string {
  if (!object(value)) return 'code=provider_error';
  const code = typeof value.code === 'string' && errorCodes.has(value.code) ? value.code : 'provider_error';
  const param = typeof value.param === 'string' && (fields.has(value.param)
    || ['service_tier', 'previous_response_id', 'prompt', 'prompt_cache_options', 'max_output_tokens', 'temperature'].includes(value.param))
    ? `; param=${value.param}` : '';
  return `code=${code}${param}`;
}

function tools(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(object)) {
    throw new ChatGPTResponsesError("Invalid ChatGPT tool declarations.");
  }
  for (const tool of value) {
    if (tool.type !== "function" && tool.type !== "custom") {
      throw new ChatGPTResponsesError("Only local function/custom tools are supported.");
    }
    if (typeof tool.name !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name)) {
      throw new ChatGPTResponsesError("Invalid ChatGPT tool name.");
    }
  }
  return value;
}

function payload(value: unknown, selectedId: string): Record<string, unknown> {
  if (!object(value) || value.model !== selectedId) {
    throw new ChatGPTResponsesError("Outbound model differs from the selected model.");
  }
  if (!Array.isArray(value.input) || !value.input.every(object)) {
    throw new ChatGPTResponsesError("ChatGPT requires full history as an input array.");
  }
  const input = value.input.map(item => {
    if (item.type !== undefined && !inputTypes.has(String(item.type))) {
      throw new ChatGPTResponsesError("Unsupported ChatGPT history item.");
    }
    if (item.type === "additional_tools") tools(item.tools);
    return item.role === "system" ? { ...item, role: "developer" } : item;
  });
  // The SDK already emits additional_tools for transcript declarations. Also
  // handle functions introduced by onPayload, without renaming local tools.
  if (value.tools !== undefined) {
    const declarations = tools(value.tools);
    if (declarations.length) input.unshift({ type: "additional_tools", role: "developer", tools: declarations });
  }
  const result = Object.fromEntries(Object.entries(value).filter(([key]) => fields.has(key) && key !== "tools"));
  return { ...result, input, store: false, stream: true };
}

function canonicalModel(id: string): string {
  // OpenAI can report the dated canonical model for an undated catalog slug.
  return id.replace(/-(?:\d{4}-\d{2}-\d{2}|\d{8})$/, "");
}

/**
 * Pi 1.5.2 createProvider({ ...identityAndAuth, models: [selected],
 *   api: chatGPTResponsesApi() }).
 *
 * Pass the selected account's OAuth access token as options.apiKey (normally
 * resolved by Models). No environment credential lookup, refresh, or discovery.
 * An opaque bearer cannot prove its OAuth provenance; the host owns that check.
 *
 * Contract: developers.openai.com/siwc/token-sharing-open-source/
 * models-and-inference and preview-limitations (read 2026-11-20).
 */
export function chatGPTResponsesApi(): ProviderStreams {
  const upstream = openAIResponsesApi();
  const run = (
    method: "stream" | "streamSimple", model: Model<Api>,
    context: Parameters<ProviderStreams["stream"]>[1], options: StreamOptions = {},
  ) => lazyStream(model, async () => {
    const token = options.apiKey;
    if (!token || /\s/.test(token)) {
      throw new ChatGPTResponsesError("A ChatGPT OAuth access token is required.");
    }
    if (model.provider !== "openai" || model.api !== "openai-responses"
      || model.baseUrl !== CHATGPT_RESOURCE) {
      throw new ChatGPTResponsesError("ChatGPT OAuth requires the public OpenAI Responses provider.");
    }
    const selected = {
      ...model,
      compat: {
        ...model.compat, supportsMidConvoSystemMessages: true,
        supportsAdditionalTools: true, supportsToolSearch: false,
        supportsOpenAIGrammarTools: false, supportsMidConvoEffort: false,
      },
    };
    let completed = false;
    const transport = options.fetch ?? globalThis.fetch;
    const scopedFetch: typeof globalThis.fetch = async (url, init) => {
      const request = new Request(url, init);
      if (request.url !== endpoint || request.method !== "POST"
        || request.headers.get("authorization") !== `Bearer ${token}`) {
        throw new ChatGPTResponsesError("ChatGPT request destination or authorization was overridden.");
      }
      const body: unknown = JSON.parse(await request.clone().text());
      const safe = payload(body, model.id);
      let response: Response;
      try {
        response = await transport(endpoint, {
          ...init, method: "POST", headers: request.headers,
          body: JSON.stringify(safe), signal: request.signal, redirect: "error",
        });
      } catch {
        // Transport exceptions can contain request headers or reflected tokens.
        throw new ChatGPTResponsesError("ChatGPT transport failed or was aborted.");
      }
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new ChatGPTResponsesError("ChatGPT redirects are forbidden.");
      }
      if (!response.ok) {
        let failure: unknown;
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
            if (size <= 64 * 1024) failure = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            // Untrusted transport/parsing failures reveal no upstream text.
            failure = undefined;
          } finally { await reader.cancel(); }
        }
        const shape = object(failure) ? object(failure.error) ? 'structured'
          : typeof failure.detail === 'string' ? 'detail' : 'other' : 'malformed';
        const requestId = response.headers.get('x-request-id');
        const request = requestId && /^req_[\w-]{1,128}$/u.test(requestId) && !requestId.includes(token)
          ? `; request_id=${requestId}` : '';
        // Retain admission status and safe diagnostics, never arbitrary text.
        const message = `ChatGPT HTTP request failed (status=${response.status}; shape=${shape}; ${errorFields(object(failure) ? failure.error : undefined)}${request}).`;
        return Response.json({ error: { message } }, { status: response.status });
      }
      return response;
    };
    const source = upstream[method](selected, context, {
      ...options, fetch: scopedFetch, maxRetries: 0,
      onPayload: async (body, current) => payload(
        (await options.onPayload?.(payload(body, model.id), current)) ?? payload(body, model.id),
        model.id,
      ),
      onProviderStreamEvent: async (event, current) => {
        if (object(event)) {
          if (object(event.response) && typeof event.response.model === "string"
            && event.response.model !== model.id && canonicalModel(event.response.model) !== model.id) {
            throw new ChatGPTResponsesError("Remote response reports a different model.");
          }
          if (event.type === "error" || event.type === "response.failed") {
            const error = object(event.response) ? event.response.error : event;
            throw new ChatGPTResponsesError(`ChatGPT response failed (${errorFields(error)}).`);
          }
          if (event.type === "response.completed") {
            if (!object(event.response) || event.response.status !== "completed") {
              throw new ChatGPTResponsesError("Invalid ChatGPT completion event.");
            }
            completed = true;
          }
        }
        await options.onProviderStreamEvent?.(event, current);
      },
    });
    return (async function* () {
      for await (const event of source) {
        if (event.type === "done" && !completed) {
          yield { type: "error", reason: "error", error: {
            ...event.message, stopReason: "error",
            errorMessage: "ChatGPT response incomplete; response.completed was not received.",
          } } as const;
        } else if (event.type === "error") {
          // SDK errors and caller hooks may reflect credentials in messages.
          const message = (event.error.errorMessage ?? "ChatGPT request failed.")
            .replaceAll(token, "[redacted]").replace(/Bearer\s+[^\s"',]+/gi, "Bearer [redacted]");
          yield { ...event, error: { ...event.error, errorMessage: message } };
        } else {
          yield event;
        }
      }
    })();
  }, undefined, options.signal);
  return {
    stream: (model, context, options) => run("stream", model, context, options),
    streamSimple: (model, context, options) => run("streamSimple", model, context, options),
  };
}
