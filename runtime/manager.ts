import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Storage } from './storage.ts';
import type { StoredSession } from './storage.ts';
import type { AthenaTaskManager, ModelReference, Project, SessionActivation, Status, Task, Tool, WorkspaceEvent, WorkspaceSnapshot, Agent } from '../athena-backend-handoff/athena-codex-ui/integrations/task-manager.d.ts';
import type { FileReference } from '../athena-backend-handoff/athena-codex-ui/integrations/pi-bridge-contracts.d.ts';
import type { PiOrchestration } from './agent-tools.ts';
import type { PiModelSelection, PiSessionOptions } from './pi.ts';
import { CsvJobRunner, ANALYSIS_LIMITS, CSV_LIMITS } from './jobs.ts';
import { AnalysisFiles, ANALYSIS_FILE_LIMITS, validateAnalysisName, validateOutputNames } from './analysis-files.ts';
import type { AnalysisSnapshot } from './analysis-files.ts';
import type { CsvJobEvent } from './jobs.ts';
import { ManagerError, object, text, hash, pending, limit, TurnScheduler, artifactRef, executionProjects } from './orchestration.ts';
import type { AgentSession, Context, TaskRow, Attempt, ProcessRow, ArtifactRow } from './orchestration.ts';
import { Journal, context, toolId, normalizeEvent } from './orchestration-journal.ts';
import { projectHistory } from './history.ts';
import type { HistoryEvent } from './history.ts';
export { ManagerError } from './orchestration.ts';
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
export type PiSessionFactory = (options: PiSessionOptions) => Promise<ManagedPiSession>;
type ModelResolver = {
  resolve(conversation: string | null | undefined, project: string | null | undefined): ModelReference | null;
  pin(model: ModelReference): Promise<PiModelSelection>;
  requireProfile(id: string): void;
};
export type TaskManagerOptions = { readonly dataDir: string; readonly createPiSession?: PiSessionFactory; readonly models?: ModelResolver };
export type Run = {
  readonly id: string; readonly projectId: string; readonly sessionId: string;
  readonly requestId: string; readonly taskId: string; readonly title: string;
  readonly status: Status; readonly startedAt: number | null; readonly endedAt: number | null;
  readonly model: ModelReference | null; readonly error?: string;
  readonly cancellationRequested?: boolean;
};
type StoredFile = FileReference & {
  readonly projectId: string; readonly sessionId: string; readonly path: string; readonly digest: string;
};
type Response = {
  readonly type: 'response'; readonly command: string; readonly id?: string;
  readonly success: boolean; readonly data?: unknown; readonly error?: string;
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().filter(key => value[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function reply(command: PiCommand, data: unknown): Response {
  return { type: 'response', command: command.type, ...(command.id ? { id: command.id } : {}), success: true, data };
}
const READ_COMMANDS = ['get_state', 'get_messages', 'get_available_models', 'get_entries', 'get_tools', 'get_session_stats', 'get_available_thinking_levels'] as const;
const SNAPSHOT_EVENTS = new Set([
  'agent_start', 'agent_end', 'agent_settled', 'message_end', 'auto_retry_start', 'auto_retry_end',
  'tool_execution_start', 'tool_execution_end', 'compaction_start', 'compaction_end',
]);

type Accepted = { readonly taskId: string; readonly parentTaskId: string | null; readonly agentSessionId: string; readonly attemptId: string; readonly status: Status };
type Dispatch = { readonly id: string; readonly projectId: string; readonly sessionId: string; readonly runId: string; readonly taskId: string; readonly fingerprint: string; readonly response?: Accepted };
type Live = { runtime: ManagedPiSession; controller: AbortController; attempt: Attempt; finished: Promise<void> };

export class TaskManager implements AthenaTaskManager {
  readonly capabilities: AthenaTaskManager['capabilities'] = ['create_project', 'create_session', 'open_session', 'set_project_model', 'cancel_run', 'cancel_task', 'get_agent_history'];
  readonly inputContract = {
    maxMessageCharacters: 262144, lengthUnit: 'utf16-code-units',
    supportsFileReferences: true, canStageFiles: true,
  } as const;
  readonly #storage: Storage;
  readonly #directory: string;
  readonly #factory: PiSessionFactory;
  readonly #models: ModelResolver | undefined;
  readonly #pins = new Map<string, PiModelSelection>();
  readonly #runtimeModels = new WeakMap<ManagedPiSession, ModelReference>();
  readonly #listeners = new Set<(snapshot: WorkspaceSnapshot) => void>();
  readonly #piListeners = new Set<(sessionId: string, event: PiEvent) => void>();
  readonly #journal: Journal;
  readonly #jobs: CsvJobRunner;
  readonly #files: AnalysisFiles;
  readonly #enabledProjects = executionProjects();
  readonly #concurrency = limit('ATHENA_PROCESS_CONCURRENCY', 1, 1, 4);
  #access: Awaited<ReturnType<CsvJobRunner['analysisAccess']>> = {available:false,reason:'No project enabled by host.'};
  readonly #timeoutMs = 5000;
  readonly #registry = new Map<string, ManagedPiSession>();
  readonly #loading = new Map<string, Promise<ManagedPiSession>>();
  readonly #turns = new Map<string, Live>();
  readonly #executing = new Map<string, Attempt>();
  readonly #waiters = new Set<() => void>();
  readonly #modelConcurrency = limit('ATHENA_MODEL_CONCURRENCY', 2, 1, 64);
  readonly #scheduler = new TurnScheduler(this.#modelConcurrency);
  readonly #maxChildren = limit('ATHENA_MAX_CHILDREN', 8, 0, 128);
  readonly #depth = limit('ATHENA_MAX_DEPTH', 1, 0, 1);
  #active: string | null = null;
  #busy = false;
  #ready = false;
  #closed = false;

  constructor(options: TaskManagerOptions) {
    this.#directory = options.dataDir;
    this.#models = options.models;
    this.#storage = new Storage(options.dataDir);
    this.#journal = new Journal(this.#storage);
    this.#files = new AnalysisFiles(options.dataDir);
    this.#jobs = new CsvJobRunner({dataDir: options.dataDir, concurrency: this.#concurrency, timeoutMs:this.#timeoutMs,
      recoveredAttempts: this.#storage.sessions().flatMap(s => this.#storage.records<ProcessRow>('process', s.id).map(p => p.job)),
      onEvent: event => this.#processEvent(event) });
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
      this.#active = this.#storage.get<string | null>('activeSession') ?? null;
      if (this.#enabledProjects.size) this.#access = await this.#jobs.analysisAccess();
      if (this.#active) await this.#openRoot(this.#session(this.#active));
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
  #bound(id: string) {
    this.#assertReady();
    const runtime = this.#registry.get(id);
    if (this.#busy || id !== this.#active || !runtime) throw new ManagerError('SESSION_MISMATCH', 'Request is not bound to the selected Pi session.');
    return {session:this.#session(id),runtime};
  }
  #projectDir(projectId:string) { return join(this.#directory, 'projects', projectId); }
  async #make(projectId:string, sessionDir:string, role:PiOrchestration['role'], sessionFile?:string, selection?:PiModelSelection) {
    let runtime: ManagedPiSession;
    // Pi may execute tools from a single model response concurrently. Bind each call at entry,
    // and serialize its manager effects (including spawn then join) in SDK call order.
    let chain = Promise.resolve();
    runtime = await this.#factory({projectDir:this.#projectDir(projectId), sessionDir, sessionFile, selection, orchestration:{role,
      executionEnabled:this.#enabledProjects.has(projectId),
      execute:(name,raw,args,signal) => {
        const a = this.#executing.get(runtime.sessionId);
        if (!a) throw new ManagerError('ATTEMPT_INACTIVE','No dispatched attempt owns this tool.');
        const work = chain.then(() => this.#operation(a,name,raw,args,signal));
        chain = work.then(()=>{},()=>{}); return work;
      }}});
    if (this.#closed || this.#registry.has(runtime.sessionId)) {
      runtime.close(); throw new ManagerError('SESSION_UNAVAILABLE','Manager closed or duplicate Pi identity.');
    }
    this.#registry.set(runtime.sessionId,runtime); return runtime;
  }
  #load(s: AgentSession): Promise<ManagedPiSession> {
    const runtime = this.#registry.get(s.id); if (runtime) return Promise.resolve(runtime);
    const loading = this.#loading.get(s.id); if (loading) return loading;
    const promise = this.#make(s.projectId,s.sessionDir,s.role,s.sessionFile).then(value => {
      if (value.sessionId !== s.id) { this.#registry.delete(value.sessionId); value.close(); throw new ManagerError('SESSION_ID_MISMATCH','Unexpected Pi identity.'); }
      return value;
    }).finally(()=>this.#loading.delete(s.id));
    this.#loading.set(s.id,promise); return promise;
  }
  #openRoot(s: StoredSession) { return this.#load({...s,sessionId:s.id,role:'parent'}); }
  hasPendingRuns(): boolean {
    return this.#busy || this.#storage.sessions().some(s => this.#runs(s.id).some(r => pending(r.status)));
  }
  profileInUse(id: string): boolean {
    return this.#storage.projects().some(p => p.defaultProfileId === id) || this.#storage.sessions().some(s => s.profileId === id);
  }

  setProjectProfile(projectId: string, id: string | null) {
    this.#assertReady();
    const project = this.#storage.project(projectId);
    if (!project) throw new ManagerError('PROJECT_NOT_FOUND', 'Project does not exist.');
    if (id !== null) this.#models?.requireProfile(id);
    this.#commit(() => this.#storage.putProject({ ...project, defaultProfileId: id }));
    return this.getSnapshot();
  }

  setConversationProfile(sessionId: string, id: string | null) {
    this.#assertReady();
    const session = this.#session(sessionId);
    if (id !== null) this.#models?.requireProfile(id);
    this.#commit(() => this.#storage.putSession({ ...session, profileId: id }));
    return this.getSnapshot();
  }
  #runs(sessionId: string): Run[] { return this.#storage.records<Run>('run', sessionId); }
  #currentRun(sessionId: string): Run | undefined { return this.#runs(sessionId).at(-1); }

  getSnapshot() {
    this.#assertReady();
    const session = this.#active ? this.#session(this.#active) : undefined;
    const run = session ? this.#currentRun(session.id) : undefined;
    const projectId = session?.projectId ?? this.#storage.get<string | null>('activeProject') ?? null;
    return structuredClone({
      revision: this.#storage.revision(), projectId, sessionId: session?.id ?? null,
      execution: {projectId, enabled:projectId!==null && this.#enabledProjects.has(projectId), backend:'docker' as const,
        shell:false as const, network:false as const, runtime:this.#access,
        limits:{...ANALYSIS_FILE_LIMITS,...ANALYSIS_LIMITS,queue:CSV_LIMITS.queue,timeoutMs:this.#timeoutMs,concurrency:this.#concurrency,modelConcurrency:this.#modelConcurrency,maxDepth:this.#depth,maxChildren:this.#maxChildren}},
      projects: this.#storage.projects(),
      sessions: this.#storage.sessions().map(({ sessionFile: _file, sessionDir: _dir, ...metadata }) => metadata),
      run: { id: run?.id ?? null, status: run?.status ?? 'ready', startedAt: run?.startedAt ?? null,
        elapsedMs: run?.startedAt ? (run.endedAt ?? Date.now()) - run.startedAt : 0, model: run?.model ?? session?.model ?? null },
      tasks: session ? this.#storage.records<TaskRow>('task', session.id) : [],
      attempts: session ? this.#storage.records<Attempt>('attempt', session.id) : [],
      processes: session ? this.#storage.records<ProcessRow>('process', session.id) : [],
      agents: session ? this.#storage.records<Agent>('agent', session.id) : [], tools: session ? this.#storage.records<Tool>('tool', session.id) : [],
      artifacts: session ? this.#storage.records<ArtifactRow>('artifact', session.id).map(row=>({...row,location:{uri:artifactRef(row.file).uri,label:row.title}})) : [], events: session ? this.#storage.records<WorkspaceEvent>('event', session.id) : [], approvals: [],
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
    for (const check of this.#waiters) check();
    if (!this.#ready || this.#closed) return;
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
      runtime = await this.#make(projectId,sessionDir,'parent');
      const id = runtime.sessionId;
      const model = input.model ?? project.defaultModel ?? this.#model(runtime);
      this.#validateModel(runtime, model);
      const session: StoredSession = { id, projectId, title, model, sessionFile: runtime.sessionFile, sessionDir };
      this.#storage.transaction(() => {
        this.#storage.putSession(session);
        this.#storage.putRecord('agent_session',{...session,sessionId:id,role:'parent'});
        this.#storage.set('activeSession', id);
        this.#storage.set('activeProject', projectId);
        this.#storage.advanceRevision();
      });
      this.#active = id;
      runtime = undefined;
    } finally {
      if (runtime) { this.#registry.delete(runtime.sessionId); runtime.close(); }
      this.#busy = false;
    }
    this.#publish();
    const snapshot = this.getSnapshot();
    return { sessionId: text(snapshot.sessionId, 'Created session ID'), projectId, title, snapshot };
  }

  async openSession(sessionId: string): Promise<SessionActivation> {
    this.#assertReady();
    if (this.#busy) throw new ManagerError('SESSION_BUSY','Another selection is in progress.');
    const session = this.#session(sessionId);
    if (this.#active !== sessionId) {
      this.#busy = true;
      try {
        await this.#openRoot(session);
        this.#active = session.id;
        this.#commit(()=>{this.#storage.set('activeSession',sessionId);this.#storage.set('activeProject',session.projectId);});
      } finally { this.#busy = false; }
    }
    return {sessionId, projectId:session.projectId,title:session.title,snapshot:this.getSnapshot()};
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
    const state = runtime.getState();
    const level = object(state) ? state.thinkingLevel ?? 'off' : 'off';
    if (requested && (!actual || requested.provider !== actual.provider || requested.modelId !== actual.modelId ||
        (requested.thinkingLevel != null && requested.thinkingLevel !== level))) {
      throw new ManagerError('MODEL_UNAVAILABLE', 'This host cannot use the requested model or thinking level.');
    }
  }
  async setProjectDefaultModel(projectId: string, model: ModelReference | null) {
    this.#assertReady();
    const project = this.#storage.project(projectId);
    if (!project) throw new ManagerError('PROJECT_NOT_FOUND', 'Project does not exist.');
    if (model) {
      const runtime = this.#active ? this.#registry.get(this.#active) : undefined;
      if (!runtime) throw new ManagerError('MODEL_UNAVAILABLE', 'Open a session before selecting its supported model.');
      this.#validateModel(runtime, model);
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
        message += `\n\nInput attachment (never a result): ${JSON.stringify({fileId:stored.id,name:stored.name})}. ` +
          `Children receive this input by fileId. Only report output locations returned in verified artifact references.\nFor direct input inspection only: ` +
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
      case 'get_messages': return reply(command, { messages: this.#history(session, runtime) });
      case 'abort': {
        const run = this.#currentRun(sessionId);
        if (run && pending(run.status)) { await this.cancelRun(run.id); return reply(command,{runId:run.id}); }
        const response = await runtime.command(command);
        return response;
      }
      default:
        if (!READ_COMMANDS.some(type => type === command.type)) throw new ManagerError('UNSUPPORTED_COMMAND', 'Pi command is not supported by this host.');
        return runtime.command(command);
    }
  }

  async #prompt(session: StoredSession, runtime: ManagedPiSession, command: PiCommand): Promise<Response> {
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
    const selection = this.#models?.resolve(session.profileId, this.#storage.project(session.projectId)?.defaultProfileId) ?? null;
    let pin: PiModelSelection | undefined;
    if (selection && this.#models) {
      this.#busy = true;
      try {
        pin = await this.#models.pin(selection);
        // The public profile revision need not change when its credential is rotated.
        // Reopen the same conversation with this run's freshly resolved runtime every time.
        {
          runtime.close();
          this.#registry.delete(runtime.sessionId);
          try {
            runtime = await this.#make(session.projectId, session.sessionDir, 'parent', session.sessionFile, pin);
            if (runtime.sessionId !== session.id) {
              this.#registry.delete(runtime.sessionId);
              runtime.close();
              throw new ManagerError('SESSION_ID_MISMATCH', 'The selected model did not reopen the same Pi conversation.');
            }
            this.#runtimeModels.set(runtime, selection);
          } catch (error) {
            if (!this.#closed) await this.#openRoot(session);
            throw error;
          }
        }
        this.#validateModel(runtime, selection);
      } finally { this.#busy = false; }
    } else if (this.#runtimeModels.has(runtime)) {
      this.#busy = true;
      try {
        runtime.close(); this.#registry.delete(runtime.sessionId);
        runtime = await this.#openRoot(session);
      } finally { this.#busy = false; }
    } else this.#validateModel(runtime, session.model ?? null);
    const run: Run = { id: randomUUID(), projectId: session.projectId, sessionId: session.id, requestId,
      taskId: randomUUID(), title: command.message && typeof command.message === 'string' ? command.message.slice(0, 120) : 'Research',
      status: 'queued', startedAt: null, endedAt: null, model: selection ?? this.#model(runtime) };
    const fileIds=Array.isArray(command.fileReferences)?command.fileReferences.filter(object).map(ref=>text(ref.id,'File ID')):[];
    const a=this.#attempt({projectId:session.projectId,sessionId:session.id,runId:run.id,taskId:run.taskId,
      parentTaskId:null,agentSessionId:runtime.sessionId},requestId,message,fileIds,selection ?? undefined);
    const response=reply(command,{accepted:true,...context(a)});
    this.#commit(()=>{
      this.#storage.putRecord('run',{...run,agentSessionId:a.agentSessionId,attemptId:a.id});
      this.#journal.accept(a,run.title);
      this.#storage.putReceipt({sessionId:session.id,requestId,fingerprint,state:'accepted',response});
    });
    if (pin) this.#pins.set(run.id, pin);
    this.#schedule(a,runtime);
    return response;
  }
  #attempt(owner:Omit<Context,'attemptId'>,requestId:string,prompt:string,fileIds:readonly string[], model?:ModelReference):Attempt {
    const id=randomUUID();
    return {...owner,id,attemptId:id,requestId,prompt,fileIds,status:'queued',acceptedAt:Date.now(),startedAt:null,endedAt:null,...(model?{model}:{})};
  }
  #schedule(a:Attempt,runtime:ManagedPiSession) {
    const controller=new AbortController();
    const finished=this.#execute(a,runtime,controller.signal);
    this.#turns.set(a.id,{controller,runtime,attempt:a,finished});
  }
  async #execute(a:Attempt,runtime:ManagedPiSession,signal:AbortSignal) {
    let unsubscribe:(()=>void)|undefined;
    try {
      await this.#scheduler.acquire(a,signal);
      signal.throwIfAborted();
      this.#executing.set(a.agentSessionId,a);
      unsubscribe=runtime.subscribe(event=>{
        if(this.#closed || this.#executing.get(a.agentSessionId)!==a)return;
        const semantic=SNAPSHOT_EVENTS.has(event.type);
        this.#storage.transaction(()=>{
          this.#journal.receive(a,event,signal.aborted);
          if(semantic){this.#journal.event(a,event.type,event.type,typeof event.toolCallId==='string'?{toolId:toolId(a,event.toolCallId)}:{});this.#storage.advanceRevision();}
        });
        const normalized=normalizeEvent(a,event);
        for(const listener of this.#piListeners)listener(a.agentSessionId,structuredClone(normalized));
        if(semantic)this.#publish();
      });
      await runtime.prompt(a.prompt);
      if(!this.#closed && pending(this.#storage.record<Attempt>('attempt',a.id)?.status??'ready'))
        this.#commit(()=>this.#journal.transition(a,signal.aborted?'cancelled':'paused','Pi returned without settling the attempt.'));
    }catch(error){
      if(!this.#closed)this.#commit(()=>this.#journal.transition(a,signal.aborted?'cancelled':'failed',error instanceof Error?error.message:'Pi failed.'));
    }finally{
      unsubscribe?.();
      if(this.#executing.get(a.agentSessionId)===a)this.#executing.delete(a.agentSessionId);
      this.#scheduler.release(a);this.#turns.delete(a.id);
      if (!this.#closed && !pending(this.#storage.record<Run>('run',a.runId)?.status ?? 'ready')) this.#pins.delete(a.runId);
    }
  }
  #children(a:Context) {return this.#storage.records<TaskRow>('task',a.sessionId).filter(t=>t.runId===a.runId && t.parentTaskId===a.taskId);}
  #child(a:Context,id:unknown) {
    const task=this.#storage.record<TaskRow>('task',text(id,'Task ID'));
    if(!task || task.sessionId!==a.sessionId || task.runId!==a.runId || task.parentTaskId!==a.taskId)
      throw new ManagerError('TASK_SCOPE_MISMATCH','This is not a direct child of the calling task.');
    return task;
  }
  async #summary(t:TaskRow) {
    const artifacts=[];
    for(const id of t.artifactIds) {
      const row=this.#storage.record<ArtifactRow>('artifact',id);
      if(!row || row.projectId!==t.projectId || row.sessionId!==t.sessionId || row.runId!==t.runId || row.taskId!==t.id)
        throw new ManagerError('ARTIFACT_DENIED','Task artifact linkage is inconsistent.');
      await this.#readArtifact(row);
      artifacts.push(artifactRef(row.file));
    }
    return {taskId:t.id,parentTaskId:t.parentTaskId,agentSessionId:t.agentSessionId,attemptId:t.attemptId,
      title:t.title,status:t.status,result:t.result??null,error:t.error,artifactIds:t.artifactIds,artifacts};
  }
  async #operation(a:Attempt,name:string,raw:string,args:Readonly<Record<string,unknown>>,sdkSignal?:AbortSignal):Promise<unknown> {
    const turn=this.#turns.get(a.id);
    if(!turn || this.#executing.get(a.agentSessionId)!==a || this.#closed)throw new ManagerError('ATTEMPT_INACTIVE','This attempt is no longer active.');
    const signal=sdkSignal?AbortSignal.any([sdkSignal,turn.controller.signal]):turn.controller.signal;
    signal.throwIfAborted();
    if(a.parentTaskId)return this.#childTool(a,name,raw,args,signal);
    switch(name){
      case 'read':{
        this.#requireEnabled(a);
        const path=text(args.path,'Granted path');
        const id=a.fileIds.find(id=>path==='uploads/'+id+'.txt');
        if(!id)throw new ManagerError('GRANT_DENIED','Path is not an input attached to this turn.');
        return this.#upload(a,id).bytes.toString('utf8');
      }
      case 'spawn_agent':case 'send_to_agent':return this.#dispatch(a,name,raw,args,signal);
      case 'get_task':return this.#summary(this.#child(a,args.taskId));
      case 'list_tasks':return {tasks:await Promise.all(this.#children(a).map(t=>this.#summary(t)))};
      case 'read_file':{
        this.#requireEnabled(a);
        if(Object.keys(args).length!==1)throw new ManagerError('INVALID_INPUT','Supply only an artifactId.');
        const row=this.#artifact(a,args.artifactId);
        return {artifact:artifactRef(row.file),content:(await this.#readArtifact(row)).toString('utf8')};
      }
      case 'wait_for_agents':return this.#wait(a,args.taskIds,signal);
      case 'cancel_task':{
        const child=this.#child(a,args.taskId);
        await this.#cancel(child);
        return this.#summary(this.#child(a,child.id));
      }
      default:throw new ManagerError('TOOL_DENIED','Tool is not available to this agent.');
    }
  }
  async #dispatch(a:Attempt,name:'spawn_agent'|'send_to_agent',raw:string,args:Readonly<Record<string,unknown>>,signal:AbortSignal):Promise<Accepted>{
    const requestId=text(args.requestId??raw,'Request ID');
    const id=hash(canonical([a.sessionId,a.runId,a.taskId,name,requestId]));
    const kind=name==='spawn_agent'?'spawn':'send';
    const fingerprint=hash(canonical(args));
    const existing=this.#storage.record<Dispatch>(kind,id);
    if(existing){
      if(existing.fingerprint!==fingerprint)throw new ManagerError('REQUEST_ID_CONFLICT','Request ID already has different arguments.');
      if(existing.response)return existing.response;
      throw new ManagerError('DISPATCH_INTERRUPTED','This reservation will not be dispatched again.');
    }
    const child=kind==='send'?this.#child(a,args.taskId):undefined;
    const previous=child?this.#storage.records<Attempt>('attempt',a.sessionId).filter(t=>t.taskId===child.id).at(-1):undefined;
    const select=(arg:unknown,fallback:readonly string[])=>{
      if(arg===undefined)return fallback;
      if(!Array.isArray(arg)||arg.length>32||new Set(arg).size!==arg.length||!arg.every((id:unknown):id is string=>typeof id==='string' && id.length>0))
        throw new ManagerError('INVALID_INPUT','Grants must be a bounded list of distinct IDs.');
      return arg;
    };
    const fileIds=select(args.fileIds,previous?.fileIds??a.fileIds);
    if(fileIds.some(id=>!a.fileIds.includes(id)))throw new ManagerError('GRANT_DENIED','Cannot transfer an input outside the parent grants.');
    const artifactGrants=select(args.artifactIds,previous?.artifactGrants??[]);
    const transfers=[];
    if(artifactGrants.length)this.#requireEnabled(a);
    for(const id of artifactGrants){const row=this.#artifact(a,id);await this.#readArtifact(row);transfers.push(artifactRef(row.file));}
    if(child && (child.status==='cancelled'||child.status==='paused'))throw new ManagerError('TASK_CLOSED','Cannot send to a cancelled or interrupted task.');
    if(!child && (this.#depth===0||this.#children(a).length>=this.#maxChildren))throw new ManagerError('CHILD_LIMIT','Direct child limit reached.');
    const taskId=child?.id??randomUUID();
    const title=child?.title??text(args.title,'Child title');
    const message=text(child?args.message:args.prompt,'Child message');
    if(message.length>32768)throw new ManagerError('INPUT_TOO_LARGE','Child message exceeds 32768 characters.');
    const reservation:Dispatch={...context(a),id,taskId,fingerprint};
    this.#commit(()=>this.#storage.putRecord(kind,reservation));
    const sessionDir=join(this.#directory,'agents',randomUUID());
    const runtime=child?this.#registry.get(child.agentSessionId):await this.#make(a.projectId,sessionDir,'child',undefined,this.#pins.get(a.runId));
    if(!runtime)throw new ManagerError('SESSION_UNAVAILABLE','Child Pi session unavailable.');
    if(a.model)this.#validateModel(runtime,a.model);
    signal.throwIfAborted();
    const grantInfo=fileIds.map(id=>({fileId:id,name:this.#storage.record<StoredFile>('file',id)?.name}));
    const prompt=message+'\nGranted input files: '+JSON.stringify(grantInfo)+(transfers.length?'\nGranted result artifacts: '+JSON.stringify(transfers):'');
    const next={...this.#attempt({...context(a),taskId,parentTaskId:a.taskId,agentSessionId:runtime.sessionId},requestId,prompt,fileIds,a.model),artifactGrants};
    const response={taskId,parentTaskId:a.taskId,agentSessionId:runtime.sessionId,attemptId:next.id,status:next.status};
    this.#commit(()=>{
      if(!child)this.#storage.putRecord('agent_session',{projectId:a.projectId,sessionId:a.sessionId,id:runtime.sessionId,
        role:'child',sessionDir,sessionFile:runtime.sessionFile,...(a.model?{model:a.model}:{})} satisfies AgentSession);
      this.#journal.accept(next,title);
      this.#storage.putRecord(kind,{...reservation,response});
      this.#journal.event(next,child?'send_queued':'child_spawned',title);
    });
    this.#schedule(next,runtime);
    return response;
  }
  async #wait(a:Attempt,list:unknown,signal:AbortSignal) {
    if(list!==undefined && !Array.isArray(list))throw new ManagerError('INVALID_INPUT','taskIds must be an array.');
    const tasks=Array.isArray(list)?list.map(id=>this.#child(a,id)):this.#children(a);
    const current=()=>tasks.map(t=>this.#child(a,t.id));
    if(tasks.some(t=>pending(t.status))) {
      this.#commit(()=>{this.#journal.transition(a,'blocked');this.#journal.event(a,'wait_started','Waiting for '+tasks.length+' child tasks.');});
      this.#scheduler.release(a,true);
      try {
        await new Promise<void>((resolve,reject)=>{
          const clear=()=>{this.#waiters.delete(check);signal.removeEventListener('abort',abort);};
          const abort=()=>{clear();reject(signal.reason);};
          const check=()=>{if(!current().some(t=>pending(t.status))){clear();resolve();}};
          signal.throwIfAborted();
          this.#waiters.add(check);signal.addEventListener('abort',abort,{once:true});check();
        });
      }finally{
        if(!signal.aborted){await this.#scheduler.acquire(a,signal);
          this.#commit(()=>{this.#journal.transition(a,'running');this.#journal.event(a,'wait_completed','Child tasks settled; model slot reacquired.');});}
      }
    }
    const joined=await Promise.all(current().map(t=>this.#summary(t)));
    if(!this.#enabledProjects.has(a.projectId))return {tasks:joined};
    // Supply exact read arguments for published data files; never mark them as read here.
    const inspect=joined.flatMap(t=>t.artifacts.filter(f=>/\.(json|csv)$/i.test(f.name)).map(f=>({
      name:f.name,tool:'read_file',arguments:{artifactId:f.id}
    })));
    return {tasks:joined,...(inspect.length ? {nextStep:'Call read_file for these outputs before answering. Check their contents against the request.',inspect} : {})};
  }
  #upload(a:Attempt,selected:unknown) {
    const id=selected===undefined && a.fileIds.length===1?a.fileIds[0]:selected;
    if(typeof id!=='string' || !a.fileIds.includes(id))throw new ManagerError('GRANT_DENIED','Choose one of the explicitly granted file IDs.');
    const f=this.#storage.record<StoredFile>('file',id);
    if(!f || f.sessionId!==a.sessionId || f.projectId!==a.projectId)throw new ManagerError('GRANT_DENIED','File is outside this conversation.');
    const bytes=readFileSync(f.path);
    if(hash(bytes)!==f.digest)throw new ManagerError('FILE_CHANGED','Granted file bytes changed.');
    return {f,bytes};
  }
  #requireEnabled(a:Context) {
    if(!this.#enabledProjects.has(a.projectId))throw new ManagerError('EXECUTION_DISABLED','Offline execution is not enabled for this project.');
  }
  #artifact(a:Attempt,id:unknown) {
    const row=this.#storage.record<ArtifactRow>('artifact',text(id,'Artifact ID'));
    if(!row || row.projectId!==a.projectId || row.sessionId!==a.sessionId || row.runId!==a.runId ||
      (a.parentTaskId ? row.taskId!==a.taskId && !a.artifactGrants?.includes(row.id) : row.parentTaskId!==a.taskId))
      throw new ManagerError('ARTIFACT_DENIED','Artifact is outside the calling task grants.');
    return row;
  }
  async #readArtifact(row:ArtifactRow) {
    const f=row.file;
    if (f.id!==row.id || f.projectId!==row.projectId || f.sessionId!==row.sessionId || f.attemptId!==row.processId ||
      artifactRef(f).version!==row.version || ('taskId' in f && f.taskId!==row.taskId)) throw new ManagerError('ARTIFACT_DENIED','Inconsistent artifact ownership.');
    return 'kind' in f ? this.#files.download(f) : this.#jobs.download(f);
  }
  async #analysisInput(a:Attempt,ref:unknown):Promise<AnalysisSnapshot & {fileId?:string;versionId?:string}> {
    const name=validateAnalysisName(text(typeof ref==='string'?ref:object(ref)?ref.name:null,'Input name'));
    if(typeof ref==='string') {
      if(await this.#files.has(a,name)) {
        const [snapshot]=await this.#files.snapshot(a,[name]);
        if(!snapshot)throw new ManagerError('INVALID_INPUT','Private snapshot missing.');
        return snapshot;
      }
      const matches=a.fileIds.filter(id=>this.#storage.record<StoredFile>('file',id)?.name===name);
      if(matches.length!==1)throw new ManagerError('GRANT_DENIED','Input name is absent or ambiguous; specify an exact granted fileId.');
      const {f,bytes}=this.#upload(a,matches[0]);
      return {name,bytes,fileId:f.id,versionId:f.digest};
    }
    if(!object(ref) || Object.keys(ref).length!==2)throw new ManagerError('INVALID_INPUT','Choose exactly one input source.');
    if(typeof ref.fileId==='string') {
      const {f,bytes}=this.#upload(a,ref.fileId);
      return {name,bytes,fileId:f.id,versionId:f.digest};
    }
    const row=this.#artifact(a,ref.artifactId);
    return {name,bytes:await this.#readArtifact(row),fileId:row.id,versionId:row.version};
  }
  #requirePrivateNames(a:Attempt,names:readonly string[]) {
    const granted=new Set(a.fileIds.map(id=>this.#storage.record<StoredFile>('file',id)?.name.toLowerCase()));
    for(const name of names)if(granted.has(name.toLowerCase()))throw new ManagerError('GRANT_DENIED',
      `Granted upload ${name} is read-only. Put it in run_command.inputs and give outputs a different name.`);
  }
  async #analysis(a:Attempt,raw:string,args:Readonly<Record<string,unknown>>,signal:AbortSignal) {
    const {language,inputs,outputs,args:argv=[]}=args;
    if(Object.keys(args).some(k=>!['language','inputs','outputs','args','script'].includes(k)) ||
      (language!=='node' && language!=='python') || !Array.isArray(inputs) || inputs.length>ANALYSIS_FILE_LIMITS.batchFiles ||
      !Array.isArray(outputs) || !outputs.every((o:unknown)=>typeof o==='string') || !Array.isArray(argv) ||
      !argv.every((o:unknown)=>typeof o==='string'))throw new ManagerError('INVALID_INPUT','Invalid analysis command.');
    const declared=validateOutputNames(outputs);
    this.#requirePrivateNames(a,declared);
    const [script]=await this.#files.snapshot(a,[text(args.script,'Script name')]);
    if(!script)throw new ManagerError('INVALID_INPUT','A private script is required.');
    const snapshots=await Promise.all(inputs.map(i=>this.#analysisInput(a,i)));
    signal.throwIfAborted();
    const processId=randomUUID();
    const job=this.#jobs.startAnalysis({projectId:a.projectId,sessionId:a.sessionId,taskId:a.taskId,requestId:raw,attemptId:processId,
      toolId:toolId(a,raw),language,script,inputs:snapshots,outputs:declared,args:argv});
    const cancel=()=>job.cancel();signal.addEventListener('abort',cancel,{once:true});
    try {
      const result=await job.result;
      const diagnostics={processId,status:result.status,stdout:result.stdout,stderr:result.stderr,exitCode:result.exitCode};
      if(result.status!=='succeeded')throw new ManagerError('ANALYSIS_FAILED',JSON.stringify({...diagnostics,error:result.error??('Analysis '+result.status)}));
      if(!result.artifacts?.length)throw new ManagerError('ANALYSIS_FAILED','Successful analysis is missing artifact receipts.');
      const artifacts=[];
      for(const f of result.artifacts){const row=this.#artifact(a,f.id);await this.#readArtifact(row);artifacts.push(artifactRef(row.file));}
      return {...diagnostics,artifacts};
    }finally{signal.removeEventListener('abort',cancel);}
  }
  async #childTool(a:Attempt,name:string,raw:string,args:Readonly<Record<string,unknown>>,signal:AbortSignal) {
    if(['read_file','write_file','run_command'].includes(name)) {
      this.#requireEnabled(a);
      if(name==='run_command')return this.#analysis(a,raw,args,signal);
      if(name==='write_file') {
        if(typeof args.content!=='string' || Object.keys(args).length!==2)throw new ManagerError('INVALID_INPUT','Supply a filename and UTF-8 content.');
        const filename=text(args.name,'Name');this.#requirePrivateNames(a,[filename]);await this.#files.write(a,filename,args.content);
        return {name:filename,bytes:Buffer.byteLength(args.content),sha256:hash(args.content),scope:'private workspace',
          execution:'not executed',published:false};
      }
      if(Object.keys(args).length!==1)throw new ManagerError('INVALID_INPUT','Choose exactly one file source.');
      if(typeof args.fileId==='string')return this.#upload(a,args.fileId).bytes.toString('utf8');
      if(typeof args.artifactId==='string')return (await this.#readArtifact(this.#artifact(a,args.artifactId))).toString('utf8');
      return Buffer.from((await this.#analysisInput(a,text(args.name,'Name'))).bytes).toString('utf8');
    }
    if(name!=='read' && name!=='calculate_csv')throw new ManagerError('TOOL_DENIED','Tool is not available to this agent.');
    const keys=name==='read'?['fileId']:['fileId','column'];
    if(Object.keys(args).some(k=>!keys.includes(k)))throw new ManagerError('INVALID_INPUT','Unexpected child tool arguments.');
    const {f,bytes}=this.#upload(a,args.fileId);
    if(name==='read')return bytes.toString('utf8');
    const grant=await this.#jobs.grant({projectId:a.projectId,sessionId:a.sessionId,fileId:f.id,versionId:text(f.versionId,'Version'),name:f.name,bytes});
    signal.throwIfAborted();
    const tid=toolId(a,raw);
    // A process owns its own attempt key: multiple jobs within one Pi turn remain distinct.
    const processId=randomUUID();
    const request={projectId:a.projectId,sessionId:a.sessionId,taskId:a.taskId,attemptId:processId,
      toolId:tid,grantId:grant.id,requestId:raw,...(args.column!==undefined?{column:text(args.column,'Column')}:{})};
    const job=this.#jobs.start(request);
    const cancel=()=>job.cancel();signal.addEventListener('abort',cancel,{once:true});
    try{
      const result=await job.result;
      if(result.status!=='succeeded' || !result.artifact)throw new ManagerError('CSV_FAILED',result.error??('CSV process '+result.status));
      const statistics:unknown=JSON.parse((await this.#jobs.download(result.artifact)).toString('utf8'));
      return {statistics,artifact:artifactRef(result.artifact),artifactId:result.artifact.id,processId,sha256:result.artifact.sha256};
    }finally{signal.removeEventListener('abort',cancel);}
  }
  #processEvent(event:CsvJobEvent){this.#commit(()=>this.#journal.process(event));}
  #history(conversation:StoredSession,runtime:ManagedPiSession) {
    const messages=runtime.getMessages();
    if(!Array.isArray(messages))throw new ManagerError('INVALID_HISTORY','Invalid Pi history.');
    const journal=this.#storage.records<HistoryEvent>('pi_event',conversation.id)
      .filter(row=>row.projectId===conversation.projectId && row.agentSessionId===runtime.sessionId);
    return projectHistory(messages,journal);
  }
  async getAgentHistory(conversationId:string,agentSessionId:string) {
    this.#assertReady();
    const conversation=this.#session(conversationId);
    const agent=this.#storage.record<AgentSession>('agent_session',agentSessionId);
    if(agentSessionId!==conversationId && (!agent || agent.sessionId!==conversationId || agent.projectId!==conversation.projectId))
      throw new ManagerError('SESSION_MISMATCH','Agent session is outside the requested conversation.');
    const runtime=agent?await this.#load(agent):await this.#openRoot(conversation);
    return {conversationId,agentSessionId,messages:this.#history(conversation,runtime)};
  }
  async artifactDownload(conversationId:string,artifactId:string){
    this.#assertReady();
    const file=this.#storage.record<ArtifactRow>('artifact',artifactId);
    if(!file || file.sessionId!==conversationId)throw new ManagerError('ARTIFACT_DENIED','Artifact is outside this conversation.');
    return {bytes:await this.#readArtifact(file),name:file.file.name,mimeType:file.file.mimeType};
  }
  async #cancel(task:TaskRow){
    const turns=[...this.#turns.values()].filter(t=>t.attempt.taskId===task.id || (!task.parentTaskId && t.attempt.runId===task.runId));
    for(const t of turns)t.controller.abort(new ManagerError('CANCELLED','Task cancellation requested.'));
    await Promise.all(turns.filter(t=>this.#executing.get(t.attempt.agentSessionId)===t.attempt).map(t=>t.runtime.command({type:'abort',id:randomUUID()})));
    await Promise.all(turns.map(t=>t.finished));
  }
  async cancelTask(taskId:string) {
    this.#assertReady();
    const task=this.#storage.record<TaskRow>('task',taskId);
    if(!task || task.sessionId!==this.#active)throw new ManagerError('TASK_SCOPE_MISMATCH','Task is outside the selected conversation.');
    if(!pending(task.status))throw new ManagerError('TASK_NOT_ACTIVE','Task is not active.');
    await this.#cancel(task);
    const updated=this.#storage.record<TaskRow>('task',taskId);
    if(!updated)throw new Error('Missing cancelled task.');
    return this.#summary(updated);
  }
  async cancelRun(runId:string) {
    this.#assertReady();
    const run=this.#storage.record<Run>('run',runId);
    if(!run || run.sessionId!==this.#active || !pending(run.status))throw new ManagerError('RUN_NOT_ACTIVE','Run is not active.');
    const task=this.#storage.record<TaskRow>('task',run.taskId);
    if(!task)throw new Error('Missing root task.');
    // Record the user's run-level decision before aborting any Pi turn. The root may already be done.
    this.#storage.transaction(()=>this.#storage.putRecord('run',{...run,cancellationRequested:true}));
    await this.#cancel(task);
    return reply({type:'abort'},{runId});
  }
  #interrupt(sessionId:string,reason:string){
    // Settle the interrupted run in the same transaction as its outstanding work. A completed
    // coordinator cannot establish the outcome of work that was still pending when the host died.
    for(const r of this.#runs(sessionId))if(pending(r.status)){
      this.#journal.finishRun(r,'paused',reason);
      // M1 may have a pending root or tool without a corresponding M2 attempt.
      const root=this.#storage.record<Task>('task',r.taskId);
      if(root && pending(root.status))this.#storage.putRecord('task',{...root,status:'paused'});
      for(const tool of this.#storage.records<Tool>('tool',sessionId))if(tool.runId===r.id && pending(tool.status))this.#storage.putRecord('tool',{...tool,status:'paused'});
    }
    for(const a of this.#storage.records<Attempt>('attempt',sessionId))if(pending(a.status))this.#journal.transition(a,'paused',reason);
  }
  async close(){
    if(this.#closed)return;
    this.#closed=true;
    const turns=[...this.#turns.values()];
    for(const t of turns)t.controller.abort();
    await Promise.all(turns.filter(t=>this.#executing.get(t.attempt.agentSessionId)===t.attempt).map(t=>t.runtime.command({type:'abort',id:randomUUID()})));
    await Promise.all(turns.map(t=>t.finished));
    await this.#jobs.close();
    for(const runtime of this.#registry.values())runtime.close();
    this.#registry.clear();
    this.#storage.transaction(()=>{
      for(const s of this.#storage.sessions())this.#interrupt(s.id,'Host closed before execution settled.');
      this.#storage.advanceRevision();
    });
    this.#listeners.clear();this.#piListeners.clear();this.#storage.close();
  }
}
