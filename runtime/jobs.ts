import { mcpClient, type McpPhase } from './mcp-client.ts';
import { builtins, bindCall, csvRegistration, verifyMcpOutput, MCP_LIMITS, type Registration } from './mcp-registry.ts';
import { analysisAccess, analysisEnv, ANALYSIS_LIMITS, SandboxCleanupError, runSandbox, type SandboxJob, type AnalysisAccess } from './analysis-sandbox.ts';
import { AnalysisFiles, validateOutputNames, type AnalysisArtifact, type AnalysisSnapshot } from './analysis-files.ts';
export { ANALYSIS_LIMITS } from './analysis-sandbox.ts';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, existsSync, rmSync } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { callExternalMcp, EXTERNAL_MCP_LIMITS, validateExternalVerification, matchesExternalSchema, extensionDigest } from './external-mcp-client.ts';
import type { PinnedExternalServer } from './extensions.ts';
import { createPrivateDirectory, writeNewPrivateFileSync } from './private-storage.ts';
import { acquireLocalLock, DesktopError, type DesktopErrorCode } from './desktop-control.ts';
import { freeCadFileBytes, freeCadMime, freeCadNames, freeCadSpec, freeCadVerificationName, freeCadWorkerTimeout,
  type FreeCadAdapter, type FreeCadSpec } from './freecad.ts';
import { runFreeCadWindow } from './freecad-window.ts';

type Scope = { readonly projectId: string; readonly sessionId: string };
type FileVersion = Scope & { readonly fileId: string; readonly versionId: string; readonly name: string };
export type McpGrant = FileVersion & { readonly id: string; readonly grantId: string; readonly mcpAlias?: string; readonly bytes: number; readonly sha256: string };
export type CsvJob = Scope & {
  readonly requestId: string; readonly taskId: string; readonly attemptId: string;
  readonly toolId: string; readonly grantId: string; readonly column?: string;
};
export type McpArtifact = Scope & {
  readonly id: string; readonly attemptId: string; readonly name: string; readonly mcpAlias?: string;
  readonly mimeType: 'application/json'; readonly bytes: number; readonly sha256: string;
  readonly receiptKind?: 'external-mcp-v1';
};
export type FreeCadArtifact = Scope & {
  readonly id: string; readonly attemptId: string; readonly taskId: string; readonly name: string;
  readonly mimeType: NonNullable<ReturnType<typeof freeCadMime>>; readonly bytes: number; readonly sha256: string;
  readonly receiptKind: 'freecad-v1';
};
export type FreeCadJob = Identity & {
  readonly adapter: FreeCadAdapter; readonly spec: FreeCadSpec;
  readonly source?: { readonly id: string; readonly versionId: string; readonly bytes: Uint8Array };
  readonly window?: { readonly checkModel: (signal: AbortSignal) => Promise<void>; readonly receiveImage: (png: Uint8Array) => void };
  readonly recovery?: { readonly attemptId: string; readonly route: 'api' | 'gui' };
};
type FreeCadExecution = {
  readonly spec: FreeCadSpec; readonly outputDirectory: string; readonly route: 'api' | 'gui' | 'recovery';
  readonly phase?: 'authoring' | 'window' | 'verification';
  readonly recoveryRequired?: boolean;
  readonly source?: { readonly id: string; readonly versionId: string };
  readonly recovery?: FreeCadJob['recovery'];
  readonly outcome?: 'verified' | 'invalid_result' | DesktopErrorCode;
};
type JobErrorCode = 'INVALID_INPUT' | 'CLOSED' | 'QUEUE_FULL' | 'DUPLICATE_ATTEMPT'
  | 'GRANT_DENIED' | 'ARTIFACT_DENIED' | 'INVALID_FILE' | 'UNSUPPORTED_PLATFORM';

export class CsvJobError extends Error {
  readonly name = 'CsvJobError';
  readonly code: JobErrorCode;
  constructor(code: JobErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

// Preserve the public CSV API and on-disk namespace used by older hosts.
export { MCP_LIMITS, MCP_LIMITS as CSV_LIMITS };
const runtimeFile = (name:string) => fileURLToPath(new URL(name, import.meta.url));
const ENV = Object.freeze({ LANG: 'C', LC_ALL: 'C', TZ: 'UTC' });
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const sameScope = (a: Scope, b: Scope) => a.projectId === b.projectId && a.sessionId === b.sessionId;
const attemptKey = (job: Scope & { readonly attemptId: string }) => sha256(JSON.stringify([job.projectId, job.sessionId, job.attemptId]));
const errorCode = (error: unknown) => error instanceof Error && 'code' in error ? error.code : undefined;
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function text(value: unknown, label: string, limit = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || Buffer.byteLength(value) > limit) {
    throw new CsvJobError('INVALID_INPUT', `Invalid ${label}.`);
  }
  return value;
}

async function privateDirectory(path: string): Promise<string> {
  try { createPrivateDirectory(path); }
  catch (cause) { throw new CsvJobError('INVALID_FILE', 'Job storage must be a private directory owned by the host process.', { cause }); }
  const st = await lstat(path);
  if (!st.isDirectory()) {
    throw new CsvJobError('INVALID_FILE', 'Job storage must be a private directory owned by the host process.');
  }
  return realpath(path);
}

async function readBounded(directory: string, name: string, limit: number): Promise<Buffer> {
  // All paths below the private root use fixed names and generated/digested IDs.
  if (await realpath(directory) !== directory) throw new CsvJobError('INVALID_FILE', 'Job storage path changed.');
  const path = join(directory, name);
  const before = await lstat(path);
  if (!before.isFile()) throw new CsvJobError('INVALID_FILE', 'Invalid job file.');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = await file.stat();
    if (!st.isFile() || st.nlink !== 1 || st.dev !== before.dev || st.ino !== before.ino || st.size > limit) throw new CsvJobError('INVALID_FILE', 'Invalid job file.');
    const buffer = Buffer.allocUnsafe(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size !== st.size || size > limit) throw new CsvJobError('INVALID_FILE', 'Job file changed or exceeded its limit.');
    return buffer.subarray(0, size);
  } finally {
    await file.close();
  }
}

function parseGrant(bytes: Buffer, grantId: string, scope: Scope): McpGrant {
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (!object(value) || value.id !== grantId || value.grantId !== grantId || value.projectId !== scope.projectId
    || value.sessionId !== scope.sessionId || typeof value.fileId !== 'string' || typeof value.versionId !== 'string'
    || typeof value.name !== 'string' || typeof value.bytes !== 'number' || !Number.isSafeInteger(value.bytes)
    || value.bytes < 1 || value.bytes > MCP_LIMITS.inputBytes || typeof value.sha256 !== 'string' || !SHA256.test(value.sha256)) {
    throw new CsvJobError('GRANT_DENIED', 'MCP input grant is unavailable to this project and session.');
  }
  if (value.mcpAlias !== undefined && typeof value.mcpAlias !== 'string') throw new CsvJobError('GRANT_DENIED','Invalid grant registration.');
  return { ...scope, id: grantId, grantId, mcpAlias: value.mcpAlias, fileId: value.fileId, versionId: value.versionId, name: value.name, bytes: value.bytes, sha256: value.sha256 };
}

