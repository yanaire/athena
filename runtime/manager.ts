import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Storage } from './storage.ts';
import type { StoredSession } from './storage.ts';
import type {
  AthenaTaskManager, ModelReference, Project, SessionActivation, Status, Task, Tool,
  WorkspaceEvent, WorkspaceSnapshot,
} from '../athena-backend-handoff/athena-codex-ui/integrations/task-manager.d.ts';
import type { FileReference } from '../athena-backend-handoff/athena-codex-ui/integrations/pi-bridge-contracts.d.ts';

export type PiCommand = Readonly<Record<string, unknown>> & { readonly type: string; readonly id?: string };
export type StagedFileInput = { readonly name: string; readonly mimeType: string; readonly data: string };
type PiEvent = Readonly<Record<string, unknown>> & { readonly type: string };
export interface ManagedPiSession {
  readonly sessionId: string;
  readonly sessionFile: string;
  command(command: PiCommand): Promise<unknown>;
  subscribe(listener: (event: PiEvent) => void): () => void;
  close(): void;
  getState(): unknown;
  getMessages(): unknown;
  prompt(message: string): Promise<void>;
}
export type PiSessionFactory = (options: {
  readonly projectDir: string; readonly sessionDir: string; readonly sessionFile?: string;
}) => Promise<ManagedPiSession>;
export type TaskManagerOptions = { readonly dataDir: string; readonly createPiSession?: PiSessionFactory };
type Run = {
  readonly id: string; readonly projectId: string; readonly sessionId: string;
  readonly requestId: string; readonly taskId: string; readonly title: string;
  readonly status: Status; readonly startedAt: number | null; readonly endedAt: number | null;
  readonly model: ModelReference | null; readonly error?: string;
};
type StoredFile = FileReference & {
  readonly projectId: string; readonly sessionId: string; readonly path: string; readonly digest: string;
};
type Response = {
  readonly type: 'response'; readonly command: string; readonly id?: string;
  readonly success: boolean; readonly data?: unknown; readonly error?: string;
};

