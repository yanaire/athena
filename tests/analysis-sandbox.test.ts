import assert from 'node:assert/strict';
import childProcess, { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test, { type TestContext } from 'node:test';
import { runSandbox } from '../runtime/analysis-sandbox.ts';

// Exercise the host's process protocol independently of interpreter speed.
// Native execution and confinement remain covered by jobs-analysis.test.ts.
class SyntheticSandbox extends EventEmitter {
  pid = 12345;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  close(code: number | null, signal: NodeJS.Signals | null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('close', code, signal);
  }
  kill(signal: NodeJS.Signals) {
    if (this.exitCode !== null || this.signalCode !== null) return false;
    this.close(null, signal);
    return true;
  }
  unref() {}
}

async function fixture(t: TestContext, timeoutMs = 5_000) {
  const directory = await mkdtemp(join(tmpdir(), 'athena-sandbox-protocol-'));
  const controller = new AbortController();
  const child = new SyntheticSandbox();
  const spawned = Promise.withResolvers<void>();
  const stops: string[] = [];
  let starts = 0;
  t.mock.method(childProcess, 'spawn', () => {
    spawned.resolve();
    return child as unknown as ChildProcessWithoutNullStreams;
  });
  syncBuiltinESMExports();
  const result = runSandbox({ cwd: directory, timeoutMs, signal: controller.signal,
    job: { language: 'python', script: { name: 'main.py', bytes: Buffer.from('print(42)') }, inputs: [], outputs: [] },
    started: () => { starts++; }, output: () => {},
    stop: reason => { stops.push(reason); controller.abort(); } });
  t.after(async () => {
    controller.abort();
    try { await result; }
    finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      await rm(directory, { recursive: true, force: true });
    }
  });
  await spawned.promise;
  return { child, result, stops, starts: () => starts };
}

for (const startup of [100, 30_000]) {
  test(`a ${startup}ms startup leaves the same bounded guest fallback after readiness`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { child, result, stops, starts } = await fixture(t);
    t.mock.timers.tick(startup);
    assert.deepEqual(stops, [], 'bounded startup must not consume the guest execution allowance');
    child.stdout.write('ATHENA_SANDBOX_READY\n');
    assert.equal(starts(), 1);
    t.mock.timers.tick(5_999);
    assert.deepEqual(stops, []);
    t.mock.timers.tick(1);
    assert.deepEqual(stops, ['timed_out'], 'host fallback is the unchanged guest deadline plus one second for native termination');
    assert.deepEqual(await result, { started: true, exitCode: null, signal: 'SIGKILL' });
  });
}

test('an interpreter that never becomes ready has a bounded startup deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { result, stops, starts } = await fixture(t);
  t.mock.timers.tick(30_999);
  assert.deepEqual(stops, []);
  t.mock.timers.tick(1);
  assert.deepEqual(stops, ['timed_out']);
  assert.equal(starts(), 0);
  assert.deepEqual(await result, { started: false, exitCode: null, signal: 'SIGKILL' });
});

for (const signal of ['SIGXCPU', 'SIGTERM', 'SIGKILL'] as const) {
  test(`native ${signal} preserves its signal and only a CPU limit becomes timed_out`, async t => {
    const { child, result, stops } = await fixture(t);
    child.stdout.write('ATHENA_SANDBOX_READY\n');
    child.close(null, signal);
    assert.deepEqual(await result, { started: true, exitCode: null, signal });
    assert.deepEqual(stops, signal === 'SIGXCPU' ? ['timed_out'] : []);
  });
}