type Identity = Omit<CsvJob,'grantId'|'column'>;
export type ExternalMcpJob = Identity & {readonly server:PinnedExternalServer;readonly tool:string;readonly arguments:Readonly<Record<string,unknown>>;readonly token?:string};
export type AnalysisJob = Identity & SandboxJob & { readonly inputs: readonly (AnalysisSnapshot & {readonly fileId?:string; readonly versionId?:string})[] };
export type JobAttempt = Identity & { readonly grantId?: string; readonly column?: string;
  readonly mcp?: { readonly server:string; readonly version:string; readonly protocol:string; readonly tool:string; readonly phase:McpPhase;
    readonly alias?:string; readonly resultKind?:string; readonly displayName?:string; readonly registryVersion?:number };
  readonly toolArguments?: Readonly<Record<string,unknown>>;
  readonly externalMcp?: {readonly serverId:string;readonly pluginId:string;readonly pluginRevision:string;readonly verificationDigest:string;readonly url:string;readonly tool:string;readonly argumentDigest:string};
  readonly artifacts?: readonly (AnalysisArtifact | FreeCadArtifact)[]; readonly containerId?: string; readonly executionId?: string;
  readonly freecad?: FreeCadExecution;
  readonly analysis?: { readonly language: SandboxJob['language']; readonly script: string; readonly outputs: readonly string[];
    readonly inputs: readonly {readonly name:string; readonly sha256:string; readonly fileId?:string; readonly versionId?:string}[];
    readonly limits: Readonly<Record<string, number>>; readonly imageId?:string; readonly version?:string; readonly backend?: 'wasi'; readonly engine?: string };

  readonly status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted';
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string | null;
  readonly env: Readonly<Record<string, string>>;
  readonly limits: typeof MCP_LIMITS & { readonly timeoutMs: number };
  readonly pid: number | null;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly cancellation: 'not_requested' | 'confirmed' | 'unknown';
  readonly stdout: string;
  readonly stderr: string;
  readonly grant?: McpGrant;
  readonly artifact?: McpArtifact;
  readonly error?: string;
};

export type JobEvent =
  | { readonly type: 'process_queued' | 'process_started' | 'process_finished'; readonly attempt: JobAttempt }
  | { readonly type: 'process_output'; readonly attempt: JobAttempt; readonly stream: 'stdout' | 'stderr'; readonly text: string };

export type JobRunnerOptions = {
  readonly dataDir: string;
  readonly concurrency?: number;
  readonly timeoutMs?: number;
  // Admission and completion receipts must be persisted synchronously and atomically.
  readonly onEvent?: (event: JobEvent) => void;
  readonly recoveredAttempts?: readonly JobAttempt[];
};

type StopReason = 'cancelled' | 'timed_out' | 'output_limit';
type JobHandle<T extends JobAttempt = JobAttempt> = { readonly result: Promise<T>; cancel(): void };
type AnalysisAttempt = JobAttempt & { readonly artifacts?: readonly AnalysisArtifact[] };
type Pending = {
  cancelBeforePublication?: boolean;
  attempt: JobAttempt;
  readonly analysis?: SandboxJob;
  readonly registration?: Registration;
  readonly external?: Pick<ExternalMcpJob,'server'|'tool'|'arguments'|'token'>;
  readonly freecad?: FreeCadJob;
  readonly result: Promise<JobAttempt>;
  readonly resolve: (attempt: JobAttempt) => void;
  stop?: StopReason;
  terminate?: () => void;
  exited?: boolean;
};

type ProcessResult = {
  readonly outputDigest?: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly termination: 'not_requested' | 'confirmed' | 'unknown';
  readonly stop?: StopReason;
  readonly error?: string;
};

function boundedInt(value: number | undefined, fallback: number, limit: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > limit) {
    throw new CsvJobError('INVALID_INPUT', `Invalid ${label}; expected 1 to ${limit}.`);
  }
  return selected;
}

/** Only this host's live child handle can request a group signal. */
export class JobRunner {
  readonly #dataDir: string;
  readonly #directory: string;
  readonly #files: AnalysisFiles;
  #discovery?: Promise<AnalysisAccess>;
  readonly #concurrency: number;
  readonly #limits: JobAttempt['limits'];
  readonly #observer: JobRunnerOptions['onEvent'];
  readonly #queue: Pending[] = [];
  readonly #active = new Set<Pending>();
  readonly #known = new Set<string>();
  #admitting = 0;
  #closed = false;
  #halted = false;
  #closePromise?: Promise<void>;

