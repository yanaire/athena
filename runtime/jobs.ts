import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

type Scope = { readonly projectId: string; readonly sessionId: string };
type FileVersion = Scope & { readonly fileId: string; readonly versionId: string; readonly name: string };
export type CsvGrant = FileVersion & { readonly id: string; readonly grantId: string; readonly bytes: number; readonly sha256: string };
export type CsvJob = Scope & {
  readonly requestId: string; readonly taskId: string; readonly attemptId: string;
  readonly toolId: string; readonly grantId: string; readonly column?: string;
};
export type CsvArtifact = Scope & {
  readonly id: string; readonly attemptId: string; readonly name: 'statistics.json';
  readonly mimeType: 'application/json'; readonly bytes: number; readonly sha256: string;
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

export const CSV_LIMITS = Object.freeze({
  inputBytes: 1024 * 1024, artifactBytes: 64 * 1024, streamBytes: 16 * 1024,
  queue: 32, heapMiB: 64, maxConcurrency: 4, maxTimeoutMs: 30_000, killWaitMs: 1_000,
});
const WORKER = fileURLToPath(new URL('./csv-worker.mjs', import.meta.url));
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
  await mkdir(path, { recursive: true, mode: 0o700 });
  const st = await lstat(path);
  if (!st.isDirectory() || (st.mode & 0o077) !== 0 || st.uid !== process.getuid?.()) {
    throw new CsvJobError('INVALID_FILE', 'CSV storage must be a private directory owned by the host process.');
  }
  return realpath(path);
}

async function readBounded(directory: string, name: string, limit: number): Promise<Buffer> {
  // All paths below the private root use fixed names and generated/digested IDs.
  if (await realpath(directory) !== directory) throw new CsvJobError('INVALID_FILE', 'CSV storage path changed.');
  const file = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = await file.stat();
    if (!st.isFile() || st.nlink !== 1 || st.size > limit) throw new CsvJobError('INVALID_FILE', 'Invalid CSV job file.');
    const buffer = Buffer.allocUnsafe(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size !== st.size || size > limit) throw new CsvJobError('INVALID_FILE', 'CSV job file changed or exceeded its limit.');
    return buffer.subarray(0, size);
  } finally {
    await file.close();
  }
}

function parseGrant(bytes: Buffer, grantId: string, scope: Scope): CsvGrant {
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (!object(value) || value.id !== grantId || value.grantId !== grantId || value.projectId !== scope.projectId
    || value.sessionId !== scope.sessionId || typeof value.fileId !== 'string' || typeof value.versionId !== 'string'
    || typeof value.name !== 'string' || typeof value.bytes !== 'number' || !Number.isSafeInteger(value.bytes)
    || value.bytes < 1 || value.bytes > CSV_LIMITS.inputBytes || typeof value.sha256 !== 'string' || !SHA256.test(value.sha256)) {
    throw new CsvJobError('GRANT_DENIED', 'CSV input grant is unavailable to this project and session.');
  }
  return { ...scope, id: grantId, grantId, fileId: value.fileId, versionId: value.versionId, name: value.name, bytes: value.bytes, sha256: value.sha256 };
}

export type CsvAttempt = CsvJob & {
  readonly status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted';
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string | null;
  readonly env: Readonly<Record<string, string>>;
  readonly limits: typeof CSV_LIMITS & { readonly timeoutMs: number };
  readonly pid: number | null;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly cancellation: 'not_requested' | 'confirmed' | 'unknown';
  readonly stdout: string;
  readonly stderr: string;
  readonly grant?: CsvGrant;
  readonly artifact?: CsvArtifact;
  readonly error?: string;
};

export type CsvJobEvent =
  | { readonly type: 'process_queued' | 'process_started' | 'process_finished'; readonly attempt: CsvAttempt }
  | { readonly type: 'process_output'; readonly attempt: CsvAttempt; readonly stream: 'stdout' | 'stderr'; readonly text: string };

export type CsvJobRunnerOptions = {
  readonly dataDir: string;
  readonly concurrency?: number;
  readonly timeoutMs?: number;
  readonly onEvent?: (event: CsvJobEvent) => void;
  readonly recoveredAttempts?: readonly CsvAttempt[];
};

type StopReason = 'cancelled' | 'timed_out' | 'output_limit';
type JobHandle = { readonly result: Promise<CsvAttempt>; cancel(): void };
type Pending = {
  attempt: CsvAttempt;
  readonly result: Promise<CsvAttempt>;
  readonly resolve: (attempt: CsvAttempt) => void;
  stop?: StopReason;
  terminate?: () => void;
  exited?: boolean;
};

