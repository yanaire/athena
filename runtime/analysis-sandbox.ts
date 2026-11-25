import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { ANALYSIS_FILE_LIMITS, type AnalysisSnapshot } from './analysis-files.ts';

export const ANALYSIS_LIMITS = Object.freeze({ guestLinearMemoryMiB: 192, hostMemoryMiB: 768, hostMemorySampleMs: 10, openFiles: 96,
  fileBytes: ANALYSIS_FILE_LIMITS.fileBytes, streamBytes: 16384, maxArgs: 16, argBytes: 256,
  snapshotBytes: 2 * 1024 * 1024, maxFiles: ANALYSIS_FILE_LIMITS.batchFiles, maxTimeoutMs: 30000 });
const startupMs = 20_000;
const ready = Buffer.from('ATHENA_SANDBOX_READY\n');
const bundled = fileURLToPath(new URL('../analysis-runtime', import.meta.url));
const staged = fileURLToPath(new URL('../.analysis-runtime/staged', import.meta.url));
const packaged = process.argv.includes('--desktop', 2);
const runtime = packaged ? bundled : staged;
const executable = join(packaged ? dirname(process.execPath) : staged, process.platform === 'win32' ? 'athena-sandbox.exe' : 'athena-sandbox');

const programs = Object.freeze({ node: { path: 'qjs.wasm', version: 'QuickJS-ng 0.18.0' },
  python: { path: 'python.wasm', version: 'CPython 3.15.2' } });
export type Language = keyof typeof programs;
export type AnalysisAccess = { readonly available: false; readonly reason: string } |
  { readonly available: true; readonly engine: 'Wasmtime 50.0.3'; readonly node: typeof programs.node; readonly python: typeof programs.python };
export const analysisEnv = Object.freeze({});

export async function analysisAccess(): Promise<AnalysisAccess> {
  try {
    await Promise.all([access(executable, constants.X_OK), access(join(runtime, 'qjs.wasm'), constants.R_OK),
      access(join(runtime, 'python.wasm'), constants.R_OK), access(join(runtime, 'python', 'lib', 'python3.15', 'encodings', '__init__.py'), constants.R_OK)]);
    return { available: true, engine: 'Wasmtime 50.0.3', ...programs };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { available: false, reason: 'The app-owned WASI runtime is missing or unreadable. Reinstall Athena, or prepare the local analysis runtime for development.' };
  }
}

export class SandboxCleanupError extends Error {}
export type SandboxJob = { readonly script: AnalysisSnapshot; readonly inputs: readonly AnalysisSnapshot[];
  readonly outputs: readonly string[]; readonly language: Language; readonly args?: readonly string[] };
type SandboxRun = { readonly cwd: string; readonly timeoutMs: number; readonly signal: AbortSignal;
  readonly job: SandboxJob; started(id: string, pid: number): void;
  output(stream: 'stdout' | 'stderr', text: string): void; stop(reason: 'timed_out' | 'output_limit'): void };

export async function runSandbox(run: SandboxRun): Promise<{ started: boolean; exitCode: number | null; signal: NodeJS.Signals | null }> {
  const { job, cwd, signal, timeoutMs } = run;
  const input = join(cwd, 'workspace');
  await mkdir(input, { mode: 0o700 });
  let cleanupSafe = true;
  try {
    await mkdir(join(cwd, 'outputs'), { mode: 0o700 });
    for (const snapshot of [job.script, ...job.inputs]) {
      await writeFile(join(input, snapshot.name), snapshot.bytes, { flag: 'wx', mode: 0o400 });
    }
    signal.throwIfAborted();
    // No inherited environment, shell, workspace credentials, or app descriptors.
    // Keep stdin open until child exit; the helper stops when it observes EOF.
    const child = spawn(executable, [runtime, job.language, String(timeoutMs), job.script.name, ...job.outputs, '--', ...(job.args ?? [])], {
      cwd, env: analysisEnv, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const id = randomUUID();
    let started = false;
    let preamble = Buffer.alloc(0);
    let problem: Error | undefined;
    const unconfirmed = Promise.withResolvers<never>();
    let reapTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      if (reapTimer !== undefined) return;
      child.kill('SIGKILL');
      reapTimer = setTimeout(() => {
        cleanupSafe = child.exitCode !== null || child.signalCode !== null;
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        unconfirmed.reject(new SandboxCleanupError('The sandbox did not settle after cancellation.'));
      }, 1_000);
    };
    const signals = () => {
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    };
    // Compilation has its own bounded allowance. Once the helper is ready,
    // the requested execution budget starts afresh, matching its native guard.
    let timer = setTimeout(() => run.stop('timed_out'), startupMs + 1_000);
    child.stdin.on('error', error => { if ('code' in error && error.code !== 'EPIPE') problem = error; });
    const streams = {
      stdout: { bytes: 0, decoder: new StringDecoder('utf8') },
      stderr: { bytes: 0, decoder: new StringDecoder('utf8') },
    };
    for (const stream of ['stdout', 'stderr'] as const) child[stream].on('data', (data: Buffer) => {
      let bytes = data;
      if (!started && stream === 'stdout') {
        if (problem) return;
        const pending = Math.min(ready.length - preamble.length, data.length);
        preamble = Buffer.concat([preamble, data.subarray(0, pending)]);
        if (!preamble.equals(ready.subarray(0, preamble.length))) {
          problem = new Error('The WASI runtime did not identify itself.');
          abort();
          return;
        }
        if (preamble.length !== ready.length) return;
        if (signal.aborted || child.pid === undefined) return;
        started = true;
        clearTimeout(timer);
        timer = setTimeout(() => run.stop('timed_out'), timeoutMs + 1_000);
        run.started(id, child.pid);
        bytes = bytes.subarray(pending);
      }
      const state = streams[stream];
      const accepted = bytes.subarray(0, ANALYSIS_LIMITS.streamBytes - state.bytes);
      state.bytes += accepted.length;
      const text = state.decoder.write(accepted);
      if (text) run.output(stream, text);
      if (accepted.length < bytes.length) run.stop('output_limit');
    });
    try {
      const closed = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(resolve => {
        child.on('error', error => { problem = error; });
        child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
        signals();
      });
      const result = await Promise.race([closed, unconfirmed.promise]);
      for (const stream of ['stdout', 'stderr'] as const) {
        const rest = streams[stream].decoder.end();
        if (rest) run.output(stream, rest);
      }
      if (result.exitCode === 124) run.stop('timed_out');
      if (problem && !signal.aborted) throw problem;
      return { ...result, started };
    } finally {
      clearTimeout(timer);
      clearTimeout(reapTimer);
      signal.removeEventListener('abort', abort);
      child.stdin.destroy();
    }
  } finally {
    if (cleanupSafe) {
      try { await rm(input, { recursive: true, force: true }); }
      catch (error) { throw new SandboxCleanupError('Could not remove the analysis input snapshots.', { cause: error }); }
    }
  }
}