  constructor(options: JobRunnerOptions) {
    if (process.release.name !== 'node' || !['darwin', 'linux', 'win32'].includes(process.platform) || Number(process.versions.node.split('.')[0]) < 24) {
      throw new CsvJobError('UNSUPPORTED_PLATFORM', 'Job execution requires Node 24+ on macOS, Windows or Linux.');
    }
    this.#dataDir = resolve(options.dataDir);
    this.#directory = join(this.#dataDir, 'csv-jobs');
    this.#files = new AnalysisFiles(options.dataDir);
    this.#concurrency = boundedInt(options.concurrency, 1, MCP_LIMITS.maxConcurrency, 'job concurrency');
    this.#limits = Object.freeze({ ...MCP_LIMITS, timeoutMs: boundedInt(options.timeoutMs, 5_000, MCP_LIMITS.maxTimeoutMs, 'job timeout') });
    this.#observer = options.onEvent;
    for (const prior of options.recoveredAttempts ?? []) {
      const key = attemptKey(prior);
      if (this.#known.has(key)) continue;
      this.#known.add(key);
      if (prior.status === 'running' || prior.status === 'queued') {
        const attempt: JobAttempt = Object.freeze({ ...prior, status: 'interrupted', endedAt: Date.now(),
          exitCode: null, signal: null, cancellation: 'unknown', artifact: undefined, artifacts: undefined,
          ...(prior.freecad ? { freecad: { ...prior.freecad, outcome: 'indeterminate' as const } } : {}),
          error: 'Host restarted before the process attempt settled. Process termination was not observed; the attempt will not rerun.' });
        queueMicrotask(() => this.#emit({ type: 'process_finished', attempt }));
      }
    }
  }

  async grant(input: FileVersion & { readonly bytes: Uint8Array }, alias: string = csvRegistration.binding.identity.alias): Promise<McpGrant> {
    this.#assertOpen();
    const fields = { projectId: text(input.projectId, 'project ID'), sessionId: text(input.sessionId, 'session ID'),
      fileId: text(input.fileId, 'file ID'), versionId: text(input.versionId, 'version ID'), name: text(input.name, 'file name') };
    const entry = builtins.get(alias);
    if (!entry || !entry.acceptsFile(fields.name)) throw new CsvJobError('GRANT_DENIED','Input file does not match the registered tool.');
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength < 1 || input.bytes.byteLength > entry.binding.inputBytes) {
      throw new CsvJobError('INVALID_INPUT', 'Input exceeds the registered file bounds.');
    }
    const bytes = Buffer.from(input.bytes);
    const id = randomUUID();
    const grant: McpGrant = Object.freeze({ ...fields, id, grantId: id, mcpAlias:alias, bytes: bytes.length, sha256: sha256(bytes) });
    const directory = join(await this.#root('grants'), id);
    this.#assertOpen();
    await mkdir(directory, { mode: 0o700 });
    try {
      await writeFile(join(directory, entry.binding.inputName), bytes, { flag: 'wx', mode: 0o400 });
      await writeFile(join(directory, 'grant.json'), JSON.stringify(grant), { flag: 'wx', mode: 0o400 });
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    return grant;
  }

  start(input: CsvJob): JobHandle {
    this.#assertOpen();
    return this.startMcp(csvRegistration.binding.identity.alias, input, input.column === undefined ? {} : {column:input.column});
  }

  startMcp(alias: string, input: Identity & {grantId:string}, args: Readonly<Record<string,unknown>> = {}): JobHandle {
    this.#assertOpen();
    const registration = builtins.get(alias);
    if (!registration) throw new CsvJobError('INVALID_INPUT','Unknown built-in MCP tool.');
    const {fileId, wire} = bindCall(registration,args);
    if (fileId !== undefined) throw new CsvJobError('INVALID_INPUT','Runner requires an already resolved grant.');
    const job = {
      projectId: text(input.projectId, 'project ID'), sessionId: text(input.sessionId, 'session ID'),
      requestId: text(input.requestId, 'request ID'), taskId: text(input.taskId, 'task ID'),
      toolId: text(input.toolId, 'tool ID'), attemptId: text(input.attemptId, 'attempt ID'),
      grantId: text(input.grantId, 'grant ID'),
      toolArguments: Object.freeze(wire),
    };
    if (!UUID.test(job.grantId)) throw new CsvJobError('GRANT_DENIED', 'Invalid MCP grant ID.');
    return this.#admit(job, undefined, registration);
  }

  startExternal(input:ExternalMcpJob):JobHandle {
    this.#assertOpen();
    const server=structuredClone(input.server);
    validateExternalVerification(server.definition,server.verification);
    const tool=server.verification.tools.find(item=>item.name===input.tool);
    if (!tool || !object(input.arguments) || !matchesExternalSchema(tool.inputSchema,input.arguments)) throw new CsvJobError('INVALID_INPUT','External MCP arguments do not match the pinned tool.');
    const args=structuredClone(input.arguments);
    const job={projectId:text(input.projectId,'project ID'),sessionId:text(input.sessionId,'session ID'),
      requestId:text(input.requestId,'request ID'),taskId:text(input.taskId,'task ID'),toolId:text(input.toolId,'tool ID'),attemptId:text(input.attemptId,'attempt ID'),
      externalMcp:{serverId:server.id,pluginId:server.pluginId,pluginRevision:server.pluginRevision,verificationDigest:server.verification.digest,url:server.definition.url,tool:input.tool,argumentDigest:extensionDigest(args)}};
    // The secret is kept only on the live private handle. No credential, auth
    // reference or remote session token enters process events or stored output.
    return this.#admit(job,undefined,undefined,{server,tool:input.tool,arguments:args,token:input.token});
  }

  analysisAccess(): Promise<AnalysisAccess> {
    // Coalesce concurrent probes, including UI discovery while admitting an execution.
    return this.#discovery ??= analysisAccess().finally(() => {this.#discovery = undefined;});
  }

  startAnalysis(input: AnalysisJob): JobHandle<AnalysisAttempt> {
    this.#assertOpen();
    const {language} = input;
    if (language !== 'node' && language !== 'python') throw new CsvJobError('INVALID_INPUT','Unsupported analysis language.');
    if (!Array.isArray(input.inputs) || input.inputs.length > ANALYSIS_LIMITS.maxFiles) throw new CsvJobError('INVALID_INPUT','Too many input files.');
    const names = validateOutputNames(input.inputs.map(f=>f.name));
    const outputs = validateOutputNames(input.outputs);
    const [scriptName] = validateOutputNames([input.script.name]);
    if (!scriptName || !(language === 'node' ? /\.(m?js|cjs)$/i : /\.py$/i).test(scriptName)) throw new CsvJobError('INVALID_INPUT','Script extension does not match interpreter.');
    const all = [scriptName,...names,...outputs].map(n=>n.toLowerCase());
    if (new Set(all).size !== all.length) throw new CsvJobError('INVALID_INPUT','Script, inputs and outputs must have distinct names.');
    let total=0;
    const snapshot = (f:AnalysisSnapshot) => {
      if (!(f.bytes instanceof Uint8Array) || f.bytes.length > ANALYSIS_LIMITS.fileBytes || (total+=f.bytes.length)>ANALYSIS_LIMITS.snapshotBytes) throw new CsvJobError('INVALID_INPUT','Analysis snapshot exceeds limit.');
      return {name:f.name,bytes:Buffer.from(f.bytes)};
    };
    if (input.args !== undefined && (!Array.isArray(input.args) || input.args.length>ANALYSIS_LIMITS.maxArgs)) throw new CsvJobError('INVALID_INPUT','Invalid script arguments.');
    const args = Object.freeze(Array.from(input.args ?? [],arg=>{
      if (typeof arg!=='string' || arg.includes('\0') || Buffer.byteLength(arg)>ANALYSIS_LIMITS.argBytes) throw new CsvJobError('INVALID_INPUT','Invalid script argument.');
      return arg;
    }));
    const script=snapshot(input.script), inputs=input.inputs.map(snapshot);
    const receipts = inputs.map((f,i)=>{
      const prior=input.inputs[i];
      return Object.freeze({name:f.name,sha256:sha256(f.bytes),...(prior?.fileId!==undefined || prior?.versionId!==undefined ?
        {fileId:text(prior.fileId,'file ID'),versionId:text(prior.versionId,'version ID')}:{})});
    });
    const job = {projectId:text(input.projectId,'project ID'),sessionId:text(input.sessionId,'session ID'),taskId:text(input.taskId,'task ID'),
      requestId:text(input.requestId,'request ID'),attemptId:text(input.attemptId,'attempt ID'),toolId:text(input.toolId,'tool ID'),
      analysis:Object.freeze({language,script:script.name,inputs:Object.freeze(receipts),outputs,limits:ANALYSIS_LIMITS}),args};
    return this.#admit(job,{language,script,inputs,outputs,args}) as JobHandle<AnalysisAttempt>;
  }

  freeCadOutputRoot(projectId: string): string {
    if (!UUID.test(projectId)) throw new CsvJobError('INVALID_INPUT', 'Invalid FreeCAD project ID.');
    return join(this.#dataDir, 'projects', projectId, 'cad');
  }

  startFreeCad(input: FreeCadJob): JobHandle {
    this.#assertOpen();
    const spec = freeCadSpec(input.spec);
    const { projectId, sessionId, taskId, attemptId, toolId, requestId, source } = input;
    const recovery = input.recovery;
    if (!UUID.test(attemptId) || (recovery && (!UUID.test(recovery.attemptId) || source || input.window)) ||
      (!recovery && Boolean(spec.sourceArtifactId) !== Boolean(source)) ||
      (source && (source.id !== spec.sourceArtifactId || source.bytes.byteLength < 1 || source.bytes.byteLength > freeCadFileBytes))) {
      throw new CsvJobError('INVALID_INPUT', 'Invalid FreeCAD job or source artifact.');
    }
    const freecad: FreeCadExecution = { spec,
      outputDirectory: join(this.freeCadOutputRoot(projectId), spec.name.toLowerCase(), recovery?.attemptId ?? attemptId),
      route: recovery ? 'recovery' : 'api', ...(recovery ? { recovery } : {}),
      ...(source ? { source: { id: source.id, versionId: source.versionId } } : {}) };
    return this.#admit({ projectId, sessionId, taskId, attemptId, toolId, requestId, freecad },
      undefined, undefined, undefined, { ...input, spec });
  }

  #admit(job: Identity & Partial<Pick<JobAttempt,'grantId'|'column'|'analysis'|'args'|'toolArguments'|'externalMcp'|'freecad'>>, analysis?: SandboxJob, registration?: Registration, external?:Pending['external'], freecad?: FreeCadJob):JobHandle {
    const key = attemptKey(job);
    if (this.#known.has(key)) throw new CsvJobError('DUPLICATE_ATTEMPT', 'Job attempt IDs cannot be reused.');
    if (this.#queue.length >= MCP_LIMITS.queue) throw new CsvJobError('QUEUE_FULL', 'The job queue is full.');
    this.#known.add(key);
    const { promise: result, resolve } = Promise.withResolvers<JobAttempt>();
    const externalIdentity=external ? {registryVersion:1,server:external.server.verification.serverInfo.name,displayName:external.server.definition.name,
      version:external.server.verification.serverInfo.version,protocol:external.server.verification.protocolVersion,tool:external.tool,
      alias:'external:'+external.server.id+':'+external.tool,resultKind:'mcp-result',phase:'initialize' as const} : undefined;
    const pending: Pending = { result, resolve, analysis, registration, external, freecad, attempt: Object.freeze({ ...job,
      ...(externalIdentity ? {mcp:externalIdentity} : registration ? { mcp: { ...registration.binding.identity, phase: 'initialize' as const } } : {}),
      program: freecad ? 'FreeCAD' : external ? 'External MCP' : analysis ? analysis.language : process.execPath, args: job.args ?? Object.freeze([]),
      cwd: null, env: external || freecad ? {} : analysis ? analysisEnv : ENV,
      limits: freecad ? { ...this.#limits, artifactBytes: freeCadFileBytes, timeoutMs: freeCadWorkerTimeout }
        : external ? {...this.#limits,artifactBytes:EXTERNAL_MCP_LIMITS.responseBytes+16*1024,timeoutMs:external.server.definition.timeoutMs ?? 10000} : this.#limits, pid: null, status: 'queued', startedAt: null, endedAt: null,
      exitCode: null, signal: null, cancellation: 'not_requested', stdout: '', stderr: '' }) };
    this.#queue.push(pending);
    this.#admitting++;
    try {
      // Admission is the host's synchronous persistence boundary. A failed
      // observer may have already written the receipt; keep the ID reserved.
      this.#observer?.({ type: 'process_queued', attempt: pending.attempt });
    } catch (error) {
      const index = this.#queue.indexOf(pending);
      if (index >= 0) this.#queue.splice(index, 1);
      throw error;
    } finally {
      this.#admitting--;
      this.#drain();
    }
    return { result, cancel: () => this.#stop(pending, 'cancelled') };
  }

  /** Only persisted, session-authorized artifact records should reach the runner. */
  async download(artifact: McpArtifact | FreeCadArtifact): Promise<Buffer> {
    if (artifact.receiptKind === 'freecad-v1') return this.#downloadFreeCad(artifact);
    const { id, projectId, sessionId, attemptId, bytes, sha256: digest } = artifact;
    // External outputs have a self-contained immutable receipt. A plugin may
    // be updated or removed after publication without breaking past downloads.
    const binding = artifact.receiptKind==='external-mcp-v1'
      ? {outputName:'mcp-result.json',mimeType:'application/json',outputBytes:EXTERNAL_MCP_LIMITS.responseBytes+16*1024}
      : builtins.get(artifact.mcpAlias ?? csvRegistration.binding.identity.alias)?.binding;
    if (artifact.receiptKind !== undefined && artifact.receiptKind !== 'external-mcp-v1') throw new CsvJobError('ARTIFACT_DENIED','Unknown artifact receipt format.');
    if (!binding || !UUID.test(id) || !SHA256.test(digest) || artifact.name !== binding.outputName || artifact.mimeType !== binding.mimeType
      || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > binding.outputBytes) {
      throw new CsvJobError('ARTIFACT_DENIED', 'Invalid MCP artifact reference.');
    }
    try {
      const directory = join(await this.#root('attempts'), attemptKey({ projectId, sessionId, attemptId }));
      const receipt: unknown = JSON.parse((await readBounded(directory, 'artifact.json', 8 * 1024)).toString('utf8'));
      if (!object(receipt) || receipt.id !== id || receipt.projectId !== projectId || receipt.sessionId !== sessionId
        || receipt.attemptId !== attemptId || receipt.bytes !== bytes || receipt.sha256 !== digest
        || receipt.mcpAlias !== artifact.mcpAlias || receipt.name !== artifact.name || receipt.mimeType !== artifact.mimeType || receipt.receiptKind !== artifact.receiptKind) {
        throw new CsvJobError('ARTIFACT_DENIED', 'MCP artifact reference does not match its receipt.');
      }
      const content = await readBounded(directory, binding.outputName, binding.outputBytes);
      if (content.length !== bytes || sha256(content) !== digest) throw new CsvJobError('ARTIFACT_DENIED', 'MCP artifact failed verification.');
      return content;
    } catch (error) {
      if (error instanceof CsvJobError && error.code === 'ARTIFACT_DENIED') throw error;
      throw new CsvJobError('ARTIFACT_DENIED', 'MCP artifact is unreadable or failed verification.', { cause: error });
    }
  }

  async #downloadFreeCad(artifact: FreeCadArtifact) {
    const { id, bytes, sha256: digest, name, mimeType } = artifact;
    if (!UUID.test(id) || !SHA256.test(digest) || freeCadMime(name) !== mimeType ||
      !Number.isSafeInteger(bytes) || bytes < 1 || bytes > freeCadFileBytes) {
      throw new CsvJobError('ARTIFACT_DENIED', 'Invalid FreeCAD artifact reference.');
    }
    try {
      const directory = join(await this.#root('attempts'), attemptKey(artifact));
      const receipt: unknown = JSON.parse((await readBounded(directory, id + '.json', 8192)).toString('utf8'));
      if (!object(receipt) || Object.entries(artifact).some(([key, value]) => receipt[key] !== value)) {
        throw new Error('The FreeCAD receipt did not match the artifact.');
      }
      const content = await readBounded(directory, id + '.bin', freeCadFileBytes);
      if (content.length !== bytes || sha256(content) !== digest) throw new Error('The FreeCAD artifact digest changed.');
      return content;
    } catch (cause) {
      throw new CsvJobError('ARTIFACT_DENIED', 'The FreeCAD artifact failed receipt verification.', { cause });
    }
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    const jobs = [...this.#queue, ...this.#active];
    this.#closePromise = Promise.all(jobs.map(job => job.result)).then(() => {});
    for (const job of jobs) this.#stop(job, 'cancelled');
    return this.#closePromise;
  }

  #root(kind: 'grants' | 'attempts'): Promise<string> {
    return privateDirectory(this.#directory).then(root => privateDirectory(join(root, kind)));
  }

  #assertOpen(): void {
    if (this.#closed || this.#halted) throw new CsvJobError('CLOSED', 'The job runner is not accepting work.');
  }

  #emit(event: JobEvent): void {
    try {
      this.#observer?.(event);
    } catch (error) {
      process.emitWarning('The job event observer failed.', { code: 'CSV_OBSERVER_FAILED', detail: error instanceof Error ? error.message : String(error) });
    }
  }

  #finish(pending: Pending, result: Partial<JobAttempt> & { readonly status: JobAttempt['status'] }): void {
    let attempt: JobAttempt = Object.freeze({ ...pending.attempt, ...result, endedAt: Date.now() });
    let haltQueue = false;
    pending.terminate = undefined;
    pending.attempt = attempt;
    try {
      // Completion publishes artifacts in the same transaction as the terminal
      // process record. A computed file alone is not a successful publication.
      this.#observer?.({ type: 'process_finished', attempt });
    } catch {
      attempt = Object.freeze({ ...attempt, status: 'failed', artifact: undefined, artifacts: undefined,
        error: 'Could not persist process completion. Result artifacts were not published.' });
      pending.attempt = attempt;
      try {
        this.#observer?.({ type: 'process_finished', attempt });
      } catch (error) {
        // Never leave promises or queued work waiting on an unavailable store.
        haltQueue = !this.#halted;
        this.#halted = true;
        process.emitWarning('The failed process completion could not be persisted.', {
          code: 'CSV_COMPLETION_PERSIST_FAILED', detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.#active.delete(pending);
    pending.resolve(attempt);
    if (haltQueue) for (const queued of [...this.#queue]) this.#stop(queued, 'cancelled');
    this.#drain();
  }

  #stop(pending: Pending, reason: StopReason): void {
    if (pending.stop || pending.attempt.endedAt !== null) return;
    if (pending.exited && reason !== 'output_limit') {
      // A clean worker exit can precede asynchronous verification and receipt persistence.
      if ((pending.registration || pending.external) && reason === 'cancelled') pending.cancelBeforePublication = true;
      return;
    }
    pending.stop = reason;
    const index = this.#queue.indexOf(pending);
    if (index >= 0) {
      this.#queue.splice(index, 1);
      this.#finish(pending, { status: 'cancelled', cancellation: 'confirmed' });
    } else {
      pending.terminate?.();
    }
  }

  #drain(): void {
    while (!this.#closed && !this.#halted && !this.#admitting && this.#active.size < this.#concurrency) {
      const pending = this.#queue.shift();
      if (!pending) break;
      this.#active.add(pending);
      void this.#run(pending);
    }
  }

  async #run(pending: Pending): Promise<void> {
    const job = pending.attempt;
    let processResult: ProcessResult | undefined;
    try {
      const cwd = join(await this.#root('attempts'), attemptKey(job));
      // An existing directory is an attempt receipt, even if a previous host crashed mid-write.
      await mkdir(cwd, { mode: 0o700 });
      if (pending.stop) {
        this.#finish(pending, { status: 'cancelled', cancellation: 'confirmed' });
        return;
      }
      if (pending.analysis) {
        await this.#runAnalysis(pending,pending.analysis,cwd);
        return;
      }
      if (pending.external) {
        await this.#runExternal(pending,pending.external,cwd);
        return;
      }
      if (pending.freecad) {
        await this.#runFreeCad(pending, pending.freecad, cwd);
        return;
      }
      const registration = pending.registration;
      if (!registration) throw new CsvJobError('INVALID_INPUT','Missing MCP registration.');
      const binding = registration.binding;
      if (!job.grantId) throw new CsvJobError('GRANT_DENIED','Missing MCP grant ID.');
      const grantDir = join(await this.#root('grants'), job.grantId);
      let grant: McpGrant;
      let bytes: Buffer;
      try {
        grant = parseGrant(await readBounded(grantDir, 'grant.json', 8 * 1024), job.grantId, {
          projectId: job.projectId, sessionId: job.sessionId,
        });
        if ((grant.mcpAlias ?? csvRegistration.binding.identity.alias) !== binding.identity.alias || !registration.acceptsFile(grant.name)) {
          throw new CsvJobError('GRANT_DENIED','Input grant belongs to a different tool.');
        }
        bytes = await readBounded(grantDir, binding.inputName, binding.inputBytes);
        if (bytes.length !== grant.bytes || sha256(bytes) !== grant.sha256) {
          throw new CsvJobError('GRANT_DENIED', 'MCP input failed grant verification.');
        }
      } catch (error) {
        if (error instanceof CsvJobError && error.code === 'GRANT_DENIED') throw error;
        throw new CsvJobError('GRANT_DENIED', 'MCP input grant is unavailable to this project and session.', { cause: error });
      }

      const inputPath = join(cwd, binding.inputName);
      const outputPath = join(cwd, binding.outputName);
      const worker = runtimeFile(binding.worker);
      const modules = [worker, runtimeFile('mcp-contract.mjs'), runtimeFile('mcp-worker.mjs')];
      const args = Object.freeze([
        '--permission', ...modules.map(path => `--allow-fs-read=${path}`), `--allow-fs-read=${inputPath}`, `--allow-fs-write=${outputPath}`,
        `--max-old-space-size=${MCP_LIMITS.heapMiB}`, '--disallow-code-generation-from-strings', '--no-addons',
        '--', worker,
      ]);
      await writeFile(inputPath, bytes, { flag: 'wx', mode: 0o400 });
      if (pending.stop) {
        this.#finish(pending, { status: 'cancelled', cancellation: 'confirmed' });
        return;
      }
      pending.attempt = Object.freeze({ ...pending.attempt, cwd, args, grant });
      processResult = await this.#execute(pending, cwd, args, registration);
      const { exitCode, signal, termination, stop, error } = processResult;
      const exit = { exitCode, signal, cancellation: termination };
      if (termination === 'unknown') {
        // Do not refill a slot when the old process might still exist.
        this.#halted = true;
        for (const queued of [...this.#queue]) this.#stop(queued, 'cancelled');
      }
      switch (stop) {
        case 'cancelled': case 'timed_out':
          this.#finish(pending, { ...exit, status: stop,
            error: stop === 'timed_out' ? 'MCP process exceeded its time limit.' : undefined });
          return;
        case 'output_limit':
          this.#finish(pending, { ...exit, status: 'failed', error: 'MCP process exceeded a stdout or stderr byte limit.' });
          return;
        case undefined:
          break;
      }
      if (exitCode !== 0 || signal !== null || error) {
        this.#finish(pending, { ...exit, status: 'failed', error: error ?? 'MCP process did not exit successfully.' });
        return;
      }
      const content = await readBounded(cwd, binding.outputName, binding.outputBytes);
      const digest = verifyMcpOutput(registration, content, processResult.outputDigest);
      const artifact: McpArtifact = Object.freeze({ id: randomUUID(), projectId: job.projectId, sessionId: job.sessionId,
        attemptId: job.attemptId, mcpAlias:binding.identity.alias, name: binding.outputName, mimeType: binding.mimeType, bytes: content.length, sha256: digest });
      await writeFile(join(cwd, 'artifact.json'), JSON.stringify(artifact), { flag: 'wx', mode: 0o400 });
      if (pending.cancelBeforePublication) {
        await rm(join(cwd, 'artifact.json'));
        this.#finish(pending, { ...exit, status: 'cancelled', cancellation: 'confirmed' });
        return;
      }
      this.#finish(pending, { ...exit, status: 'succeeded', artifact });
    } catch (error) {
      if (!processResult && pending.stop) {
        this.#finish(pending, { status: 'cancelled', cancellation: 'confirmed' });
      } else {
        this.#finish(pending, { status: 'failed', exitCode: processResult?.exitCode ?? null, signal: processResult?.signal ?? null,
          error: error instanceof Error ? error.message : 'Job attempt failed.' });
      }
    }
  }

  async #runExternal(pending:Pending,external:NonNullable<Pending['external']>,cwd:string):Promise<void> {
    const ctl=new AbortController();
    pending.terminate=()=>ctl.abort();
    let dispatched=false;
    const timeout=setTimeout(()=>this.#stop(pending,'timed_out'),pending.attempt.limits.timeoutMs);
    try {
      if (pending.stop) ctl.abort();
      ctl.signal.throwIfAborted();
      pending.attempt=Object.freeze({...pending.attempt,status:'running',startedAt:Date.now()});
      this.#emit({type:'process_started',attempt:pending.attempt});
      const result=await callExternalMcp(external.server.definition,external.server.verification,external.tool,external.arguments,{
        token:external.token,signal:ctl.signal,onPhase:phase=>{
          if (phase==='tools/call') dispatched=true;
          pending.attempt=Object.freeze({...pending.attempt,mcp:{...pending.attempt.mcp!,phase}});
          this.#emit({type:'process_output',attempt:pending.attempt,stream:'stdout',text:'MCP '+phase+'\n'});
        },
      });
      ctl.signal.throwIfAborted();
      pending.exited=true;
      const server=external.server;
      const content=Buffer.from(JSON.stringify({schemaVersion:1,kind:'external-mcp-result',
        server:{id:server.id,name:server.verification.serverInfo.name,version:server.verification.serverInfo.version,
          pluginId:server.pluginId,pluginRevision:server.pluginRevision,verificationDigest:server.verification.digest},tool:external.tool,result}));
      if (content.length>pending.attempt.limits.artifactBytes) throw new Error('External MCP result exceeds the saved artifact limit.');
      const artifact:McpArtifact={id:randomUUID(),projectId:pending.attempt.projectId,sessionId:pending.attempt.sessionId,
        attemptId:pending.attempt.attemptId,mcpAlias:pending.attempt.mcp!.alias,receiptKind:'external-mcp-v1',name:'mcp-result.json',mimeType:'application/json',bytes:content.length,sha256:sha256(content)};
      await writeFile(join(cwd,artifact.name),content,{flag:'wx',mode:0o400});
      await writeFile(join(cwd,'artifact.json'),JSON.stringify(artifact),{flag:'wx',mode:0o400});
      if (pending.cancelBeforePublication || pending.stop || ctl.signal.aborted) {
        await rm(join(cwd,'artifact.json'));
        this.#finish(pending,{status:pending.stop==='timed_out'?'timed_out':'cancelled',cancellation:'unknown',error:'Result publication was cancelled. Remote completion cannot be confirmed.'});
        return;
      }
      this.#finish(pending,{status:'succeeded',artifact});
    } catch(error) {
      const message=error instanceof Error ? error.message : 'External MCP call failed.';
      const safe=external.token ? message.replaceAll(external.token,'[redacted]') : message;
      const timedOut=pending.stop==='timed_out' || error instanceof Error && error.name==='TimeoutError';
      this.#finish(pending,{status:timedOut?'timed_out':pending.stop==='cancelled'?'cancelled':'failed',
        cancellation:pending.stop || timedOut ? dispatched?'unknown':'confirmed' : 'not_requested',
        error:pending.stop==='cancelled' ? dispatched?'Request cancelled locally. The external server may still have completed the operation.':undefined
          :timedOut?'External MCP call exceeded its time limit; it will not be replayed automatically.':safe});
    } finally { clearTimeout(timeout); }
  }

  async #runFreeCad(pending: Pending, job: FreeCadJob, receipts: string) {
    let execution = pending.attempt.freecad!;
    let workspace = execution.outputDirectory;
    const documentDir = join(workspace, '..');
    const marker = join(documentDir, 'pending.json');
    const writer = { lock: join(documentDir, 'writer.sqlite'), marker, attemptId: job.attemptId };
    const holdWriter = () => acquireLocalLock(documentDir, 'writer.sqlite', 'The previous FreeCAD writer is still active.');
    const names = freeCadNames(job.spec);
    const abort = new AbortController();
    pending.terminate = () => abort.abort(new DesktopError('stopped', 'The FreeCAD task was stopped.'));
    const waitForWriter = async () => {
      const until = Date.now() + 5_000;
      for (;;) {
        abort.signal.throwIfAborted();
        try { return holdWriter(); }
        catch (cause) {
          if (!(cause instanceof DesktopError) || cause.code !== 'busy' || Date.now() >= until) throw cause;
          await sleep(40, undefined, { signal: abort.signal });
        }
      }
    };
    const log = (message: string) => this.#emit({ type: 'process_output', attempt: pending.attempt, stream: 'stdout', text: message });
    const phase = (value: FreeCadExecution['phase'], route = execution.route) => {
      execution = { ...execution, phase: value, route };
      pending.attempt = Object.freeze({ ...pending.attempt, freecad: execution });
    };
    const started = (pid: number) => {
      pending.attempt = Object.freeze({ ...pending.attempt, pid });
      this.#emit({ type: 'process_started', attempt: pending.attempt });
    };
    let release: (() => void) | undefined;
    let releaseWriter: (() => void) | undefined;
    let marked = false;
    let writeStarted = false;
    try {
      release = acquireLocalLock(documentDir, 'document.sqlite', 'This FreeCAD document already has a writer.');
      if (job.recovery) {
        const bytes = await readBounded(await realpath(documentDir), 'pending.json', 8192).catch(cause => {
          if (errorCode(cause) === 'ENOENT') throw new DesktopError('failed', 'This FreeCAD attempt no longer needs a recovery check.');
          throw cause;
        });
        const saved: unknown = JSON.parse(bytes.toString('utf8'));
        if (!object(saved) || saved.attemptId !== job.recovery.attemptId || saved.projectId !== job.projectId ||
          saved.sessionId !== job.sessionId || JSON.stringify(saved.spec) !== JSON.stringify(job.spec)) {
          throw new DesktopError('denied', 'The pending FreeCAD result belongs to a different attempt.');
        }
        execution = { ...execution, recoveryRequired: true };
      } else if (existsSync(marker)) {
        throw new DesktopError('indeterminate', 'An earlier FreeCAD write needs a result check before another write to this document.');
      }
      releaseWriter = await waitForWriter();
      workspace = job.recovery ? await realpath(workspace) : await privateDirectory(workspace);
      if (pending.stop) pending.terminate();
      abort.signal.throwIfAborted();
      pending.attempt = Object.freeze({ ...pending.attempt, status: 'running', cwd: workspace, startedAt: Date.now() });
      this.#emit({ type: 'process_started', attempt: pending.attempt });
      let authorVersion: string | undefined;
      let image: Uint8Array | undefined;
      if (!job.recovery) {
        if (job.source) writeNewPrivateFileSync(join(workspace, '.athena-source.FCStd'), job.source.bytes);
        execution = { ...execution, recoveryRequired: true };
        phase('authoring');
        log(job.source ? 'Editing the verified source through the FreeCAD API.' : 'Creating the part through the FreeCAD API.');
        abort.signal.throwIfAborted();
        writeNewPrivateFileSync(marker, JSON.stringify({ projectId: job.projectId, sessionId: job.sessionId, attemptId: job.attemptId, spec: job.spec }), { flush: true });
        marked = true;
        releaseWriter();
        releaseWriter = undefined;
        const writing = (pid: number) => { writeStarted = true; started(pid); };
        try {
          authorVersion = (await job.adapter.author(workspace, job.spec, abort.signal, writing, writer)).version;
        } catch (cause) {
          if (!(cause instanceof DesktopError) || cause.code !== 'unsupported' || !job.window ||
            names.some(name => existsSync(join(workspace, name)))) throw cause;
          writeStarted = false;
          const { app } = job.adapter.installation();
          if (!app) throw new DesktopError('unsupported', 'The FreeCAD GUI executable is unavailable.');
          log('The API authoring operation is unsupported. Checking model image input and tool calls.');
          await job.window.checkModel(abort.signal);
          abort.signal.throwIfAborted();
          phase('window', 'gui');
          const result = await runFreeCadWindow({ app, workspace, spec: job.spec, signal: abort.signal, writer, started: writing, log });
          authorVersion = result.version;
          image = result.png;
        }
      }
      abort.signal.throwIfAborted();
      // After a GUI return the app may still be releasing native control. Only
      // a settled writer can be followed by a read-only verifier.
      releaseWriter ??= await waitForWriter();
      phase('verification');
      const entries = (await readdir(workspace)).sort();
      const before = await Promise.all(names.map(name => readBounded(workspace, name, freeCadFileBytes))).catch(cause => {
        if (job.recovery && errorCode(cause) === 'ENOENT') {
          abort.signal.throwIfAborted();
          rmSync(marker);
          throw new DesktopError('invalid_result', 'A required output is missing. The existing files were preserved. A new attempt can use a separate output directory.');
        }
        throw cause;
      });
      const beforeInfo = await Promise.all(names.map(name => lstat(join(workspace, name), { bigint: true })));
      log('Reopening the FCStd and STEP with a read-only FreeCAD verifier.');
      let invalidResult: DesktopError | undefined;
      const verified = await job.adapter.verify(workspace, job.spec, abort.signal, started, receipts).catch(cause => {
        if (cause instanceof DesktopError && cause.code === 'invalid_result') { invalidResult = cause; return; }
        throw cause;
      });
      const after = await Promise.all(names.map(name => readBounded(workspace, name, freeCadFileBytes)));
      const afterInfo = await Promise.all(names.map(name => lstat(join(workspace, name), { bigint: true })));
      if (JSON.stringify(entries) !== JSON.stringify((await readdir(workspace)).sort()) ||
        before.some((file, index) => !file.equals(after[index]!) || beforeInfo[index]!.ino !== afterInfo[index]!.ino
          || beforeInfo[index]!.mtimeNs !== afterInfo[index]!.mtimeNs || beforeInfo[index]!.ctimeNs !== afterInfo[index]!.ctimeNs)) {
        throw new DesktopError('indeterminate', 'The scoped outputs changed during verification.');
      }
      if (invalidResult) {
        abort.signal.throwIfAborted();
        if (job.recovery) rmSync(marker);
        throw invalidResult;
      }
      if (!verified?.files || Object.keys(verified.files).length !== names.length ||
        !names.every(name => Object.hasOwn(verified.files!, name))) {
        throw new DesktopError('failed', 'FreeCAD did not return both verification receipts.');
      }
      const report = { app: 'FreeCAD', route: execution.route, recovery: job.recovery, authorVersion, verifierVersion: verified.version,
        spec: job.spec, source: execution.source, files: verified.files, readOnlyReopen: true,
        sha256: Object.fromEntries(names.map((name, index) => [name, sha256(before[index]!)])) };
      const files = [...names.map((name, index) => ({ name, bytes: before[index]! })),
        { name: freeCadVerificationName, bytes: Buffer.from(JSON.stringify(report, null, 2) + '\n') }];
      abort.signal.throwIfAborted();
      const artifacts = files.map(({ name, bytes }): FreeCadArtifact => {
        const artifact: FreeCadArtifact = { id: randomUUID(), projectId: job.projectId, sessionId: job.sessionId, taskId: job.taskId,
          attemptId: job.attemptId, name, mimeType: freeCadMime(name)!, bytes: bytes.length, sha256: sha256(bytes), receiptKind: 'freecad-v1' };
        writeNewPrivateFileSync(join(receipts, artifact.id + '.bin'), bytes, { flush: true });
        writeNewPrivateFileSync(join(receipts, artifact.id + '.json'), JSON.stringify(artifact), { flush: true });
        return artifact;
      });
      rmSync(marker);
      if (image) job.window?.receiveImage(image);
      log('Both files passed read-only geometry and unit verification.');
      this.#finish(pending, { status: 'succeeded', artifacts, exitCode: 0, freecad: { ...execution, outcome: 'verified', recoveryRequired: false } });
    } catch (cause) {
      const error = cause instanceof DesktopError ? cause
        : new DesktopError(errorCode(cause) === 'EACCES' || errorCode(cause) === 'EPERM' ? 'denied'
          : writeStarted ? 'indeterminate' : 'failed', 'The scoped FreeCAD operation did not complete.', { cause });
      if (marked && (!writeStarted || ((error.code === 'unsupported' || error.code === 'denied') &&
        !names.some(name => existsSync(join(workspace, name)))))) {
        try { rmSync(marker, { force: true }); }
        catch { log('The document recovery marker remains on disk.'); }
      }
      this.#finish(pending, { status: pending.stop ? 'cancelled' : 'failed', error: error.message,
        cancellation: pending.stop ? writeStarted ? 'unknown' : 'confirmed' : 'not_requested',
        freecad: { ...execution, outcome: pending.stop && writeStarted ? 'indeterminate' : error.code,
          recoveryRequired: Boolean((marked || execution.recoveryRequired && job.recovery) && existsSync(marker)) } });
    } finally {
      releaseWriter?.();
      release?.();
    }
  }

  async #runAnalysis(pending:Pending, job:SandboxJob, cwd:string):Promise<void> {
    const ctl=new AbortController();
    pending.terminate=()=>ctl.abort();
    let exitCode:number|null=null;
    let exitSignal:NodeJS.Signals|null=null;
    let cancellation:JobAttempt['cancellation']='not_requested';
    let artifacts:readonly AnalysisArtifact[]|undefined;
    let failure:string|undefined;
    try {
      const access=await this.analysisAccess();
      if (!access.available) throw new Error('Offline analysis unavailable: '+access.reason);
      ctl.signal.throwIfAborted();
      const meta=pending.attempt.analysis;
      if (!meta) throw new Error('Missing analysis metadata.');
      const program=access[job.language];
      pending.attempt=Object.freeze({...pending.attempt,cwd:'/workspace',program:program.path,
        args:Object.freeze(['/workspace/'+job.script.name,...job.args ?? []]),
        analysis:Object.freeze({...meta,backend:'wasi',engine:access.engine,version:program.version})});
      const result=await runSandbox({job,cwd,timeoutMs:this.#limits.timeoutMs,signal:ctl.signal,
        started:(id,pid)=>{pending.attempt=Object.freeze({...pending.attempt,status:'running',startedAt:Date.now(),executionId:id,pid});
          this.#emit({type:'process_started',attempt:pending.attempt});},
        output:(stream,text)=>{pending.attempt=Object.freeze({...pending.attempt,[stream]:pending.attempt[stream]+text});
          this.#emit({type:'process_output',attempt:pending.attempt,stream,text});},
        stop:reason=>this.#stop(pending,reason)});
      exitCode=result.exitCode;
      exitSignal=result.signal;
      // Unix may deliver the cumulative native CPU limit before the wall or
      // guest-epoch watchdog exits. It is still a confirmed execution timeout.
      if (exitSignal === 'SIGXCPU') this.#stop(pending,'timed_out');
      ctl.signal.throwIfAborted();
      pending.exited=true;
      const phase = result.started ? 'during analysis' : 'before the interpreter was ready';
      if (exitSignal) throw new Error(`Analysis process terminated by ${exitSignal} ${phase}.`);
      if (exitCode === 126) throw new Error('The sandbox exceeded its native memory limit or memory accounting failed.');
      if (!result.started) throw new Error(`Analysis process exited with code ${exitCode} ${phase}.`);
      if (exitCode !== 0) throw new Error(`Analysis interpreter returned ${exitCode}.`);
      const produced=await Promise.all(job.outputs.map(async name=>{
        const bytes=await readBounded(join(cwd,'outputs'),name,ANALYSIS_LIMITS.fileBytes).catch(error=>{
          if (errorCode(error)==='ENOENT') throw new Error('Declared output was not written: '+name);
          throw error;
        });
        return {name,bytes};
      }));
      await rm(join(cwd,'outputs'),{recursive:true,force:true}).catch(error=>{
        throw new SandboxCleanupError('Could not remove the analysis output scratch directory.', {cause:error});
      });
      artifacts=Object.freeze(await this.#files.publish(pending.attempt,job.outputs,produced,job.script));
    } catch(error) {
      failure=error instanceof Error ? error.message : 'Analysis execution failed.';
      if (error instanceof SandboxCleanupError) {
        cancellation='unknown'; this.#halted=true;
        for (const queued of [...this.#queue]) this.#stop(queued,'cancelled');
      } else if (pending.stop) cancellation='confirmed';
      if (!(error instanceof SandboxCleanupError)) {
        try { await rm(join(cwd,'outputs'),{recursive:true,force:true}); }
        catch (cleanupError) {
          if (!(cleanupError instanceof Error)) throw cleanupError;
          failure='Could not remove the analysis output scratch directory.';
          this.#halted=true;
          for (const queued of [...this.#queue]) this.#stop(queued,'cancelled');
        }
      }
    }
    const stop=pending.stop;
    const status=cancellation==='unknown' ? 'failed' : stop==='output_limit' ? 'failed' : stop ?? (failure ? 'failed' : 'succeeded');
    const timeoutError=pending.attempt.startedAt === null
      ? 'The analysis runtime did not become ready before its startup deadline.'
      : 'Analysis exceeded its time limit.';
    const error=cancellation==='unknown' ? failure : stop==='output_limit' ? 'Analysis exceeded its output limit.' :
      stop==='timed_out' ? timeoutError : stop==='cancelled' ? undefined : failure;
    this.#finish(pending,{status,exitCode,signal:exitSignal,artifacts,cancellation,error});
  }

  #execute(pending: Pending, cwd: string, args: readonly string[], registration:Registration): Promise<ProcessResult> {
    const child = spawn(pending.attempt.program, args, { cwd, env: ENV, shell: false,
      detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    return new Promise(resolveResult => {
      let ended = false;
      let signalled = false;
      let exitCode: number | null = null;
      let signal: NodeJS.Signals | null = null;
      let error: string | undefined;
      let stopTimer: ReturnType<typeof setTimeout> | undefined;
      const stdout = { size: 0, text: '', decoder: new StringDecoder('utf8') };
      const stderr = { size: 0, text: '', decoder: new StringDecoder('utf8') };

      const output = (stream: 'stdout' | 'stderr', text: string) => {
        if (text) this.#emit({ type: 'process_output', attempt: pending.attempt, stream, text });
      };
      const consume = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
        const sink = stream === 'stdout' ? stdout : stderr;
        const remaining = MCP_LIMITS.streamBytes - sink.size;
        const accepted = chunk.subarray(0, remaining);
        const fragment = sink.decoder.write(accepted);
        sink.size += accepted.length;
        sink.text += fragment;
        output(stream, fragment);
        if (chunk.length > remaining) {
          // The normal worker emits only short, fixed messages; protect both pipes even if it regresses.
          this.#stop(pending, 'output_limit');
        }
      };

      const client = mcpClient(child.stdin, registration, pending.attempt.toolId, pending.attempt.toolArguments ?? {}, phase => {
        pending.attempt = Object.freeze({ ...pending.attempt, mcp: { ...registration.binding.identity, phase } });
        consume('stdout', Buffer.from('MCP ' + phase + '\n'));
      });
      let wireBytes = 0;
      const wireDecoder = new StringDecoder('utf8');
      child.stdin.on('error', failure => { error ??= 'MCP input pipe closed: ' + failure.message; });
      const settle = () => {
        if (ended) return;
        ended = true;
        clearTimeout(timeout);
        clearTimeout(stopTimer);
        // Probe only this freshly spawned child's process group, and only after observing its exit.
        const pid = child.pid;
        let termination: ProcessResult['termination'] = pending.stop ? 'unknown' : 'not_requested';
        if (pending.stop && pid === undefined) termination = 'confirmed';
        if (pending.stop && pending.exited && pid !== undefined && (signalled || pending.stop === 'output_limit')) {
          // The permission-confined, fixed MCP worker cannot spawn children.
          // Windows has no POSIX process groups; observing its exit confirms
          // termination of this sole process, without PID-based tree killing.
          if (process.platform === 'win32') termination = 'confirmed';
          else try { process.kill(-pid, 0); } catch (failure) { if (errorCode(failure) === 'ESRCH') termination = 'confirmed'; }
        }
        for (const [stream, sink] of [['stdout', stdout], ['stderr', stderr]] as const) {
          const rest = sink.decoder.end();
          sink.text += rest;
          output(stream, rest);
        }
        pending.attempt = Object.freeze({ ...pending.attempt, stdout: stdout.text, stderr: stderr.text });
        const outputDigest = client.digest();
        if (!pending.stop && !error && !outputDigest) error = 'MCP server closed before a successful tools/call response.';
        resolveResult({ exitCode, signal, termination, stop: pending.stop, error, outputDigest });
      };

      const timeout = setTimeout(() => this.#stop(pending, 'timed_out'), this.#limits.timeoutMs);
      pending.terminate = () => {
        const pid = child.pid;
        if (pid !== undefined && !pending.exited && child.exitCode === null && child.signalCode === null) {
          try { signalled = process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-pid, 'SIGKILL'); } catch (failure) {
            if (errorCode(failure) !== 'ESRCH') error = 'Could not signal the live MCP process group.';
          }
        }
        stopTimer = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          settle();
        }, MCP_LIMITS.killWaitMs);
      };
      child.once('spawn', () => {
        pending.attempt = Object.freeze({ ...pending.attempt, status: 'running', pid: child.pid ?? null, startedAt: Date.now() });
        this.#emit({ type: 'process_started', attempt: pending.attempt });
        if (!pending.stop) client.initialize();
      });
      child.once('error', failure => { error = `MCP process failed to launch: ${failure.message}`; });
      child.once('exit', (code, terminatingSignal) => {
        pending.exited = true;
        exitCode = code;
        signal = terminatingSignal;
        if (!stopTimer) {
          clearTimeout(timeout);
          // The fixed worker cannot spawn children. Still bound pipe drain if that assumption is violated.
          stopTimer = setTimeout(() => {
            error = 'MCP process exited without closing its output pipes.';
            child.stdout.destroy();
            child.stderr.destroy();
            settle();
          }, MCP_LIMITS.killWaitMs);
        }
      });
      child.once('close', settle);
      child.stdout.on('data', (chunk: Buffer) => {
        if (error || pending.stop) return;
        wireBytes += chunk.length;
        if (wireBytes > MCP_LIMITS.streamBytes) { this.#stop(pending, 'output_limit'); return; }
        try { client.consume(wireDecoder.write(chunk)); }
        catch (failure) {
          error = failure instanceof Error ? failure.message : 'Invalid MCP response.';
          if (!client.finished) pending.terminate?.();
        }
      });
      child.stderr.on('data', chunk => consume('stderr', chunk));
    });
  }
}

export { JobRunner as CsvJobRunner };
export type { JobRunnerOptions as CsvJobRunnerOptions, JobEvent as CsvJobEvent,
  JobAttempt as CsvAttempt, McpArtifact as CsvArtifact, McpGrant as CsvGrant };
