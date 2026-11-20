import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Storage } from './storage.ts';
import type { StoredSession } from './storage.ts';
import type { AthenaTaskManager, ModelReference, Project, SessionActivation, Status, Task, Tool, WorkspaceEvent, WorkspaceSnapshot, Agent } from '../athena-backend-handoff/athena-codex-ui/integrations/task-manager.d.ts';
import type { FileReference } from '../athena-backend-handoff/athena-codex-ui/integrations/pi-bridge-contracts.d.ts';
import type { PiOrchestration } from './agent-tools.ts';
import { CsvJobRunner } from './jobs.ts';
import type { CsvJobEvent } from './jobs.ts';
import { ManagerError, object, text, hash, pending, limit, TurnScheduler, artifactRef } from './orchestration.ts';
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
export type PiSessionFactory = (options: {
  readonly projectDir: string; readonly sessionDir: string; readonly sessionFile?: string; readonly orchestration?: PiOrchestration;
}) => Promise<ManagedPiSession>;
export type TaskManagerOptions = { readonly dataDir: string; readonly createPiSession?: PiSessionFactory };
export type Run = {
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
  readonly #listeners = new Set<(snapshot: WorkspaceSnapshot) => void>();
  readonly #piListeners = new Set<(sessionId: string, event: PiEvent) => void>();
  readonly #journal: Journal;
  readonly #jobs: CsvJobRunner;
  readonly #registry = new Map<string, ManagedPiSession>();
  readonly #loading = new Map<string, Promise<ManagedPiSession>>();
  readonly #turns = new Map<string, Live>();
  readonly #executing = new Map<string, Attempt>();
  readonly #waiters = new Set<() => void>();
  readonly #scheduler = new TurnScheduler(limit('ATHENA_MODEL_CONCURRENCY', 2, 1, 64));
  readonly #maxChildren = limit('ATHENA_MAX_CHILDREN', 8, 0, 128);
  readonly #depth = limit('ATHENA_MAX_DEPTH', 1, 0, 1);
  #active: string | null = null;
  #busy = false;
  #ready = false;
  #closed = false;

  constructor(options: TaskManagerOptions) {
    this.#directory = options.dataDir;
    this.#storage = new Storage(options.dataDir);
    this.#journal = new Journal(this.#storage);
    this.#jobs = new CsvJobRunner({dataDir: options.dataDir, concurrency: limit('ATHENA_PROCESS_CONCURRENCY', 1, 1, 4),
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
  async #make(projectId:string, sessionDir:string, role:PiOrchestration['role'], sessionFile?:string) {
    let runtime: ManagedPiSession;
    // Pi may execute tools from a single model response concurrently. Bind each call at entry,
    // and serialize its manager effects (including spawn then join) in SDK call order.
    let chain = Promise.resolve();
    runtime = await this.#factory({projectDir:this.#projectDir(projectId), sessionDir, sessionFile, orchestration:{role,
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
  #runs(sessionId: string): Run[] { return this.#storage.records<Run>('run', sessionId); }
  #currentRun(sessionId: string): Run | undefined { return this.#runs(sessionId).at(-1); }

  getSnapshot() {
    this.#assertReady();
    const session = this.#active ? this.#session(this.#active) : undefined;
    const run = session ? this.#currentRun(session.id) : undefined;
    return structuredClone({
      revision: this.#storage.revision(), projectId: session?.projectId ?? this.#storage.get<string | null>('activeProject') ?? null, sessionId: session?.id ?? null,
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
    const fileIds=Array.isArray(command.fileReferences)?command.fileReferences.filter(object).map(ref=>text(ref.id,'File ID')):[];
    const a=this.#attempt({projectId:session.projectId,sessionId:session.id,runId:run.id,taskId:run.taskId,
      parentTaskId:null,agentSessionId:runtime.sessionId},requestId,message,fileIds);
    const response=reply(command,{accepted:true,...context(a)});
    this.#commit(()=>{
      this.#storage.putRecord('run',{...run,agentSessionId:a.agentSessionId,attemptId:a.id});
      this.#journal.accept(a,run.title);
      this.#storage.putReceipt({sessionId:session.id,requestId,fingerprint,state:'accepted',response});
    });
    this.#schedule(a,runtime);
    return response;
  }
  #attempt(owner:Omit<Context,'attemptId'>,requestId:string,prompt:string,fileIds:readonly string[]):Attempt {
    const id=randomUUID();
    return {...owner,id,attemptId:id,requestId,prompt,fileIds,status:'queued',acceptedAt:Date.now(),startedAt:null,endedAt:null};
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
    }
  }
  #children(a:Context) {return this.#storage.records<TaskRow>('task',a.sessionId).filter(t=>t.runId===a.runId && t.parentTaskId===a.taskId);}
  #child(a:Context,id:unknown) {
    const task=this.#storage.record<TaskRow>('task',text(id,'Task ID'));
    if(!task || task.sessionId!==a.sessionId || task.runId!==a.runId || task.parentTaskId!==a.taskId)
      throw new ManagerError('TASK_SCOPE_MISMATCH','This is not a direct child of the calling task.');
    return task;
  }
  #summary(t:TaskRow) {return {taskId:t.id,parentTaskId:t.parentTaskId,agentSessionId:t.agentSessionId,attemptId:t.attemptId,
    title:t.title,status:t.status,result:t.result??null,error:t.error,artifactIds:t.artifactIds,
    artifacts:t.artifactIds.flatMap(id=>{const row=this.#storage.record<ArtifactRow>('artifact',id);
      return row && row.sessionId===t.sessionId && row.taskId===t.id?[artifactRef(row.file)]:[];})};}
  async #operation(a:Attempt,name:string,raw:string,args:Readonly<Record<string,unknown>>,sdkSignal?:AbortSignal):Promise<unknown> {
    const turn=this.#turns.get(a.id);
    if(!turn || this.#executing.get(a.agentSessionId)!==a || this.#closed)throw new ManagerError('ATTEMPT_INACTIVE','This attempt is no longer active.');
    const signal=sdkSignal?AbortSignal.any([sdkSignal,turn.controller.signal]):turn.controller.signal;
    signal.throwIfAborted();
    if(a.parentTaskId)return this.#childTool(a,name,raw,args,signal);
    switch(name){
      case 'spawn_agent':case 'send_to_agent':return this.#dispatch(a,name,raw,args,signal);
      case 'get_task':return this.#summary(this.#child(a,args.taskId));
      case 'list_tasks':return {tasks:this.#children(a).map(t=>this.#summary(t))};
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
    if(child && (child.status==='cancelled'||child.status==='paused'))throw new ManagerError('TASK_CLOSED','Cannot send to a cancelled or interrupted task.');
    if(!child && (this.#depth===0||this.#children(a).length>=this.#maxChildren))throw new ManagerError('CHILD_LIMIT','Direct child limit reached.');
    const taskId=child?.id??randomUUID();
    const title=child?.title??text(args.title,'Child title');
    const message=text(child?args.message:args.prompt,'Child message');
    if(message.length>32768)throw new ManagerError('INPUT_TOO_LARGE','Child message exceeds 32768 characters.');
    const reservation:Dispatch={...context(a),id,taskId,fingerprint};
    this.#commit(()=>this.#storage.putRecord(kind,reservation));
    const sessionDir=join(this.#directory,'agents',randomUUID());
    const runtime=child?this.#registry.get(child.agentSessionId):await this.#make(a.projectId,sessionDir,'child');
    if(!runtime)throw new ManagerError('SESSION_UNAVAILABLE','Child Pi session unavailable.');
    signal.throwIfAborted();
    const grantInfo=a.fileIds.map(id=>({fileId:id,name:this.#storage.record<StoredFile>('file',id)?.name}));
    const prompt=child?message:message+'\nGranted input files: '+JSON.stringify(grantInfo);
    const next=this.#attempt({...context(a),taskId,parentTaskId:a.taskId,agentSessionId:runtime.sessionId},requestId,prompt,a.fileIds);
    const response={taskId,parentTaskId:a.taskId,agentSessionId:runtime.sessionId,attemptId:next.id,status:next.status};
    this.#commit(()=>{
      if(!child)this.#storage.putRecord('agent_session',{projectId:a.projectId,sessionId:a.sessionId,id:runtime.sessionId,
        role:'child',sessionDir,sessionFile:runtime.sessionFile} satisfies AgentSession);
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
    const summaries=()=>tasks.map(t=>this.#summary(this.#child(a,t.id)));
    if(tasks.some(t=>pending(t.status))) {
      this.#commit(()=>{this.#journal.transition(a,'blocked');this.#journal.event(a,'wait_started','Waiting for '+tasks.length+' child tasks.');});
      this.#scheduler.release(a,true);
      try {
        await new Promise<void>((resolve,reject)=>{
          const clear=()=>{this.#waiters.delete(check);signal.removeEventListener('abort',abort);};
          const abort=()=>{clear();reject(signal.reason);};
          const check=()=>{if(!summaries().some(t=>pending(t.status))){clear();resolve();}};
          signal.throwIfAborted();
          this.#waiters.add(check);signal.addEventListener('abort',abort,{once:true});check();
        });
      }finally{
        if(!signal.aborted){await this.#scheduler.acquire(a,signal);
          this.#commit(()=>{this.#journal.transition(a,'running');this.#journal.event(a,'wait_completed','Child tasks settled; model slot reacquired.');});}
      }
    }
    return {tasks:summaries()};
  }
  async #childTool(a:Attempt,name:string,raw:string,args:Readonly<Record<string,unknown>>,signal:AbortSignal) {
    if(name!=='read' && name!=='calculate_csv')throw new ManagerError('TOOL_DENIED','Workers can only read granted inputs or calculate CSV statistics.');
    const keys=name==='read'?['fileId']:['fileId','column'];
    if(Object.keys(args).some(k=>!keys.includes(k)))throw new ManagerError('INVALID_INPUT','Unexpected child tool arguments.');
    const id=args.fileId===undefined && a.fileIds.length===1?a.fileIds[0]:args.fileId;
    if(typeof id!=='string' || !a.fileIds.includes(id))throw new ManagerError('GRANT_DENIED','Choose one of the explicitly granted file IDs.');
    const f=this.#storage.record<StoredFile>('file',id);
    if(!f || f.sessionId!==a.sessionId || f.projectId!==a.projectId)throw new ManagerError('GRANT_DENIED','File is outside this conversation.');
    const bytes=readFileSync(f.path);
    if(hash(bytes)!==f.digest)throw new ManagerError('FILE_CHANGED','Granted file bytes changed.');
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
    return {bytes:await this.#jobs.download(file.file),name:file.file.name};
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
    await this.#cancel(task);
    return reply({type:'abort'},{runId});
  }
  #interrupt(sessionId:string,reason:string){
    for(const a of this.#storage.records<Attempt>('attempt',sessionId))if(pending(a.status))this.#journal.transition(a,'paused',reason);
    // An M1 database may contain a previously accepted run with no M2 attempt.
    for(const r of this.#runs(sessionId))if(pending(r.status)){
      this.#storage.putRecord('run',{...r,status:'paused',endedAt:Date.now(),error:reason});
      const t=this.#storage.record<Task>('task',r.taskId);
      if(t)this.#storage.putRecord('task',{...t,status:'paused'});
      for(const tool of this.#storage.records<Tool>('tool',sessionId))if(tool.runId===r.id && pending(tool.status))this.#storage.putRecord('tool',{...tool,status:'paused'});
      this.#journal.finishReceipt(r,'paused',reason);
    }
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
