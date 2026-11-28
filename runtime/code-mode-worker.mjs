import { createHash } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
import { InlineCodemodeSandbox, loadQuickJSWasm } from '@earendil-works/pi-codemode';

const { source, limits } = workerData;
const cpuStart = process.threadCpuUsage();
const pending = new Map();
let sequence = 0;

parentPort.on('message', ({ id, ok, value, error }) => {
  const pair = pending.get(id);
  if (!pair) return;
  if (ok) pair.resolve(value);
  else pair.reject(new Error(error.code + ': ' + error.message));
});

const sandbox = new InlineCodemodeSandbox({
  wasm: loadQuickJSWasm(),
  interruptBudget: limits.cpuInterrupts,
  memoryLimitBytes: limits.memoryBytes,
  timeoutMs: Infinity, // The manager owns the run deadline and can stop a busy worker.
  tools: [{
    name: 'call',
    execute(args, { signal }) {
      const id = ++sequence;
      if (id > limits.calls) {
        if (id === limits.calls + 1) parentPort.postMessage({ type: 'call_limit' });
        throw new Error('CALL_LIMIT: Too many read requests.');
      }
      const json = JSON.stringify(args ?? null);
      const oversized = Buffer.byteLength(json) > limits.argumentBytes;
      const argumentsJson = JSON.stringify(args?.args ?? args ?? null);
      const digest = createHash('sha256').update(argumentsJson).digest('hex');
      const identity = typeof args?.id === 'string' && args.id.length <= 256 && Number.isSafeInteger(args.version)
        && typeof args.hash === 'string' && args.hash.length === 64 ? {id:args.id, version:args.version, hash:args.hash} : undefined;
      let abort;
      return new Promise((resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        pending.set(id, { resolve, reject });
        parentPort.postMessage(oversized
          ? { type: 'call', id, digest, identity }
          : { type: 'call', id, digest, json });
      }).finally(() => {
        signal.removeEventListener('abort', abort);
        pending.delete(id);
      });
    },
  }],
});

let terminal;
try {
  const result = await sandbox.execute(source);
  if (!result.ok) {
    const { kind, name, message, stack } = result.error;
    if (kind === 'timeout') terminal = { code: 'CPU_LIMIT', message: 'JavaScript exceeded the active computation budget.' };
    else if (/out of memory|stack overflow|script output exceeded|memory access out of bounds/i.test(message))
      terminal = { code: 'RESOURCE_LIMIT', message: 'JavaScript exceeded its memory, stack, or temporary output limit.' };
    else if (kind === 'script' && sequence === 0 && name === 'SyntaxError' && !stack?.includes('at <anonymous>'))
      terminal = { code: 'SYNTAX_ERROR', message: 'JavaScript could not be parsed. Supply an async JavaScript function body.' };
    else if (kind === 'script') terminal = { code: 'SCRIPT_ERROR', message: 'JavaScript threw an error. Check the completed and unfinished read calls.' };
    else terminal = { code: 'WORKER_FAILED', message: 'The JavaScript sandbox could not complete.' };
  } else {
    const json = JSON.stringify(result.value ?? null);
    terminal = Buffer.byteLength(json) <= limits.outputBytes
      ? { json }
      : { code: 'OUTPUT_LIMIT', message: 'The JavaScript result exceeds the summary size limit.' };
  }
} finally {
  const { user, system } = process.threadCpuUsage(cpuStart);
  if (terminal) parentPort.postMessage({ type: 'finished', ...terminal, cpuMs: (user + system) / 1000 });
  await sandbox.close();
  parentPort.close();
}