export class ManagerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ManagerError('INVALID_INPUT', `${name} is required.`);
  return value;
}
function hash(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().filter(key => value[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function pending(status: Status): boolean { return status === 'queued' || status === 'running' || status === 'blocked'; }
function reply(command: PiCommand, data: unknown): Response {
  return { type: 'response', command: command.type, ...(command.id ? { id: command.id } : {}), success: true, data };
}
const READ_COMMANDS = ['get_state', 'get_messages', 'get_available_models', 'get_entries', 'get_tools', 'get_session_stats', 'get_available_thinking_levels'] as const;
const SNAPSHOT_EVENTS = new Set([
  'agent_start', 'agent_end', 'agent_settled', 'message_end', 'auto_retry_start', 'auto_retry_end',
  'tool_execution_start', 'tool_execution_end', 'compaction_start', 'compaction_end',
]);

/** One active runtime; SQLite owns acceptance and projections, Pi owns execution and messages. */
export class TaskManager implements AthenaTaskManager {
  readonly capabilities: AthenaTaskManager['capabilities'] = ['create_project', 'create_session', 'open_session', 'set_project_model', 'cancel_run'];
  readonly inputContract = {
    maxMessageCharacters: 262144, lengthUnit: 'utf16-code-units',
    supportsFileReferences: true, canStageFiles: true,
  } as const;
  readonly #storage: Storage;
  readonly #directory: string;
  readonly #factory: PiSessionFactory;
  readonly #listeners = new Set<(snapshot: WorkspaceSnapshot) => void>();
  readonly #piListeners = new Set<(sessionId: string, event: PiEvent) => void>();
  #runtime: ManagedPiSession | undefined;
  #unsubscribe: (() => void) | undefined;
  #active: string | null = null;
  #busy = false;
  #ready = false;
  #closed = false;

  constructor(options: TaskManagerOptions) {
    this.#directory = options.dataDir;
    this.#storage = new Storage(options.dataDir);
    this.#factory = options.createPiSession ?? (async options => {
      const { createPiSession } = await import('./pi.ts');
      return createPiSession(options);
    });
  }

  get piCapabilities(): string[] { return ['prompt', ...READ_COMMANDS, 'abort', 'stage_files']; }

  async initialize(): Promise<void> {
    if (this.#ready) return;
    if (this.#closed || this.#busy) throw new ManagerError('BUSY', 'Manager is closed or initializing.');
    this.#busy = true;
    try {
      this.#storage.transaction(() => {
        for (const session of this.#storage.sessions()) this.#interrupt(session.id, 'Host restarted before execution settled.');
        for (const receipt of this.#storage.pendingReceipts()) {
          this.#storage.putReceipt({ ...receipt, state: 'interrupted', response: {
            type: 'response', command: 'prompt', id: receipt.requestId, success: false,
            error: 'Execution was interrupted; this request ID will not be dispatched again.',
          } });
        }
        this.#storage.advanceRevision();
      });
      const selected = this.#storage.get<string | null>('activeSession') ?? null;
      if (selected) {
        const session = this.#session(selected);
        const runtime = await this.#factory(this.#sessionOptions(session));
        this.#bind(session.id, runtime);
      }
      this.#ready = true;
    } finally { this.#busy = false; }
  }

  #assertReady(): void {
    if (!this.#ready || this.#closed) throw new ManagerError('NOT_READY', 'TaskManager is not initialized.');
  }
  #assertIdle(): void {
    this.#assertReady();
    if (this.#busy || (this.#active && this.#runs(this.#active).some(run => pending(run.status)))) {
      throw new ManagerError('SESSION_BUSY', 'The active session must settle before switching.');
    }
  }
  #session(id: string): StoredSession {
    const session = this.#storage.session(id);
    if (!session) throw new ManagerError('SESSION_NOT_FOUND', 'Session does not exist.');
    return session;
  }
  #bound(id: string): { session: StoredSession; runtime: ManagedPiSession } {
    this.#assertReady();
    if (this.#busy || id !== this.#active || !this.#runtime) {
      throw new ManagerError('SESSION_MISMATCH', 'Request is not bound to the active Pi session.');
    }
    return { session: this.#session(id), runtime: this.#runtime };
  }
  #projectDir(projectId: string): string { return join(this.#directory, 'projects', projectId); }
  #sessionOptions(session: StoredSession) {
    return { projectDir: this.#projectDir(session.projectId),
      sessionDir: session.sessionDir, sessionFile: session.sessionFile };
  }
  #bind(id: string, runtime: ManagedPiSession): void {
    if (runtime.sessionId !== id) throw new ManagerError('SESSION_ID_MISMATCH', 'Persisted session ID does not match the actual Pi identity.');
    this.#unsubscribe?.();
    this.#runtime?.close();
    this.#active = id;
    this.#runtime = runtime;
    this.#unsubscribe = runtime.subscribe(event => {
      if (!this.#closed && this.#runtime === runtime && this.#active === id) this.#receive(id, event);
    });
  }
  #runs(sessionId: string): Run[] { return this.#storage.records<Run>('run', sessionId); }
  #currentRun(sessionId: string): Run | undefined { return this.#runs(sessionId).at(-1); }

  getSnapshot(): WorkspaceSnapshot {
    this.#assertReady();
    const session = this.#active ? this.#session(this.#active) : undefined;
    const run = session ? this.#currentRun(session.id) : undefined;
    return structuredClone({
      revision: this.#storage.revision(), projectId: session?.projectId ?? this.#storage.get<string | null>('activeProject') ?? null, sessionId: session?.id ?? null,
      projects: this.#storage.projects(),
      sessions: this.#storage.sessions().map(({ sessionFile: _file, sessionDir: _dir, ...metadata }) => metadata),
      run: { id: run?.id ?? null, status: run?.status ?? 'ready', startedAt: run?.startedAt ?? null,
        elapsedMs: run?.startedAt ? (run.endedAt ?? Date.now()) - run.startedAt : 0, model: run?.model ?? session?.model ?? null },
      tasks: session ? this.#storage.records<Task>('task', session.id) : [],
      agents: [], tools: session ? this.#storage.records<Tool>('tool', session.id) : [],
      artifacts: [], events: session ? this.#storage.records<WorkspaceEvent>('event', session.id) : [], approvals: [],
    });
  }

  subscribe(listener: (snapshot: WorkspaceSnapshot) => void): () => void {
    this.#assertReady();
    this.#listeners.add(listener);
    listener(this.getSnapshot());
    return () => { this.#listeners.delete(listener); };
  }
  subscribeAllPi(listener: (sessionId: string, event: PiEvent) => void): () => void {
    this.#piListeners.add(listener);
    return () => { this.#piListeners.delete(listener); };
  }
  subscribePi(sessionId: string, listener: (event: PiEvent) => void): () => void {
    this.#session(sessionId);
    return this.subscribeAllPi((id, event) => { if (id === sessionId) listener(event); });
  }
  #publish(): void {
    for (const listener of this.#listeners) listener(this.getSnapshot());
  }
  #commit(action: () => void): void {
    this.#storage.transaction(() => { action(); this.#storage.advanceRevision(); });
    this.#publish();
  }

  async createProject(input: { name: string; defaultModel?: ModelReference | null }) {
    this.#assertIdle();
    const project: Project = { id: randomUUID(), name: text(input.name, 'Project name'), defaultModel: input.defaultModel ?? null };
    mkdirSync(this.#projectDir(project.id), { recursive: true, mode: 0o700 });
    this.#unsubscribe?.();
    this.#runtime?.close();
    this.#runtime = undefined;
    this.#active = null;
    this.#commit(() => {
      this.#storage.putProject(project);
      this.#storage.set('activeProject', project.id);
      this.#storage.set('activeSession', null);
    });
    return { project, snapshot: this.getSnapshot() };
  }

  async createSession(input: { projectId: string | null; title: string; model?: ModelReference | null; configurationId?: string }): Promise<SessionActivation> {
    this.#assertIdle();
    const projectId = text(input.projectId ?? this.#storage.get<string | null>('activeProject'), 'Project ID');
    const project = this.#storage.project(projectId);
    if (!project) throw new ManagerError('PROJECT_NOT_FOUND', 'Project does not exist.');
    const title = text(input.title, 'Session title');
    const sessionDir = join(this.#directory, 'sessions', randomUUID());
    this.#busy = true;
    let runtime: ManagedPiSession | undefined;
    try {
      runtime = await this.#factory({ projectDir: this.#projectDir(projectId), sessionDir });
      const id = runtime.sessionId;
      const model = input.model ?? project.defaultModel ?? this.#model(runtime);
      this.#validateModel(runtime, model);
      const session: StoredSession = { id, projectId, title, model, sessionFile: runtime.sessionFile, sessionDir };
      this.#storage.transaction(() => {
        this.#storage.putSession(session);
        this.#storage.set('activeSession', id);
        this.#storage.set('activeProject', projectId);
        this.#storage.advanceRevision();
      });
      this.#bind(id, runtime);
      runtime = undefined;
    } finally {
      runtime?.close();
      this.#busy = false;
    }
    this.#publish();
    const snapshot = this.getSnapshot();
    return { sessionId: text(snapshot.sessionId, 'Created session ID'), projectId, title, snapshot };
  }

  async openSession(sessionId: string): Promise<SessionActivation> {
    this.#assertIdle();
    const session = this.#session(sessionId);
    if (this.#active !== sessionId) {
      this.#busy = true;
      let runtime: ManagedPiSession | undefined;
      try {
        runtime = await this.#factory(this.#sessionOptions(session));
        this.#storage.transaction(() => {
          this.#storage.set('activeSession', sessionId);
          this.#storage.set('activeProject', session.projectId);
          this.#storage.advanceRevision();
        });
        this.#bind(sessionId, runtime);
        runtime = undefined;
      } finally { runtime?.close(); this.#busy = false; }
      this.#publish();
    }
    return { sessionId, projectId: session.projectId, title: session.title, snapshot: this.getSnapshot() };
  }

  #model(runtime: ManagedPiSession): ModelReference | null {
    const state = runtime.getState();
    if (!object(state) || !object(state.model)) return null;
    const provider = state.model.provider;
    const id = state.model.id ?? state.model.modelId;
    return typeof provider === 'string' && typeof id === 'string' ? { provider, modelId: id } : null;
  }
  #validateModel(runtime: ManagedPiSession, requested: ModelReference | null): void {
    const actual = this.#model(runtime);
    if (requested && (!actual || requested.provider !== actual.provider || requested.modelId !== actual.modelId ||
        (requested.thinkingLevel != null && requested.thinkingLevel !== 'off'))) {
      throw new ManagerError('MODEL_UNAVAILABLE', 'This host cannot use the requested model or thinking level.');
    }
  }
  async setProjectDefaultModel(projectId: string, model: ModelReference | null) {
    this.#assertReady();
    const project = this.#storage.project(projectId);
    if (!project) throw new ManagerError('PROJECT_NOT_FOUND', 'Project does not exist.');
    if (model) {
      if (!this.#runtime) throw new ManagerError('MODEL_UNAVAILABLE', 'Open a session before selecting its supported model.');
      this.#validateModel(this.#runtime, model);
    }
    this.#commit(() => this.#storage.putProject({ ...project, defaultModel: model }));
    return { saved: true as const, snapshot: this.getSnapshot() };
  }

  stageFiles(sessionId: string, files: readonly StagedFileInput[]): Promise<{ fileReferences: FileReference[] }> {
    const { session } = this.#bound(sessionId);
    if (!Array.isArray(files) || !files.length) throw new ManagerError('INVALID_FILES', 'Supply at least one file.');
    const prepared = files.map(file => {
      if (!object(file) || typeof file.name !== 'string' || !file.name.trim() || typeof file.mimeType !== 'string' ||
          !(file.mimeType.startsWith('text/') || ['application/json', 'application/xml'].includes(file.mimeType)) ||
          typeof file.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.data)) {
        throw new ManagerError('UNSUPPORTED_FILE', 'Only base64 encoded UTF-8 text files can be staged.');
      }
      const bytes = Buffer.from(file.data, 'base64');
      if (bytes.length > 256 * 1024) throw new ManagerError('FILE_TOO_LARGE', 'Files must not exceed 256 KiB.');
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const id = randomUUID();
      const record: StoredFile = { id, projectId: session.projectId, sessionId, name: file.name,
        mimeType: file.mimeType, size: bytes.length, versionId: hash(bytes), digest: hash(bytes),
        path: join(this.#projectDir(session.projectId), 'uploads', `${id}.txt`) };
      return { bytes, record };
    });
    const written: string[] = [];
    try {
      for (const { bytes, record } of prepared) {
        mkdirSync(join(this.#projectDir(session.projectId), 'uploads'), { recursive: true, mode: 0o700 });
        writeFileSync(record.path, bytes, { flag: 'wx', mode: 0o600 });
        written.push(record.path);
      }
      this.#storage.transaction(() => {
        for (const { record } of prepared) this.#storage.putRecord('file', record);
      });
    } catch (error) {
      for (const path of written) rmSync(path);
      throw error;
    }
    return Promise.resolve({ fileReferences: prepared.map(({ record: { path: _path, digest: _digest, sessionId: _sessionId, ...ref } }) => ref) });
  }

  #message(command: PiCommand, session: StoredSession): string {
    if (typeof command.message !== 'string' || !command.message.trim()) throw new ManagerError('INVALID_INPUT', 'Message is required.');
    if (command.images !== undefined) throw new ManagerError('UNSUPPORTED_INPUT', 'This host accepts text messages and staged text files.');
    let message = command.message;
    if (command.fileReferences !== undefined) {
      if (!Array.isArray(command.fileReferences)) throw new ManagerError('INVALID_FILES', 'File references must be an array.');
      for (const ref of command.fileReferences) {
        if (!object(ref) || typeof ref.id !== 'string') throw new ManagerError('INVALID_FILES', 'Invalid file reference.');
        const stored = this.#storage.record<StoredFile>('file', ref.id);
        if (!stored || stored.sessionId !== session.id || stored.projectId !== session.projectId ||
            ref.projectId !== stored.projectId || ref.versionId !== stored.versionId ||
            ref.name !== stored.name || ref.size !== stored.size || ref.mimeType !== stored.mimeType) {
          throw new ManagerError('FILE_SCOPE_MISMATCH', 'The staged file does not belong to this session or version.');
        }
        const bytes = readFileSync(stored.path);
        if (hash(bytes) !== stored.digest) throw new ManagerError('FILE_CHANGED', 'The staged file content changed.');
        message += `\n\nAttached file display name: ${JSON.stringify(stored.name)}.\n` +
          `Call read with these exact arguments: ${JSON.stringify({ path: relative(this.#projectDir(session.projectId), stored.path) })}`;
      }
    }
    if (message.length > this.inputContract.maxMessageCharacters) throw new ManagerError('INPUT_TOO_LARGE', 'The complete message exceeds 262144 UTF-16 code units.');
    return message;
  }

  async pi(sessionId: string, command: PiCommand): Promise<unknown> {
    const { session, runtime } = this.#bound(sessionId);
    if (!object(command) || typeof command.type !== 'string') throw new ManagerError('INVALID_COMMAND', 'Pi command type is required.');
    switch (command.type) {
      case 'prompt': return this.#prompt(session, runtime, command);
      case 'get_state': {
        const state = runtime.getState();
        return reply(command, { ...(object(state) ? state : {}), inputContract: this.inputContract });
      }
      case 'get_messages': return reply(command, { messages: runtime.getMessages() });
      case 'abort': {
        const response = await runtime.command(command);
        return response;
      }
      default:
        if (!READ_COMMANDS.some(type => type === command.type)) throw new ManagerError('UNSUPPORTED_COMMAND', 'Pi command is not supported by this host.');
        return runtime.command(command);
    }
  }

  #prompt(session: StoredSession, runtime: ManagedPiSession, command: PiCommand): Response {
    const requestId = text(command.id, 'Request ID');
    const fingerprint = hash(canonical(command));
    const previous = this.#storage.receipt(session.id, requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new ManagerError('REQUEST_ID_CONFLICT', 'Request ID was already used for different input.');
      const response = previous.response;
      if (!object(response) || response.type !== 'response' || typeof response.command !== 'string' || typeof response.success !== 'boolean') {
        throw new ManagerError('INVALID_RECEIPT', 'Stored dispatch receipt is invalid.');
      }
      return { type: 'response', command: response.command, id: requestId, success: response.success,
        ...(response.data !== undefined ? { data: response.data } : {}), ...(typeof response.error === 'string' ? { error: response.error } : {}) };
    }
    if (this.#runs(session.id).some(run => pending(run.status))) throw new ManagerError('RUN_BUSY', 'The current run has not settled.');
    const message = this.#message(command, session);
    this.#validateModel(runtime, session.model ?? null);
    const run: Run = { id: randomUUID(), projectId: session.projectId, sessionId: session.id, requestId,
      taskId: randomUUID(), title: command.message && typeof command.message === 'string' ? command.message.slice(0, 120) : 'Research',
      status: 'queued', startedAt: null, endedAt: null, model: this.#model(runtime) };
    const response = reply(command, { accepted: true, runId: run.id, taskId: run.taskId });
    this.#commit(() => {
      this.#storage.putRecord('run', run);
      this.#storage.putRecord('task', { id: run.taskId, projectId: run.projectId, sessionId: run.sessionId, runId: run.id,
        title: run.title, status: 'queued', dependencies: [], toolIds: [], artifactIds: [] } satisfies Task);
      this.#storage.putReceipt({ sessionId: session.id, requestId, fingerprint, state: 'accepted', response });
      this.#event(run, 'dispatch_accepted', 'Prompt accepted for one Pi dispatch.');
    });
    // Acceptance is durable before the only provider dispatch. A crash in between is uncertain, never retried.
    void this.#execute(runtime, run, message);
    return response;
  }

  async #execute(runtime: ManagedPiSession, run: Run, message: string): Promise<void> {
    try {
      await runtime.prompt(message);
      if (this.#closed) return;
      // A handled extension command may finish without an agent run; do not invent success.
      const current = this.#storage.record<Run>('run', run.id);
      if (current && current.status === 'queued') {
        this.#commit(() => this.#finish(current, 'paused', 'Pi returned without starting an agent run.'));
      }
    } catch (error) {
      if (!this.#closed) {
        const current = this.#storage.record<Run>('run', run.id);
        if (current) this.#commit(() => this.#finish(current, 'failed', error instanceof Error ? error.message : 'Pi execution failed.'));
      }
    }
  }

  #event(run: Run, type: string, summary: string, toolId?: string): WorkspaceEvent {
    const event: WorkspaceEvent = { id: randomUUID(), projectId: run.projectId, sessionId: run.sessionId,
      runId: run.id, taskId: run.taskId, type, at: Date.now(), summary, ...(toolId ? { toolId } : {}) };
    this.#storage.putRecord('event', event);
    return event;
  }
  #finish(run: Run, status: Status, error?: string): void {
    this.#storage.putRecord('run', { ...run, status, endedAt: Date.now(), ...(error ? { error } : {}) });
    const task = this.#storage.record<Task>('task', run.taskId);
    if (task) this.#storage.putRecord('task', { ...task, status });
    for (const tool of this.#storage.records<Tool>('tool', run.sessionId)) {
      if (tool.runId === run.id && pending(tool.status)) this.#storage.putRecord('tool', { ...tool, status: status === 'succeeded' ? 'failed' : status });
    }
    const receipt = this.#storage.receipt(run.sessionId, run.requestId);
    if (receipt) this.#storage.putReceipt({
      ...receipt, state: status === 'paused' ? 'interrupted' : status === 'succeeded' ? 'completed' : 'failed',
      response: status === 'succeeded' ? receipt.response : {
        type: 'response', command: 'prompt', id: run.requestId, success: false,
        error: error ?? `Run ${status}.`, data: { runId: run.id, taskId: run.taskId, status },
      },
    });
    this.#event(run, status === 'paused' ? 'interrupted' : `run_${status}`, error ?? `Run ${status}.`);
  }
  #interrupt(sessionId: string, reason: string): void {
    for (const run of this.#runs(sessionId)) if (pending(run.status)) this.#finish(run, 'paused', reason);
  }

  #receive(sessionId: string, event: PiEvent): void {
    const run = this.#currentRun(sessionId);
    const session = this.#session(sessionId);
    const semantic = SNAPSHOT_EVENTS.has(event.type);
    this.#storage.transaction(() => {
      this.#storage.putRecord('pi_event', { id: randomUUID(), projectId: session.projectId, sessionId,
        runId: run?.id ?? null, at: Date.now(), event });
      if (!semantic) return;
      this.#storage.advanceRevision();
      if (!run || !pending(run.status)) return;
      switch (event.type) {
        case 'agent_start': {
          this.#storage.putRecord('run', { ...run, status: 'running', startedAt: run.startedAt ?? Date.now() });
          const task = this.#storage.record<Task>('task', run.taskId);
          if (task) this.#storage.putRecord('task', { ...task, status: 'running' });
          break;
        }
        case 'message_end': {
          if (object(event.message) && event.message.role === 'assistant') {
            const stop = event.message.stopReason;
            this.#storage.putRecord('run', { ...run, error: stop === 'error' ? String(event.message.errorMessage ?? 'Assistant failed.') : undefined });
          }
          break;
        }
        case 'auto_retry_end':
          if (event.success === false) this.#storage.putRecord('run', { ...run, error: String(event.finalError ?? 'Retry failed.') });
          break;
        case 'agent_settled':
          this.#finish(run, event.aborted === true ? 'cancelled' : run.error ? 'failed' : run.startedAt === null ? 'paused' : 'succeeded', run.error);
          break;
        case 'tool_execution_start':
        case 'tool_execution_end': this.#tool(run, event); break;
      }
      this.#event(run, event.type, event.type);
    });
    // Tool IDs remain identical in the chat projection and manager snapshot.
    const forwarded = { ...event };
    if (run) {
      if (typeof event.toolCallId === 'string') forwarded.toolCallId = this.#toolId(run, event.toolCallId);
      const update = event.assistantMessageEvent;
      if (object(update) && typeof update.type === 'string' && update.type.startsWith('toolcall_')) {
        const normalize = (part: unknown) => object(part) && part.type === 'toolCall' && typeof part.id === 'string'
          ? { ...part, id: this.#toolId(run, part.id) } : part;
        forwarded.assistantMessageEvent = { ...update,
          ...(typeof update.id === 'string' ? { id: this.#toolId(run, update.id) } : {}),
          ...(update.toolCall ? { toolCall: normalize(update.toolCall) } : {}),
          ...(object(update.partial) && Array.isArray(update.partial.content)
            ? { partial: { ...update.partial, content: update.partial.content.map(normalize) } } : {}) };
      }
    }
    for (const listener of this.#piListeners) listener(sessionId, structuredClone(forwarded));
    if (semantic) this.#publish();
  }

  #toolId(run: Run, rawId: string): string { return `tool-${hash(`${run.id}:${rawId}`).slice(0, 32)}`; }
  #tool(run: Run, event: PiEvent): void {
    if (typeof event.toolCallId !== 'string') return;
    const id = this.#toolId(run, event.toolCallId);
    const previous = this.#storage.record<Tool>('tool', id);
    const result = event.result ?? event.partialResult;
    const output = object(result) && Array.isArray(result.content)
      ? result.content.filter(object).filter(item => item.type === 'text').map(item => String(item.text ?? '')).join('\n') : '';
    const name = typeof event.toolName === 'string' ? event.toolName : previous?.name ?? 'tool';
    const tool: Tool = { ...previous, id, projectId: run.projectId, sessionId: run.sessionId, runId: run.id, taskId: run.taskId,
      name, sdkToolName: name, args: event.args ?? previous?.args, cwd: this.#projectDir(run.projectId),
      status: event.type === 'tool_execution_end' ? event.isError === true ? 'failed' : 'succeeded' : 'running',
      logs: output ? [...(previous?.logs ?? []), { at: Date.now(), text: output }] : previous?.logs ?? [] };
    this.#storage.putRecord('tool', tool);
    const task = this.#storage.record<Task>('task', run.taskId);
    if (task && !task.toolIds.includes(id)) this.#storage.putRecord('task', { ...task, toolIds: [...task.toolIds, id] });
  }

  async cancelRun(runId: string): Promise<unknown> {
    this.#assertReady();
    const run = this.#active ? this.#currentRun(this.#active) : undefined;
    if (!run || run.id !== runId || !pending(run.status)) throw new ManagerError('RUN_NOT_ACTIVE', 'Run is not active.');
    return this.pi(run.sessionId, { type: 'abort', id: randomUUID() });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribe?.();
    const state = this.#runtime?.getState();
    if (object(state) && (state.isStreaming === true || state.isIdle === false)) {
      await this.#runtime?.command({ type: 'abort', id: randomUUID() });
    }
    this.#runtime?.close();
    this.#storage.transaction(() => {
      for (const session of this.#storage.sessions()) this.#interrupt(session.id, 'Host closed before execution settled.');
      this.#storage.advanceRevision();
    });
    this.#listeners.clear();
    this.#piListeners.clear();
    this.#storage.close();
  }
}
