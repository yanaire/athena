import { Worker } from 'node:worker_threads';
import type { CodeExecution, CodeReadTrace } from '../athena-backend-handoff/athena-codex-ui/integrations/task-manager.d.ts';
import { readIdentity } from './code-mode-contracts.ts';
import { hash, ManagerError } from './orchestration.ts';

export const CODE_LIMITS = Object.freeze({
  sourceBytes: 16 * 1024, memoryBytes: 12 * 1024 * 1024, cpuInterrupts: 8_000,
  wallMs: 6_000, toolMs: 2_000, calls: 24, queued: 8, concurrency: 4, workers: 2,
  argumentBytes: 8 * 1024, resultBytes: 128 * 1024, totalReadBytes: 512 * 1024, outputBytes: 32 * 1024,
});

type Failure = { code: string; message: string };
type ReadResult = { value: unknown; source?: CodeReadTrace['source'] };
type Read = { trace: CodeReadTrace; request: unknown; controller?: AbortController; expired?: NodeJS.Timeout };
type Options = {
  receipt: CodeExecution;
  source: string;
  signal: AbortSignal;
  concurrency: number;
  read: (request: unknown, signal: AbortSignal) => Promise<ReadResult>;
  update: (value: CodeExecution) => void;
  observe: (trace: CodeReadTrace, request: unknown) => void;
};
type Incoming =
  | { type: 'call'; id: number; json?: string; digest: string; identity?: unknown }
  | { type: 'call_limit' }
  | { type: 'finished'; json?: string; code?: string; message?: string; cpuMs: number };
let ownedWorkers = 0;

function failure(error: unknown): Failure {
  return error instanceof ManagerError
    ? { code: error.code, message: error.message }
    : { code: 'READ_FAILED', message: 'The host could not read the verified result.' };
}

export function cancellation(signal: AbortSignal): Failure {
  return signal.reason instanceof ManagerError && signal.reason.code === 'TOOL_FAILURE_LIMIT'
    ? failure(signal.reason)
    : { code: 'CANCELLED', message: 'JavaScript was stopped. Completed reads were retained.' };
}

export function interruptCode(receipt: CodeExecution, at: number): CodeExecution {
  return {
    ...receipt, endedAt: at, error: { code: 'INTERRUPTED', message: 'The host restarted before JavaScript settled. The execution was not replayed.' },
    calls: receipt.calls.map(call => call.status === 'running' || call.status === 'queued' ? {
      ...call, status: call.startedAt === null ? 'not_dispatched' : 'interrupted', endedAt: at,
    } : call),
  };
}

