import { builtins, bindCall } from './mcp-registry.ts';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Storage } from './storage.ts';
import type { StoredSession } from './storage.ts';
import type { AthenaTaskManager, ModelReference, Project, SessionActivation, Status, Task, Tool, WorkspaceEvent, WorkspaceSnapshot, Agent } from '../athena-backend-handoff/athena-codex-ui/integrations/task-manager.d.ts';
import type { FileReference } from '../athena-backend-handoff/athena-codex-ui/integrations/pi-bridge-contracts.d.ts';
import type { PiOrchestration } from './agent-tools.ts';
import type { PiModelSelection, PiSessionOptions } from './pi.ts';
import { JobRunner, ANALYSIS_LIMITS, MCP_LIMITS } from './jobs.ts';
import { AnalysisFiles, ANALYSIS_FILE_LIMITS, validateAnalysisName, validateOutputNames } from './analysis-files.ts';
import type { AnalysisSnapshot } from './analysis-files.ts';
import type { JobEvent } from './jobs.ts';
import { ManagerError, object, text, hash, pending, limit, TurnScheduler, artifactRef, executionProjects } from './orchestration.ts';
import type { AgentSession, Context, TaskRow, Attempt, ProcessRow, ArtifactRow } from './orchestration.ts';
import { Journal, context, toolId, normalizeEvent } from './orchestration-journal.ts';
import { projectHistory } from './history.ts';
import { ToolFailureBudget } from './tool-failure-budget.ts';
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
  prompt(message: string, options?: { readonly kind?: 'reconciliation' }): Promise<void>;
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
  readonly recovery?: { readonly requestId: string; readonly reconciliationAttemptId: string };
};
type StoredFile = FileReference & {
  readonly projectId: string; readonly sessionId: string; readonly path: string; readonly digest: string;
};
const uploadBytes = 256 * 1024;
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
export type RetryTaskOptions = { readonly requestId: string; readonly expectedAttemptId: string };
export type RetryTaskResult = Omit<Accepted, 'status' | 'parentTaskId'> & { readonly parentTaskId: string; readonly runId: string; readonly status: 'queued'; readonly reconciliationAttemptId: string };
type RetryReceipt = { readonly id: string; readonly projectId: string; readonly sessionId: string; readonly runId: string;
  readonly taskId: string; readonly requestId: string; readonly expectedAttemptId: string; readonly fingerprint: string;
  readonly response: RetryTaskResult };
type Live = { runtime: ManagedPiSession; controller: AbortController; attempt: Attempt; finished: Promise<void> };