type ProcessResult = {
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
export class CsvJobRunner {
  readonly #directory: string;
  readonly #concurrency: number;
  readonly #limits: CsvAttempt['limits'];
  readonly #observer: CsvJobRunnerOptions['onEvent'];
  readonly #queue: Pending[] = [];
  readonly #active = new Set<Pending>();
  readonly #known = new Set<string>();
  #admitting = 0;
  #closed = false;
  #halted = false;
  #closePromise?: Promise<void>;

  constructor(options: CsvJobRunnerOptions) {
    if (process.release.name !== 'node' || !['darwin', 'linux'].includes(process.platform) || Number(process.versions.node.split('.')[0]) < 24) {
      throw new CsvJobError('UNSUPPORTED_PLATFORM', 'CSV execution requires Node 24+ on macOS or Linux.');
    }
    this.#directory = resolve(options.dataDir, 'csv-jobs');
    this.#concurrency = boundedInt(options.concurrency, 1, CSV_LIMITS.maxConcurrency, 'CSV concurrency');
    this.#limits = Object.freeze({ ...CSV_LIMITS, timeoutMs: boundedInt(options.timeoutMs, 5_000, CSV_LIMITS.maxTimeoutMs, 'CSV timeout') });
    this.#observer = options.onEvent;
    for (const prior of options.recoveredAttempts ?? []) {
      const key = attemptKey(prior);
      if (this.#known.has(key)) continue;
      this.#known.add(key);
      if (prior.status === 'running' || prior.status === 'queued') {
        const attempt: CsvAttempt = Object.freeze({ ...prior, status: 'interrupted', endedAt: Date.now(),
          exitCode: null, signal: null, cancellation: 'unknown', artifact: undefined,
          error: 'Host restarted before the CSV attempt settled. Process termination was not observed; the attempt will not rerun.' });
        queueMicrotask(() => this.#emit({ type: 'process_finished', attempt }));
      }
    }
  }

  async grant(input: FileVersion & { readonly bytes: Uint8Array }): Promise<CsvGrant> {
    this.#assertOpen();
    const fields = { projectId: text(input.projectId, 'project ID'), sessionId: text(input.sessionId, 'session ID'),
      fileId: text(input.fileId, 'file ID'), versionId: text(input.versionId, 'version ID'), name: text(input.name, 'file name') };
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength < 1 || input.bytes.byteLength > CSV_LIMITS.inputBytes) {
      throw new CsvJobError('INVALID_INPUT', 'CSV requires 1 byte to 1 MiB of staged data.');
    }
    const bytes = Buffer.from(input.bytes);
    const id = randomUUID();
    const grant: CsvGrant = Object.freeze({ ...fields, id, grantId: id, bytes: bytes.length, sha256: sha256(bytes) });
    const directory = join(await this.#root('grants'), id);
    this.#assertOpen();
    await mkdir(directory, { mode: 0o700 });
    try {
      await writeFile(join(directory, 'input.csv'), bytes, { flag: 'wx', mode: 0o400 });
      await writeFile(join(directory, 'grant.json'), JSON.stringify(grant), { flag: 'wx', mode: 0o400 });
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    return grant;
  }

  start(input: CsvJob): JobHandle {
    this.#assertOpen();
    const job: CsvJob = {
      projectId: text(input.projectId, 'project ID'), sessionId: text(input.sessionId, 'session ID'),
      requestId: text(input.requestId, 'request ID'), taskId: text(input.taskId, 'task ID'),
      toolId: text(input.toolId, 'tool ID'), attemptId: text(input.attemptId, 'attempt ID'),
      grantId: text(input.grantId, 'grant ID'),
      ...(input.column !== undefined ? { column: text(input.column, 'CSV column') } : {}),
    };
    if (!UUID.test(job.grantId)) throw new CsvJobError('GRANT_DENIED', 'Invalid CSV grant ID.');
    const key = attemptKey(job);
    if (this.#known.has(key)) throw new CsvJobError('DUPLICATE_ATTEMPT', 'CSV attempt IDs cannot be reused.');
    if (this.#queue.length >= CSV_LIMITS.queue) throw new CsvJobError('QUEUE_FULL', 'The CSV job queue is full.');
    this.#known.add(key);
    const { promise: result, resolve } = Promise.withResolvers<CsvAttempt>();
    const pending: Pending = { result, resolve, attempt: Object.freeze({ ...job, program: process.execPath, args: Object.freeze([]),
      cwd: null, env: ENV, limits: this.#limits, pid: null, status: 'queued', startedAt: null, endedAt: null,
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
  async download(artifact: CsvArtifact): Promise<Buffer> {
    const { id, projectId, sessionId, attemptId, bytes, sha256: digest } = artifact;
    if (!UUID.test(id) || !SHA256.test(digest) || artifact.name !== 'statistics.json' || artifact.mimeType !== 'application/json'
      || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > CSV_LIMITS.artifactBytes) {
      throw new CsvJobError('ARTIFACT_DENIED', 'Invalid CSV artifact reference.');
    }
    try {
      const directory = join(await this.#root('attempts'), attemptKey({ projectId, sessionId, attemptId }));
      const receipt: unknown = JSON.parse((await readBounded(directory, 'artifact.json', 8 * 1024)).toString('utf8'));
      if (!object(receipt) || receipt.id !== id || receipt.projectId !== projectId || receipt.sessionId !== sessionId
        || receipt.attemptId !== attemptId || receipt.bytes !== bytes || receipt.sha256 !== digest
        || receipt.name !== artifact.name || receipt.mimeType !== artifact.mimeType) {
        throw new CsvJobError('ARTIFACT_DENIED', 'CSV artifact reference does not match its receipt.');
      }
      const content = await readBounded(directory, artifact.name, CSV_LIMITS.artifactBytes);
      if (content.length !== bytes || sha256(content) !== digest) throw new CsvJobError('ARTIFACT_DENIED', 'CSV artifact failed verification.');
      return content;
    } catch (error) {
      if (error instanceof CsvJobError && error.code === 'ARTIFACT_DENIED') throw error;
      throw new CsvJobError('ARTIFACT_DENIED', 'CSV artifact is unreadable or failed verification.', { cause: error });
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
    if (this.#closed || this.#halted) throw new CsvJobError('CLOSED', 'The CSV job runner is not accepting work.');
  }

  #emit(event: CsvJobEvent): void {
    try {
      this.#observer?.(event);
    } catch (error) {
      process.emitWarning('The CSV job event observer failed.', { code: 'CSV_OBSERVER_FAILED', detail: error instanceof Error ? error.message : String(error) });
    }
  }

  #finish(pending: Pending, result: Partial<CsvAttempt> & { readonly status: CsvAttempt['status'] }): void {
    const attempt = Object.freeze({ ...pending.attempt, ...result, endedAt: Date.now() });
    pending.terminate = undefined;
    pending.attempt = attempt;
    this.#active.delete(pending);
    this.#emit({ type: 'process_finished', attempt });
    pending.resolve(attempt);
    this.#drain();
  }

  #stop(pending: Pending, reason: StopReason): void {
    if (pending.stop || pending.attempt.endedAt !== null || (pending.exited && reason !== 'output_limit')) return;
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
      const grantDir = join(await this.#root('grants'), job.grantId);
      let grant: CsvGrant;
      let bytes: Buffer;
      try {
        grant = parseGrant(await readBounded(grantDir, 'grant.json', 8 * 1024), job.grantId, {
          projectId: job.projectId, sessionId: job.sessionId,
        });
        bytes = await readBounded(grantDir, 'input.csv', CSV_LIMITS.inputBytes);
        if (bytes.length !== grant.bytes || sha256(bytes) !== grant.sha256) {
          throw new CsvJobError('GRANT_DENIED', 'CSV input failed grant verification.');
        }
      } catch (error) {
        if (error instanceof CsvJobError && error.code === 'GRANT_DENIED') throw error;
        throw new CsvJobError('GRANT_DENIED', 'CSV input grant is unavailable to this project and session.', { cause: error });
      }

      const inputPath = join(cwd, 'input.csv');
      const outputPath = join(cwd, 'statistics.json');
      const args = Object.freeze([
        '--permission', `--allow-fs-read=${WORKER}`, `--allow-fs-read=${inputPath}`, `--allow-fs-write=${outputPath}`,
        `--max-old-space-size=${CSV_LIMITS.heapMiB}`, '--disallow-code-generation-from-strings', '--no-addons',
        '--', WORKER, ...(job.column === undefined ? [] : [job.column]),
      ]);
      await writeFile(inputPath, bytes, { flag: 'wx', mode: 0o400 });
      if (pending.stop) {
        this.#finish(pending, { status: 'cancelled', cancellation: 'confirmed' });
        return;
      }
      pending.attempt = Object.freeze({ ...pending.attempt, cwd, args, grant });
      processResult = await this.#execute(pending, cwd, args);
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
            error: stop === 'timed_out' ? 'CSV process exceeded its time limit.' : undefined });
          return;
        case 'output_limit':
          this.#finish(pending, { ...exit, status: 'failed', error: 'CSV process exceeded a stdout or stderr byte limit.' });
          return;
        case undefined:
          break;
      }
      if (exitCode !== 0 || signal !== null || error) {
        this.#finish(pending, { ...exit, status: 'failed', error: error ?? 'CSV process did not exit successfully.' });
        return;
      }
      const content = await readBounded(cwd, 'statistics.json', CSV_LIMITS.artifactBytes);
      const summary: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content));
      if (!object(summary) || summary.schemaVersion !== 1 || !Array.isArray(summary.columns) || !Array.isArray(summary.statistics)
        || typeof summary.rowCount !== 'number' || !Number.isSafeInteger(summary.rowCount) || summary.rowCount < 0) {
        throw new CsvJobError('INVALID_FILE', 'CSV worker did not produce a statistics JSON artifact.');
      }
      const artifact: CsvArtifact = Object.freeze({ id: randomUUID(), projectId: job.projectId, sessionId: job.sessionId,
        attemptId: job.attemptId, name: 'statistics.json', mimeType: 'application/json', bytes: content.length, sha256: sha256(content) });
      await writeFile(join(cwd, 'artifact.json'), JSON.stringify(artifact), { flag: 'wx', mode: 0o400 });
      this.#finish(pending, { ...exit, status: 'succeeded', artifact });
    } catch (error) {
      if (!processResult && pending.stop) {
        this.#finish(pending, { status: 'cancelled', cancellation: 'confirmed' });
      } else {
        this.#finish(pending, { status: 'failed', exitCode: processResult?.exitCode ?? null, signal: processResult?.signal ?? null,
          error: error instanceof Error ? error.message : 'CSV attempt failed.' });
      }
    }
  }

  #execute(pending: Pending, cwd: string, args: readonly string[]): Promise<ProcessResult> {
    const child = spawn(pending.attempt.program, args, { cwd, env: ENV, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
        const remaining = CSV_LIMITS.streamBytes - sink.size;
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
          try { process.kill(-pid, 0); } catch (failure) { if (errorCode(failure) === 'ESRCH') termination = 'confirmed'; }
        }
        for (const [stream, sink] of [['stdout', stdout], ['stderr', stderr]] as const) {
          const rest = sink.decoder.end();
          sink.text += rest;
          output(stream, rest);
        }
        pending.attempt = Object.freeze({ ...pending.attempt, stdout: stdout.text, stderr: stderr.text });
        resolveResult({ exitCode, signal, termination, stop: pending.stop, error });
      };

      const timeout = setTimeout(() => this.#stop(pending, 'timed_out'), this.#limits.timeoutMs);
      pending.terminate = () => {
        const pid = child.pid;
        if (pid !== undefined && !pending.exited && child.exitCode === null && child.signalCode === null) {
          try { signalled = process.kill(-pid, 'SIGKILL'); } catch (failure) {
            if (errorCode(failure) !== 'ESRCH') error = 'Could not signal the live CSV process group.';
          }
        }
        stopTimer = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          settle();
        }, CSV_LIMITS.killWaitMs);
      };
      child.once('spawn', () => {
        pending.attempt = Object.freeze({ ...pending.attempt, status: 'running', pid: child.pid ?? null, startedAt: Date.now() });
        this.#emit({ type: 'process_started', attempt: pending.attempt });
      });
      child.once('error', failure => { error = `CSV process failed to launch: ${failure.message}`; });
      child.once('exit', (code, terminatingSignal) => {
        pending.exited = true;
        exitCode = code;
        signal = terminatingSignal;
        if (!stopTimer) {
          clearTimeout(timeout);
          // The fixed worker cannot spawn children. Still bound pipe drain if that assumption is violated.
          stopTimer = setTimeout(() => {
            error = 'CSV process exited without closing its output pipes.';
            child.stdout.destroy();
            child.stderr.destroy();
            settle();
          }, CSV_LIMITS.killWaitMs);
        }
      });
      child.once('close', settle);
      child.stdout.on('data', chunk => consume('stdout', chunk));
      child.stderr.on('data', chunk => consume('stderr', chunk));
    });
  }
}