export function executeCode({ receipt, source, signal, concurrency, read, update, observe }: Options): Promise<CodeExecution> {
  const initialFailure = signal.aborted ? cancellation(signal) : ownedWorkers >= CODE_LIMITS.workers
    ? { code: 'CODE_BUSY', message: 'JavaScript execution is at capacity. Try again after another execution settles.' }
    : Buffer.byteLength(source) > CODE_LIMITS.sourceBytes
      ? { code: 'SOURCE_LIMIT', message: 'JavaScript exceeds the source size limit.' } : null;
  if (initialFailure) return Promise.resolve({ ...receipt, endedAt: Date.now(), error: initialFailure });

  return new Promise(resolve => {
    ownedWorkers++;
    let worker: Worker;
    try {
      worker = new Worker(new URL('./code-mode-worker.mjs', import.meta.url), {
        workerData: { source, limits: CODE_LIMITS }, env: {}, execArgv: [], stdout: true, stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 },
      });
    } catch {
      ownedWorkers--;
      resolve({ ...receipt, endedAt: Date.now(), error: { code: 'WORKER_FAILED', message: 'The JavaScript worker could not start.' } });
      return;
    }
    worker.stdout?.resume();
    worker.stderr?.resume();
    const startedAt = Date.now();
    const reads: Read[] = [];
    const queue: Read[] = [];
    let active = 0;
    let resultBytes = 0;
    let ended = false;
    let exited = false;
    let released = false;
    let peakConcurrency = 0;
    const release = () => {
      if (exited && active === 0 && !released) {
        released = true;
        ownedWorkers--;
      }
    };
    const snapshot = (): CodeExecution => ({ ...receipt, startedAt, calls: reads.map(item => ({ ...item.trace })), peakConcurrency });
    const finish = (terminal: Pick<CodeExecution, 'error' | 'result' | 'cpuMs'>) => {
      if (ended) return;
      ended = true;
      clearTimeout(deadline);
      signal.removeEventListener('abort', stop);
      queue.length = 0;
      const endedAt = Date.now();
      for (const item of reads) {
        if (item.trace.endedAt !== null) continue;
        item.trace = { ...item.trace, endedAt, status: item.trace.startedAt === null ? 'not_dispatched' : 'cancelled' };
        clearTimeout(item.expired);
        item.controller?.abort();
      }
      void worker.terminate().catch(() => {});
      resolve({ ...snapshot(), ...terminal, endedAt });
    };
    const stop = () => finish({ error: cancellation(signal) });
    const internal = () => finish({ error: { code: 'CODE_HOST_FAILED', message: 'The host could not record or dispatch a JavaScript read.' } });
    const deadline = setTimeout(() => finish({ error: { code: 'WALL_LIMIT', message: 'JavaScript exceeded its total elapsed time limit.' } }), CODE_LIMITS.wallMs);

    function settle(item: Read, error?: Failure, result?: ReadResult) {
      if (ended || item.trace.endedAt !== null) return;
      clearTimeout(item.expired);
      let json: string | undefined;
      if (result) {
        json = JSON.stringify(result.value);
        const bytes = Buffer.byteLength(json);
        if (bytes > CODE_LIMITS.resultBytes || resultBytes + bytes > CODE_LIMITS.totalReadBytes) {
          error = { code: 'RESULT_LIMIT', message: 'Verified read results exceeded the JavaScript input size limit.' };
        } else {
          resultBytes += bytes;
          item.trace = { ...item.trace, resultBytes: bytes, resultSha256: hash(json), ...(result.source ? { source: result.source } : {}) };
        }
      }
      item.trace = {
        ...item.trace, endedAt: Date.now(), status: !error ? 'succeeded' : error.code === 'READ_TIMEOUT' ? 'timed_out' : 'failed',
        ...(error ? { error } : {}),
      };
      update(snapshot());
      observe(item.trace, item.request);
      if (!ended) worker.postMessage({ id: item.trace.order, ok: !error, value: error ? undefined : result?.value, error });
    }

    function drain() {
      while (!ended && !signal.aborted && queue.length && active < concurrency) {
        const item = queue.shift()!;
        const controller = new AbortController();
        item.controller = controller;
        active++;
        peakConcurrency = Math.max(peakConcurrency, active);
        item.trace = { ...item.trace, startedAt: Date.now(), status: 'running' };
        try { update(snapshot()); }
        catch (error) { active--; throw error; }
        if (ended) { active--; release(); return; }
        item.expired = setTimeout(() => {
          controller.abort();
          try { settle(item, { code: 'READ_TIMEOUT', message: 'The verified read exceeded its time limit.' }); } catch { internal(); }
        }, CODE_LIMITS.toolMs);
        // Keep the physical slot until the read actually settles, even after its deadline.
        void Promise.resolve().then(() => {
          controller.signal.throwIfAborted();
          return read(item.request, controller.signal);
        }).then(result => settle(item, undefined, result), error => settle(item, failure(error)))
          .finally(() => {
            active--;
            release();
            drain();
          }).catch(internal);
      }
    }

    worker.on('message', (message: Incoming) => {
      if (ended) return;
      try {
        if (message.type === 'finished') {
          finish(message.code ? { error: { code: message.code, message: message.message! }, cpuMs: message.cpuMs }
            : { result: JSON.parse(message.json!), cpuMs: message.cpuMs });
          return;
        }
        if (message.type === 'call_limit') {
          finish({ error: { code: 'CALL_LIMIT', message: 'JavaScript exceeded the number of permitted read requests.' } });
          return;
        }
        if (message.type !== 'call' || message.id !== reads.length + 1 || message.id > CODE_LIMITS.calls) {
          internal();
          return;
        }
        const request: unknown = message.json === undefined ? undefined : JSON.parse(message.json);
        const pin = readIdentity(request ?? message.identity);
        const item: Read = { request, trace: {
          id: receipt.id + '/' + message.id, order: message.id, status: 'queued', queuedAt: Date.now(),
          startedAt: null, endedAt: null, tool: pin?.id ?? null, version: pin?.version ?? null, contractHash: pin?.hash ?? null,
          argumentsSha256: message.digest,
        } };
        reads.push(item);
        if (request === undefined) settle(item, { code: 'ARGUMENT_LIMIT', message: 'Read arguments exceed the size limit.' });
        else if (queue.length >= CODE_LIMITS.queued) settle(item, { code: 'QUEUE_FULL', message: 'Too many reads are waiting. Await smaller batches.' });
        else {
          queue.push(item);
          update(snapshot());
          drain();
        }
      } catch { internal(); }
    });
    worker.on('error', error => finish({ error: 'code' in error && error.code === 'ERR_WORKER_OUT_OF_MEMORY'
      ? { code: 'RESOURCE_LIMIT', message: 'The JavaScript worker exceeded its memory limit.' }
      : { code: 'WORKER_FAILED', message: 'The JavaScript worker stopped unexpectedly.' } }));
    worker.on('exit', () => {
      exited = true;
      release();
      if (!ended) finish({ error: { code: 'WORKER_FAILED', message: 'The JavaScript worker exited without a result.' } });
    });
    signal.addEventListener('abort', stop, { once: true });
    try { update(snapshot()); } catch { internal(); }
    if (signal.aborted) stop();
  });
}