export class TaskManager implements AthenaTaskManager {
  readonly capabilities: AthenaTaskManager['capabilities'] = ['create_project', 'create_session', 'open_session', 'set_project_model', 'set_project_execution', 'cancel_run', 'cancel_task', 'retry_task', 'get_agent_history'];
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
  readonly #jobs: JobRunner;
  readonly #files: AnalysisFiles;
  readonly #enabledProjects = executionProjects();
  readonly #runtimeExecution = new WeakMap<ManagedPiSession, boolean>();
  readonly #concurrency = limit('ATHENA_PROCESS_CONCURRENCY', 1, 1, 4);
  #access: Awaited<ReturnType<JobRunner['analysisAccess']>> = {available:false,reason:'Analysis runtime has not been checked.'};
  readonly #timeoutMs = 5000;
  readonly #registry = new Map<string, ManagedPiSession>();
  readonly #loading = new Map<string, Promise<ManagedPiSession>>();
  readonly #retrying = new Map<string, { fingerprint: string; promise: Promise<RetryTaskResult> }>();
  readonly #retryTasks = new Set<string>();
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
    this.#jobs = new JobRunner({dataDir: options.dataDir, concurrency: this.#concurrency, timeoutMs:this.#timeoutMs,
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
      this.#access = await this.#jobs.analysisAccess();
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
  #uploadDirectory(projectId: string): string {
    const root = realpathSync(this.#directory);
    const directory = join(root, 'projects', projectId, 'uploads');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const status = lstatSync(directory);
    if (!status.isDirectory() || status.uid !== process.getuid?.() || (status.mode & 0o077) || realpathSync(directory) !== directory) {
      throw new ManagerError('FILE_SCOPE_MISMATCH', 'Upload storage is not a private project directory.');
    }
    return directory;
  }
  #readUpload(file: StoredFile): Buffer {
    if (!/^[a-f0-9-]{36}$/u.test(file.id) || file.path !== join(this.#projectDir(file.projectId), 'uploads', `${file.id}.txt`) ||
      !Number.isSafeInteger(file.size) || file.size < 0 || file.size > uploadBytes) {
      throw new ManagerError('FILE_SCOPE_MISMATCH', 'The saved upload is outside its original project or exceeds its grant.');
    }
    const directory = this.#uploadDirectory(file.projectId);
    const path = join(directory, `${file.id}.txt`);
    try {
      const before = lstatSync(path);
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const actual = fstatSync(fd);
        if (!actual.isFile() || actual.nlink !== 1 || actual.uid !== process.getuid?.() || (actual.mode & 0o077) ||
          actual.dev !== before.dev || actual.ino !== before.ino || actual.size !== file.size || realpathSync(path) !== path) {
          throw new ManagerError('FILE_CHANGED', 'The staged upload is no longer the granted file.');
        }
        const bytes = Buffer.allocUnsafe(file.size + 1);
        let size = 0;
        while (size < bytes.length) {
          const count = readSync(fd, bytes, size, bytes.length - size, size);
          if (count === 0) break;
          size += count;
        }
        const snapshot = bytes.subarray(0, size);
        if (size !== file.size || hash(snapshot) !== file.digest) throw new ManagerError('FILE_CHANGED', 'The staged file content changed.');
        return snapshot;
      } finally { closeSync(fd); }
    } catch (error) {
      if (error instanceof ManagerError) throw error;
      if (!(error instanceof Error)) throw error;
      throw new ManagerError('FILE_CHANGED', 'The staged file could not be read securely. Attach it again.');
    }
  }
  #executionEnabled(projectId: string): boolean {
    return this.#access.available && (this.#storage.project(projectId)?.offlineAnalysis ?? this.#enabledProjects.has(projectId));
  }
  async #make(projectId:string, sessionDir:string, role:PiOrchestration['role'], sessionFile?:string, selection?:PiModelSelection) {
    let runtime: ManagedPiSession;
    // Pi may execute tools from a single model response concurrently. Bind each call at entry,
    // and serialize its manager effects (including spawn then join) in SDK call order.
    let chain = Promise.resolve();
    const executionEnabled = this.#executionEnabled(projectId);
    runtime = await this.#factory({projectDir:this.#projectDir(projectId), sessionDir, sessionFile, selection, orchestration:{role,
      executionEnabled,
      execute:(name,raw,args,signal) => {
        const a = this.#executing.get(runtime.sessionId);
        if (!a) throw new ManagerError('ATTEMPT_INACTIVE','No dispatched attempt owns this tool.');
        const work = chain.then(() => this.#operation(a,name,raw,args,signal));
        chain = work.then(()=>{},()=>{}); return work;
      }}});
    if (this.#closed || this.#registry.has(runtime.sessionId)) {
      runtime.close(); throw new ManagerError('SESSION_UNAVAILABLE','Manager closed or duplicate Pi identity.');
    }
    this.#runtimeExecution.set(runtime, executionEnabled);
    if (selection) this.#runtimeModels.set(runtime, { provider: selection.model.provider, modelId: selection.model.id,
      thinkingLevel: selection.thinkingLevel, ...(selection.endpoint ? { endpoint: selection.endpoint } : {}),
      ...(selection.authRef ? { authRef: selection.authRef } : {}) });
    this.#registry.set(runtime.sessionId,runtime); return runtime;
  }
  #load(s: AgentSession, selection?: PiModelSelection): Promise<ManagedPiSession> {
    const runtime = this.#registry.get(s.id); if (runtime) return Promise.resolve(runtime);
    const loading = this.#loading.get(s.id); if (loading) return loading;
    const promise = this.#make(s.projectId,s.sessionDir,s.role,s.sessionFile,selection).then(value => {
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
  async setProjectExecution(projectId: string, enabled: boolean) {
    this.#assertReady();
    if (this.hasPendingRuns()) throw new ManagerError('RUN_BUSY', 'Wait for research to finish before changing analysis permission.');
    const project = this.#storage.project(projectId);
    const active = this.#active ? this.#session(this.#active).projectId : this.#storage.get<string>('activeProject');
    if (!project || projectId !== active) throw new ManagerError('PROJECT_NOT_FOUND', 'Select the project before changing its analysis permission.');
    if (enabled && !this.#access.available) throw new ManagerError('EXECUTION_UNAVAILABLE', this.#access.reason);
    this.#commit(() => this.#storage.putProject({ ...project, offlineAnalysis: enabled }));
    return { saved: true as const, snapshot: this.getSnapshot() };
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
      execution: {projectId, enabled:projectId!==null && this.#executionEnabled(projectId), backend:'wasi' as const,
        shell:false as const, network:false as const, runtime:this.#access,
        limits:{...ANALYSIS_FILE_LIMITS,...ANALYSIS_LIMITS,queue:MCP_LIMITS.queue,timeoutMs:this.#timeoutMs,concurrency:this.#concurrency,modelConcurrency:this.#modelConcurrency,maxDepth:this.#depth,maxChildren:this.#maxChildren}},
      projects: this.#storage.projects(),
      sessions: this.#storage.sessions().map(({ sessionFile: _file, sessionDir: _dir, ...metadata }) => metadata),
      run: { id: run?.id ?? null, status: run?.status ?? 'ready', startedAt: run?.startedAt ?? null,
        elapsedMs: run?.startedAt ? (run.endedAt ?? Date.now()) - run.startedAt : 0, model: run?.model ?? session?.model ?? null },
      tasks: session ? this.#storage.records<TaskRow>('task', session.id).map(task => {
        let retryUnavailableReason: string | undefined;
        try { this.#retryTarget(task.id); if (this.#busy) retryUnavailableReason = 'Another session operation is being prepared.'; }
        catch (error) { retryUnavailableReason = error instanceof Error ? error.message : 'This task cannot be retried.'; }
        return { ...task, retryable: retryUnavailableReason === undefined, ...(retryUnavailableReason ? { retryUnavailableReason } : {}) };
      }) : [],
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
    return typeof provider === 'string' && typeof id === 'string' ? { provider, modelId: id,
      ...(typeof state.model.baseUrl === 'string' ? { endpoint: state.model.baseUrl } : {}),
      ...(typeof state.thinkingLevel === 'string' ? { thinkingLevel: state.thinkingLevel } : {}) } : null;
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
      if (bytes.length > uploadBytes) throw new ManagerError('FILE_TOO_LARGE', 'Files must not exceed 256 KiB.');
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const id = randomUUID();
      const record: StoredFile = { id, projectId: session.projectId, sessionId, name: file.name,
        mimeType: file.mimeType, size: bytes.length, versionId: hash(bytes), digest: hash(bytes),
        path: join(this.#projectDir(session.projectId), 'uploads', `${id}.txt`) };
      return { bytes, record };
    });
    const written: string[] = [];
    try {
      const directory = this.#uploadDirectory(session.projectId);
      for (const { bytes, record } of prepared) {
        const path = join(directory, `${record.id}.txt`);
        writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
        written.push(path);
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
        this.#readUpload(stored);
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
    let selection = this.#models?.resolve(session.profileId, this.#storage.project(session.projectId)?.defaultProfileId) ?? null;
    let pin: PiModelSelection | undefined;
    if (selection && this.#models) {
      this.#busy = true;
      try {
        pin = await this.#models.pin(selection);
        selection = { ...selection, ...(pin.endpoint ? { endpoint: pin.endpoint } : {}), ...(pin.authRef ? { authRef: pin.authRef } : {}) };
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
    } else if (this.#runtimeModels.has(runtime) || this.#runtimeExecution.get(runtime) !== this.#executionEnabled(session.projectId)) {
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
    if (this.#closed) return;
    if (!pending(this.#storage.record<Attempt>('attempt', a.id)?.status ?? 'ready')) {
      if (!pending(this.#storage.record<Run>('run', a.runId)?.status ?? 'ready')) this.#pins.delete(a.runId);
      return;
    }
    // Snapshot listeners can request cancellation synchronously during acceptance.
    // Honor that newer decision before starting either of the durable retry turns.
    if (this.#storage.record<Run>('run', a.runId)?.cancellationRequested) {
      this.#commit(() => this.#journal.transition(a, 'cancelled', 'Run cancelled before this queued attempt started.'));
      if (!pending(this.#storage.record<Run>('run', a.runId)?.status ?? 'ready')) this.#pins.delete(a.runId);
      return;
    }
    const controller=new AbortController();
    const finished=this.#execute(a,runtime,controller.signal);
    this.#turns.set(a.id,{controller,runtime,attempt:a,finished});
  }
  async #execute(a:Attempt,runtime:ManagedPiSession,signal:AbortSignal) {
    let unsubscribe:(()=>void)|undefined;
    const failureBudget = new ToolFailureBudget();
    try {
      await this.#scheduler.acquire(a,signal);
      signal.throwIfAborted();
      let prompt = a.prompt;
      if (a.kind === 'reconciliation') {
        // Waiting releases only the model slot. The root session lease prevents an
        // earlier coordinator turn and this continuation from entering Pi together.
        let joined: unknown;
        let recoveryRequest: string | undefined;
        do {
          recoveryRequest = this.#storage.record<Run>('run', a.runId)?.recovery?.requestId;
          joined = await this.#wait(a, undefined, signal);
        } while (this.#children(a).some(child => pending(child.status)) ||
          recoveryRequest !== this.#storage.record<Run>('run', a.runId)?.recovery?.requestId);
        signal.throwIfAborted();
        prompt = 'A user-requested retry has settled. Update the final answer to the original request using the current child results below. '
          + 'Reuse completed sibling results and preserve their provenance. Report remaining failures honestly. '
          + 'This is a read-only reconciliation: do not spawn, send work to, or cancel agents. Read relevant result artifacts before answering.\n'
          + 'Current verified child results: ' + JSON.stringify(joined);
        this.#commit(() => {
          const current = this.#storage.record<Attempt>('attempt', a.id);
          if (current && pending(current.status)) this.#storage.putRecord('attempt', { ...current, prompt });
        });
      }
      this.#executing.set(a.agentSessionId,a);
      unsubscribe=runtime.subscribe(event=>{
        if(this.#closed || this.#executing.get(a.agentSessionId)!==a)return;
        const semantic=SNAPSHOT_EVENTS.has(event.type);
        const failure = failureBudget.observe(event);
        this.#storage.transaction(()=>{
          this.#journal.receive(a,event,signal.aborted);
          if (failure) {
            this.#journal.transition(a, 'failed', failure.message);
            this.#journal.event(a, 'tool_failure_limit', failure.message,
              typeof event.toolCallId === 'string' ? {toolId:toolId(a,event.toolCallId)} : {});
          }
          if(semantic){this.#journal.event(a,event.type,event.type,typeof event.toolCallId==='string'?{toolId:toolId(a,event.toolCallId)}:{});this.#storage.advanceRevision();}
        });
        if (failure && this.#executing.get(a.agentSessionId) === a) {
          this.#turns.get(a.id)?.controller.abort(new ManagerError(failure.code, failure.message));
          void runtime.command({type:'abort',id:randomUUID()}).catch(() => {});
        }
        const normalized=normalizeEvent(a,event);
        for(const listener of this.#piListeners)listener(a.agentSessionId,structuredClone(normalized));
        if(semantic)this.#publish();
      });
      await runtime.prompt(prompt, a.kind === 'reconciliation' ? {kind:'reconciliation'} : undefined);
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
    if (['spawn_agent', 'send_to_agent', 'cancel_task'].includes(name)) this.#requireCoordinatorWrites(a);
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
  #requireCoordinatorWrites(a: Attempt) {
    if (a.kind === 'reconciliation' || this.#storage.record<Run>('run', a.runId)?.recovery) {
      throw new ManagerError('RECOVERY_READ_ONLY', 'Manual recovery preserves completed work. The coordinator may only inspect child results and produce the final answer.');
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
    if (child && this.#retryTasks.has(child.id)) throw new ManagerError('TASK_RETRY_PENDING', 'A manual retry is being prepared for this child.');
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
    this.#requireCoordinatorWrites(a);
    if (child && this.#retryTasks.has(child.id)) throw new ManagerError('TASK_RETRY_PENDING', 'A manual retry is being prepared for this child.');
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
    const tasks=list?.length?list.map(id=>this.#child(a,id)):this.#children(a);
    const current=()=>tasks.map(t=>this.#child(a,t.id));
    this.#commit(()=>this.#journal.wait(a,tasks));
    if(tasks.some(t=>pending(t.status))) {
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
    if(!this.#executionEnabled(a.projectId))return {tasks:joined};
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
    return {f,bytes:this.#readUpload(f)};
  }
  #requireEnabled(a:Context) {
    if(!this.#executionEnabled(a.projectId))throw new ManagerError('EXECUTION_DISABLED','Offline execution is not enabled for this project.');
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
  async #analysisInput(a:Attempt,ref:unknown,index?:number):Promise<AnalysisSnapshot & {fileId?:string;versionId?:string}> {
    const field=index===undefined?undefined:`inputs[${index}]${typeof ref==='string'?'':'.name'}`;
    const name=validateAnalysisName(text(typeof ref==='string'?ref:object(ref)?ref.name:null,field??'Input name'),
      field===undefined?undefined:{field,mount:'/workspace/'});
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
    const declared=validateOutputNames(outputs,true);
    this.#requirePrivateNames(a,declared);
    const scriptName=text(args.script,'Script name');
    if(!await this.#files.has(a,scriptName))throw new ManagerError('SCRIPT_NOT_FOUND',
      `run_command.script ${JSON.stringify(scriptName)} is not in this task's workspace. No process was started. Write the program with write_file using that name before calling run_command.`);
    const [script]=await this.#files.snapshot(a,[scriptName]);
    if(!script)throw new ManagerError('INVALID_INPUT','A private script is required.');
    const snapshots=await Promise.all(inputs.map((input,index)=>this.#analysisInput(a,input,index)));
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
    if (name === 'read') {
      if (Object.keys(args).some(key => key !== 'fileId')) throw new ManagerError('INVALID_INPUT','Unexpected read argument.');
      return this.#upload(a,args.fileId).bytes.toString('utf8');
    }
    const entry = builtins.get(name);
    if (!entry || entry.role !== 'child') throw new ManagerError('TOOL_DENIED','Tool is not available to this agent.');
    const {fileId, wire} = bindCall(entry,args);
    const {f,bytes} = this.#upload(a,fileId);
    const grant = await this.#jobs.grant({projectId:a.projectId,sessionId:a.sessionId,fileId:f.id,versionId:text(f.versionId,'Version'),name:f.name,bytes},name);
    signal.throwIfAborted();
    const tid=toolId(a,raw);
    // A process owns its own attempt key: multiple jobs within one Pi turn remain distinct.
    const processId=randomUUID();
    const request={projectId:a.projectId,sessionId:a.sessionId,taskId:a.taskId,attemptId:processId,
      toolId:tid,grantId:grant.id,requestId:raw};
    const job=this.#jobs.startMcp(name,request,wire);
    const cancel=()=>job.cancel();signal.addEventListener('abort',cancel,{once:true});
    try{
      const result=await job.result;
      if(result.status!=='succeeded' || !result.artifact)throw new ManagerError(entry.errorCode,result.error??('MCP process '+result.status));
      const output:unknown=JSON.parse((await this.#jobs.download(result.artifact)).toString('utf8'));
      return {[entry.resultField]:output,artifact:artifactRef(result.artifact),artifactId:result.artifact.id,processId,sha256:result.artifact.sha256};
    }finally{signal.removeEventListener('abort',cancel);}
  }
  #processEvent(event:JobEvent){
    this.#storage.transaction(()=>{this.#journal.process(event);this.#storage.advanceRevision();});
    // The runner treats a thrown completion callback as an uncommitted result.
    // A listener failure after commit must not revoke an already published artifact.
    try{this.#publish();}
    catch(error){process.emitWarning('The committed process update could not notify every listener.',{
      code:'PROCESS_NOTIFICATION_FAILED',detail:error instanceof Error?error.message:String(error),
    });}
  }
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
  #retryTarget(taskId: string, expectedAttemptId?: string) {
    const task = this.#storage.record<TaskRow>('task', taskId);
    if (!task || task.sessionId !== this.#active) throw new ManagerError('TASK_SCOPE_MISMATCH', 'Task is outside the selected conversation.');
    const runs = this.#runs(task.sessionId);
    if (runs.some(run => run.id !== task.runId && pending(run.status))) throw new ManagerError('RUN_BUSY', 'Another run is still active in this conversation.');
    const run = runs.at(-1);
    if (!run || run.id !== task.runId) throw new ManagerError('STALE_RUN', 'Only a task from the latest run can be retried.');
    if (pending(run.status) && run.cancellationRequested) throw new ManagerError('RUN_CANCELLED', 'Wait for the current cancellation to settle before retrying.');
    if (expectedAttemptId !== undefined && expectedAttemptId !== task.attemptId) throw new ManagerError('STALE_ATTEMPT', 'This task has a newer attempt. Refresh before retrying.');
    if (!task.parentTaskId || !['failed', 'paused', 'cancelled'].includes(task.status)) throw new ManagerError('TASK_NOT_RETRYABLE', 'Only failed, interrupted, or cancelled child tasks can be retried.');
    const previous = this.#storage.record<Attempt>('attempt', task.attemptId);
    const root = this.#storage.record<TaskRow>('task', run.taskId);
    const rootAttempt = root && this.#storage.record<Attempt>('attempt', root.attemptId);
    const agent = this.#storage.record<AgentSession>('agent_session', task.agentSessionId);
    if (!previous || previous.taskId !== task.id || previous.runId !== run.id || previous.sessionId !== task.sessionId ||
        previous.projectId !== task.projectId || previous.agentSessionId !== task.agentSessionId || pending(previous.status) ||
        !root || root.id !== task.parentTaskId || root.parentTaskId !== null || root.agentSessionId !== task.sessionId ||
        !rootAttempt || rootAttempt.runId !== run.id || !agent || agent.sessionId !== task.sessionId || agent.projectId !== task.projectId ||
        this.#storage.records<Attempt>('attempt', task.sessionId).some(a => a.taskId === task.id && pending(a.status))) {
      throw new ManagerError('TASK_NOT_RETRYABLE', 'The saved task does not have a complete, settled retry context.');
    }
    return { task, run, previous, root, rootAttempt, agent, session: this.#session(task.sessionId) };
  }
  async #retryRuntime(agent: AgentSession, model: ModelReference | null, pin: PiModelSelection | undefined, refresh: boolean) {
    await this.#loading.get(agent.id);
    let runtime = this.#registry.get(agent.id);
    const live = [...this.#turns.values()].filter(turn => turn.attempt.agentSessionId === agent.id);
    if (live.length && agent.role === 'child') await Promise.all(live.map(turn => turn.finished));
    // The active coordinator keeps its existing lease and runtime. Its read-only
    // reconciliation is queued on that same lease, never a parallel Pi conversation.
    if (runtime && refresh && !(agent.role === 'parent' && live.length)) {
      runtime.close(); this.#registry.delete(agent.id); runtime = undefined;
    }
    runtime ??= await this.#load(agent, pin);
    this.#validateModel(runtime, model);
    const actual = this.#runtimeModels.get(runtime) ?? this.#model(runtime);
    if (model?.endpoint && model.endpoint !== actual?.endpoint) throw new ManagerError('MODEL_UNAVAILABLE', 'The original model endpoint is no longer selected.');
    if (model?.authRef && model.authRef !== actual?.authRef) throw new ManagerError('MODEL_UNAVAILABLE', 'The original model account is no longer selected.');
    if (model) this.#runtimeModels.set(runtime, model);
    return runtime;
  }
  async retryTask(taskId: string, options: RetryTaskOptions): Promise<RetryTaskResult> {
    this.#assertReady();
    text(taskId, 'Task ID');
    if (!object(options) || Object.keys(options).some(key => key !== 'requestId' && key !== 'expectedAttemptId')) throw new ManagerError('INVALID_INPUT', 'Supply a request ID and the displayed attempt ID.');
    const requestId = text(options.requestId, 'Request ID');
    const expectedAttemptId = text(options.expectedAttemptId, 'Expected attempt ID');
    const task = this.#storage.record<TaskRow>('task', taskId);
    if (!task || task.sessionId !== this.#active) throw new ManagerError('TASK_SCOPE_MISMATCH', 'Task is outside the selected conversation.');
    const id = hash(canonical([task.sessionId, 'retry', requestId]));
    const fingerprint = hash(canonical({ taskId, expectedAttemptId }));
    const previous = this.#storage.record<RetryReceipt>('retry', id);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new ManagerError('REQUEST_ID_CONFLICT', 'Retry request ID was already used for different input.');
      return structuredClone(previous.response);
    }
    const inFlight = this.#retrying.get(id);
    if (inFlight) {
      if (inFlight.fingerprint !== fingerprint) throw new ManagerError('REQUEST_ID_CONFLICT', 'Retry request ID was already used for different input.');
      return inFlight.promise;
    }
    this.#retryTarget(taskId, expectedAttemptId);
    if (this.#busy || this.#retryTasks.has(taskId)) throw new ManagerError('RUN_BUSY', 'Another session operation is being prepared.');
    const promise = this.#prepareRetry(taskId, { requestId, expectedAttemptId }, id, fingerprint);
    this.#retrying.set(id, { fingerprint, promise });
    try { return await promise; } finally { this.#retrying.delete(id); }
  }
  async #prepareRetry(taskId: string, options: RetryTaskOptions, id: string, fingerprint: string): Promise<RetryTaskResult> {
    this.#busy = true; this.#retryTasks.add(taskId);
    try {
      const source = this.#retryTarget(taskId, options.expectedAttemptId);
      const currentSource = () => {
        this.#assertReady();
        const current = this.#retryTarget(taskId, options.expectedAttemptId);
        if (!source.run.cancellationRequested && current.run.cancellationRequested) throw new ManagerError('RUN_CANCELLED', 'The run was cancelled while this retry was being prepared.');
        return current;
      };
      const model = source.previous.model ?? source.run.model;
      // Revalidate immutable grants before accepting a new execution. No current
      // project default, new upload, or additional sibling artifact is inherited.
      for (const fileId of source.previous.fileIds) this.#upload(source.previous, fileId);
      for (const artifactId of source.previous.artifactGrants ?? []) await this.#readArtifact(this.#artifact(source.previous, artifactId));
      let pin = this.#pins.get(source.run.id);
      const managedModel = Boolean(model?.profileId);
      const refresh = !pending(source.run.status) || (!pin && Boolean(this.#models && managedModel));
      if (!pin && this.#models && model && managedModel) {
        pin = await this.#models.pin(model);
        if ((model.endpoint && pin.endpoint !== model.endpoint) || (model.authRef && pin.authRef !== model.authRef)) throw new ManagerError('MODEL_UNAVAILABLE', 'The original model endpoint or account is no longer available.');
      }
      currentSource();
      const childRuntime = await this.#retryRuntime(source.agent, model, pin, refresh);
      currentSource();
      const rootRuntime = await this.#retryRuntime({ ...source.session, sessionId: source.session.id, role: 'parent' }, model, pin, refresh);
      const current = currentSource();
      for (const fileId of current.previous.fileIds) this.#upload(current.previous, fileId);
      const next: Attempt = { ...this.#attempt({ ...context(current.previous) }, options.requestId, current.previous.prompt, current.previous.fileIds, model ?? undefined),
        artifactGrants: current.previous.artifactGrants, retryOfAttemptId: current.previous.id };
      const pendingReconciliation = this.#storage.records<Attempt>('attempt', current.session.id).find(a => a.runId === current.run.id && a.taskId === current.root.id && a.kind === 'reconciliation' && pending(a.status) && this.#executing.get(a.agentSessionId)?.id !== a.id);
      const reconciliation: Attempt = pendingReconciliation ?? { ...this.#attempt({ ...context(current.rootAttempt) }, 'reconcile:' + options.requestId,
        'Reconcile the manually retried child with the preserved results of this request.', current.rootAttempt.fileIds, model ?? undefined), kind: 'reconciliation' };
      const response: RetryTaskResult = { taskId, parentTaskId: current.root.id, agentSessionId: childRuntime.sessionId, attemptId: next.id,
        runId: current.run.id, status: 'queued', reconciliationAttemptId: reconciliation.id };
      this.#commit(() => {
        this.#storage.putRecord('run', { ...current.run, status: 'queued', endedAt: null, error: undefined, cancellationRequested: false,
          recovery: { requestId: options.requestId, reconciliationAttemptId: reconciliation.id } });
        this.#journal.accept(next, current.task.title);
        if (!pendingReconciliation) this.#journal.accept(reconciliation, current.root.title);
        this.#storage.putRecord('retry', { id, projectId: current.task.projectId, sessionId: current.task.sessionId, runId: current.run.id,
          taskId, requestId: options.requestId, expectedAttemptId: options.expectedAttemptId, fingerprint, response } satisfies RetryReceipt);
        this.#journal.event(next, 'task_retry_accepted', 'Manual retry accepted; previous attempts and successful sibling results are preserved.');
        this.#journal.event(reconciliation, 'run_reopened', 'Manual recovery queued a read-only coordinator reconciliation.');
      });
      if (pin) this.#pins.set(current.run.id, pin);
      this.#schedule(next, childRuntime);
      if (!pendingReconciliation) this.#schedule(reconciliation, rootRuntime);
      return response;
    } finally {
      this.#retryTasks.delete(taskId); this.#busy = false; this.#publish();
    }
  }
  async #cancel(task:TaskRow){
    const turns=[...this.#turns.values()].filter(t=>t.attempt.taskId===task.id || (!task.parentTaskId && t.attempt.runId===task.runId));
    // Acceptance is durable before its snapshot is published. A listener can cancel
    // a queued attempt before #schedule registers its live controller.
    const queued=this.#storage.records<Attempt>('attempt',task.sessionId).filter(a=>a.status==='queued' && !this.#turns.has(a.id) &&
      (a.taskId===task.id || (!task.parentTaskId && a.runId===task.runId)));
    if(queued.length)this.#commit(()=>{
      for(const a of queued)this.#journal.transition(a,'cancelled','Task cancelled before this queued attempt started.');
    });
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
