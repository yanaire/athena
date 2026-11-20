/** Proposed Athena host contract. Supplying this adapter does not connect a model.
 * Credentials, endpoint probing and durable writes must be implemented by the host. */
export interface ModelReference { provider: string; modelId: string; thinkingLevel?: string }
export interface ModelScopes {
  appDefault: ModelReference | string | null;
  projectDefault: ModelReference | string | null;
  conversation: ModelReference | string | null;
  /** Immutable for a started run. Do not replace this when defaults change. */
  runLocked: (ModelReference & { runId?: string; resolvedAt?: string }) | string | null;
}
export interface NonsecretModelConfiguration {
  version: 1;
  provider: 'openai-compatible' | 'local' | 'custom';
  endpoint: string;
  defaultModel: string;
  roleModels: Record<'main' | 'researcher' | 'analyst' | 'reviewer' | 'writer', string>;
  parallelLimit: number;
  contextBudget: number;
  outputBudget: number;
}
export interface ConnectionSnapshot {
  status: 'disconnected' | 'configured' | 'connected' | 'error';
  configurationId?: string;
  revision?: string | number;
  defaultModel?: ModelReference | null;
  /** Validated host draft, present even before configurationId is assigned. */
  configuration?: NonsecretModelConfiguration;
  verification?: { status: 'not_checked' | 'connected' | 'failed'; checkedAt?: string; message?: string };
}
export interface NewConversationRequest {
  projectId: string | null;
  title?: string;
  configurationId?: string;
  /** Explicit conversation override, else host resolves project then app default. */
  model?: ModelReference | null;
}
export interface SessionActivation {
  sessionId: string;
  projectId?: string;
  title?: string;
  model?: ModelReference;
  sessionFile?: string;
  /** Existing live Pi connection object; the UI does not fabricate a transport. */
  connection?: { subscribe(listener: (event: unknown) => void): () => void; [key: string]: unknown };
}
export interface ConnectionHost {
  getState?(): ConnectionSnapshot;
  subscribe?(listener: (state: ConnectionSnapshot) => void): () => void;
  saveConfig?(config: NonsecretModelConfiguration): Promise<{
    saved: true; configurationId: string; revision?: string | number;
    configuration?: NonsecretModelConfiguration; defaultModel?: ModelReference;
  }>;
  /** Explicit provider I/O, separate from local format validation and saving. */
  verifyConnection?(config: NonsecretModelConfiguration): Promise<{
    status: 'connected' | 'failed'; checkedAt?: string; message?: string; models?: ModelReference[];
  }>;
  createSession?(request: NewConversationRequest): Promise<SessionActivation>;
}
/** Model settings save changes the app default only. Project defaults are owned by
 * the project service, conversation overrides by the session, and runLocked by
 * Athena TaskManager at dispatch. Defaults never rewrite started run records. */
