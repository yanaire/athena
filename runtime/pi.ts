import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  createAgentSession, createExtensionRuntime, ModelRuntime,
  SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ResourceLoader } from "@earendil-works/pi-coding-agent";
import { streamSimple as streamOpenAI } from "@earendil-works/pi-ai/api/openai-completions";
import { createPiHostAdapter } from "../athena-backend-handoff/athena-codex-ui/integrations/pi-host-adapter.mjs";
import { createProjectReadTool } from "./files.ts";

export class PiRuntimeError extends Error {
  readonly code = "PI_RUNTIME_ERROR";
}

export interface EndpointConfig {
  readonly endpoint: string;
  readonly model: string;
  readonly provider: "athena";
  readonly modelReference: string;
  readonly loopback: boolean;
}

/** Operator configuration only; browser commands never select credential targets. */
export function endpointConfig(): EndpointConfig | undefined {
  const endpoint = process.env.ATHENA_ENDPOINT;
  if (!endpoint) return undefined;
  const model = process.env.ATHENA_MODEL;
  if (!model) throw new PiRuntimeError("ATHENA_MODEL is required with ATHENA_ENDPOINT.");
  const url = new URL(endpoint);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash
    || !(url.protocol === "https:" || (url.protocol === "http:" && loopback))) {
    throw new PiRuntimeError("Use HTTPS or loopback HTTP without URL credentials, query or fragment.");
  }
  return { endpoint: url.href.replace(/\/+$/, ""), model, provider: "athena", modelReference: `athena/${model}`, loopback };
}

export function modelReference(): string | undefined {
  const config = endpointConfig();
  if (config) return config.modelReference;
  return process.env.ATHENA_PROVIDER && process.env.ATHENA_MODEL
    ? `${process.env.ATHENA_PROVIDER}/${process.env.ATHENA_MODEL}` : undefined;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Remove credential-bearing fields and accidental provider echoes at the public boundary. */
function publicValue(value: unknown, secret: string | undefined): unknown {
  if (typeof value === "string") {
    return (secret ? value.replaceAll(secret, "[redacted]") : value)
      .replace(/Bearer\s+[^\s"',]+/gi, "Bearer [redacted]");
  }
  if (Array.isArray(value)) return value.map(item => publicValue(item, secret));
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key, item]) => item !== undefined && !/api.?key|token|secret|password|authorization|headers|credentials|environment|^env$/i.test(key))
    .map(([key, item]) => [key, publicValue(item, secret)]));
}

export interface PiEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface PiSessionOptions {
  readonly projectDir: string;
  readonly sessionDir: string;
  readonly sessionFile?: string;
}

interface HostAdapter {
  request(command: unknown): Promise<unknown>;
  subscribe(listener: (event: unknown) => void): () => void;
  destroy(): void;
}

function hostAdapter(value: unknown): value is HostAdapter {
  return object(value) && typeof value.request === "function"
    && typeof value.subscribe === "function" && typeof value.destroy === "function";
}

/** No discovery: extensions, MCP, skills, context files, and packages never load. */
function fixedResources(): ResourceLoader {
  const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
  return {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => "You are Athena, a research assistant. Use the read tool to inspect project files when requested. Only claim to have read a file after a successful tool result. No shell, write, or network tools are available.",
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => { throw new PiRuntimeError("Resources are fixed for this host."); },
    reload: async () => {},
  };
}

export async function createPiSession(options: PiSessionOptions) {
  const projectDir = await realpath(options.projectDir);
  const sessionDir = resolve(options.sessionDir);
  await mkdir(sessionDir, { recursive: true, mode: 0o700 });
  if (options.sessionFile) {
    // SessionManager.open silently starts anew for absent/malformed files. Reject those here.
    const text = await readFile(options.sessionFile, "utf8");
    const header: unknown = JSON.parse(text.split("\n")[0] ?? "");
    if (!object(header) || header.type !== "session" || typeof header.id !== "string"
      || typeof header.cwd !== "string" || await realpath(header.cwd) !== projectDir) {
      throw new PiRuntimeError("Session header does not belong to this project.");
    }
  }
  const manager = options.sessionFile
    ? SessionManager.open(options.sessionFile, sessionDir, projectDir)
    : SessionManager.create(projectDir, sessionDir);
  const sessionFile = manager.getSessionFile();
  if (!sessionFile) throw new PiRuntimeError("Pi did not assign a persistent session file.");
  if (!options.sessionFile) {
    // The SDK defers its first flush and opens with "wx". Persist its genuine header,
    // then reopen through the public API so subsequent SDK writes append to this file.
    await mkdir(dirname(sessionFile), { recursive: true, mode: 0o700 });
    await writeFile(sessionFile, `${JSON.stringify(manager.getHeader())}\n`, { flag: "wx", mode: 0o600 });
    manager.setSessionFile(sessionFile);
  }
  const config = endpointConfig();
  const provider = config?.provider ?? process.env.ATHENA_PROVIDER;
  const modelId = config?.model ?? process.env.ATHENA_MODEL;
  const secret = process.env.ATHENA_API_KEY;
  const modelRuntime = await ModelRuntime.create({
    // ModelRuntime owns the official AuthStorage; 1.5.2 does not export that class.
    authPath: config ? join(sessionDir, ".agent", "auth.json") : process.env.ATHENA_AUTH_PATH,
    modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
  });
  if (config) {
    modelRuntime.registerProvider("athena", {
      name: "Athena configured endpoint",
      baseUrl: config.endpoint,
      api: "openai-completions",
      authHeader: Boolean(secret),
      streamSimple: (model, context, options) => streamOpenAI(
        { ...model, api: "openai-completions" }, context,
        { ...options, ...(config.loopback && !secret ? { headers: { ...options?.headers, Authorization: null } } : {}) },
      ),
      models: [{
        id: config.model, name: config.model, reasoning: false, input: ["text"],
        contextWindow: 32768, maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: { supportsDeveloperRole: false, supportsStore: false, supportsUsageInStreaming: true },
      }],
    });
    // Pi requires configured auth for requests. Loopback's sentinel is never sent as a header.
    if (secret || config.loopback) await modelRuntime.setRuntimeApiKey("athena", secret || "athena-loopback");
  } else if (provider && secret) {
    await modelRuntime.setRuntimeApiKey(provider, secret);
  }
  const model = provider && modelId ? modelRuntime.getModel(provider, modelId) : undefined;
  if (provider && modelId && !model) throw new PiRuntimeError("The configured official Pi model was not found.");
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } },
    packages: [], extensions: [], skills: [], cacheWarming: "off",
    enableAnalytics: false, enableInstallTelemetry: false,
  });
  const { session } = await createAgentSession({
    cwd: projectDir, agentDir: join(sessionDir, ".agent"),
    sessionManager: manager, modelRuntime, settingsManager,
    ...(model ? { model } : {}),
    thinkingLevel: "off", tools: ["read"], customTools: [createProjectReadTool(projectDir)],
    resourceLoader: fixedResources(),
  });
  const adapter = createPiHostAdapter({ session, sessionManager: manager, modelRuntime });
  if (!hostAdapter(adapter)) {
    session.dispose();
    throw new PiRuntimeError("The attached Pi host adapter has an incompatible API.");
  }
  let closed = false;
  function ensureOpen() {
    if (closed) throw new PiRuntimeError("The Pi session is closed.");
  }
  function assertPromptReady() {
    ensureOpen();
    if (!model) throw new PiRuntimeError("Configure ATHENA_MODEL and ATHENA_ENDPOINT, or ATHENA_PROVIDER, before prompting.");
    if (config && !config.loopback && !secret) throw new PiRuntimeError("ATHENA_API_KEY is required for this endpoint.");
  }
  const api = {
    sessionId: session.sessionId,
    sessionFile,
    getState() {
      ensureOpen();
      return {
        sessionId: session.sessionId, sessionFile, isStreaming: session.isStreaming,
        isIdle: session.isIdle, messageCount: session.messages.length,
        model: session.model ? { provider: session.model.provider, id: session.model.id, name: session.model.name } : null,
        thinkingLevel: session.thinkingLevel,
      };
    },
    getMessages(): readonly unknown[] {
      ensureOpen();
      return session.messages.map(message => publicValue(message, secret));
    },
    subscribe(listener: (event: PiEvent) => void): () => void {
      ensureOpen();
      return adapter.subscribe((value: unknown) => {
        const clean = publicValue(value, secret);
        if (object(clean) && typeof clean.type === "string") listener({ ...clean, type: clean.type });
      });
    },
    /** Completion promise, unlike command(prompt)'s early acceptance response. */
    async prompt(message: string): Promise<void> {
      assertPromptReady();
      try {
        await session.prompt(message, { expandPromptTemplates: false, source: "rpc" });
      } catch (error) {
        if (error instanceof Error) throw new PiRuntimeError(String(publicValue(error.message, secret)));
        throw error;
      }
    },
    async command(command: unknown): Promise<unknown> {
      ensureOpen();
      if (!object(command) || typeof command.type !== "string") throw new PiRuntimeError("A typed command object is required.");
      switch (command.type) {
        case "prompt": assertPromptReady(); break;
        case "abort":
        case "get_state":
        case "get_messages":
        case "get_entries":
        case "get_tools":
        case "get_session_stats":
        case "get_available_thinking_levels":
        case "set_thinking_level": break;
        case "get_available_models":
          return {
            type: "response", command: command.type, success: true,
            ...(typeof command.id === "string" ? { id: command.id } : {}),
            data: { models: model ? [{ id: model.id, provider: model.provider, name: model.name,
              reasoning: model.reasoning, input: model.input, contextWindow: model.contextWindow, maxTokens: model.maxTokens }] : [] },
          };
        default: throw new PiRuntimeError("Command is not allowed by this host.");
      }
      return publicValue(await adapter.request(command), secret);
    },
    close(): void {
      if (session.isStreaming) throw new PiRuntimeError("Abort and settle the session before closing it.");
      adapter.destroy();
      session.dispose();
      closed = true;
    },
  };
  return api;
}

export type PiSession = Awaited<ReturnType<typeof createPiSession>>;
