import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { CSV_LIMITS, CsvJobRunner, type CsvJobEvent, type CsvJobRunnerOptions } from '../runtime/jobs.ts';

const scope = { projectId: 'project-1', sessionId: 'session-1' };
const file = { ...scope, fileId: 'file-1', versionId: 'version-1', name: '../../display-only.csv' };
const match = { ...scope, requestId: 'request-1', taskId: 'task-1', attemptId: 'attempt-1', toolId: 'tool-1' };

async function fixture(t: TestContext, options: Omit<CsvJobRunnerOptions, 'dataDir'> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'athena-jobs-'));
  const runner = new CsvJobRunner({ dataDir, ...options });
  t.after(async () => {
    await runner.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return { runner, dataDir };
}

test('the real Node worker computes statistics from the immutable file version and logs its outcome', async t => {
  const events: CsvJobEvent[] = [];
  const { runner, dataDir } = await fixture(t, { onEvent: event => events.push(event) });
  const bytes = Buffer.from('\ufefflabel,"--inspect"\r\n"two, words",2\r\n"two\nlines",4.0e0\r\n"""quote""",\r\ntext,0x10\r\n');
  const grantPromise = runner.grant({ ...file, bytes });
  bytes.fill(0);
  const grant = await grantPromise;
  const attempt = await runner.start({ ...match, grantId: grant.grantId, column: '--inspect' }).result;
  assert.equal(attempt.status, 'succeeded', attempt.stderr || attempt.error);
  assert.equal(attempt.program, process.execPath);
  assert.equal(basename(attempt.args.at(-1) ?? ''), 'csv-worker.mjs');
  assert.equal(attempt.mcp?.phase, 'tools/call');
  assert.equal(attempt.mcp?.server, 'athena-measurements');
  assert.deepEqual(attempt.env, { LANG: 'C', LC_ALL: 'C', TZ: 'UTC' });
  assert.ok(attempt.cwd);
  assert.equal(basename(dirname(attempt.cwd)), 'attempts');
  assert.ok(typeof attempt.pid === 'number' && attempt.pid > 1 && attempt.pid !== process.pid);
  assert.equal(attempt.exitCode, 0);
  assert.equal(attempt.signal, null);
  assert.equal(attempt.grant?.versionId, file.versionId);
  assert.equal(attempt.stderr, '');
  assert.ok(attempt.artifact);
  const buffer = await runner.download(attempt.artifact);
  assert.equal(createHash('sha256').update(buffer).digest('hex'), attempt.artifact.sha256);
  assert.deepEqual(JSON.parse(buffer.toString()), { schemaVersion: 1, rowCount: 4, columns: ['label', '--inspect'],
    statistics: [{ column: '--inspect', count: 2, missing: 1, nonNumeric: 1, min: 2, max: 4, mean: 3 }] });
  assert.equal(events.at(0)?.type, 'process_queued');
  assert.equal(events.at(1)?.type, 'process_started');
  assert.equal(events.at(-1)?.type, 'process_finished');
  assert.match(events.flatMap(event => event.type === 'process_output' && event.stream === 'stdout' ? [event.text] : []).join(''), /MCP tools\/list\nMCP tools\/call/);

  await runner.close();
  const reopened = new CsvJobRunner({ dataDir });
  t.after(() => reopened.close());
  assert.deepEqual(await reopened.download(attempt.artifact), buffer);
  const reuse = await reopened.start({ ...match, grantId: grant.id }).result;
  assert.equal(reuse.status, 'failed');
  assert.equal(reuse.pid, null);
});

test('start synchronously obtains its queued receipt and does not dispatch when persistence fails', async t => {
  const seen: CsvJobEvent[] = [];
  const failure = new Error('queued receipt was not persisted');
  const { runner, dataDir } = await fixture(t, { onEvent(event) {
    seen.push(event);
    if (event.type === 'process_queued') throw failure;
  } });
  const grant = await runner.grant({ ...file, bytes: Buffer.from('x\n4\n') });
  assert.throws(() => runner.start({ ...match, grantId: grant.id }), error => error === failure);
  const queued = seen[0];
  assert.equal(queued?.type, 'process_queued');
  assert.equal(queued?.attempt.status, 'queued');
  assert.equal(queued?.attempt.attemptId, match.attemptId);
  assert.equal(queued?.attempt.pid, null);
  assert.equal(queued?.attempt.exitCode, null);
  await runner.close();
  assert.deepEqual(seen.map(event => event.type), ['process_queued']);
  const reopened = new CsvJobRunner({ dataDir });
  t.after(() => reopened.close());
  const fresh = await reopened.start({ ...match, grantId: grant.id }).result;
  assert.equal(fresh.status, 'succeeded', fresh.error);
});

test('a one-time terminal persistence failure withholds the artifact and lets the next job run', async t => {
  const saved: CsvJobEvent[] = [];
  let failed = false;
  const { runner } = await fixture(t, { onEvent(event) {
    if (event.type === 'process_finished' && event.attempt.status === 'succeeded' && !failed) {
      failed = true;
      throw new Error('Synthetic terminal persistence failure');
    }
    saved.push(event);
  } });
  const grant = await runner.grant({ ...file, bytes: Buffer.from('x\n4\n') });
  const first = runner.start({ ...match, grantId: grant.id });
  const next = runner.start({ ...match, attemptId: 'next', grantId: grant.id });
  const result = await first.result;
  assert.equal(failed, true);
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, 0, 'the worker finished; publication is what failed');
  assert.match(result.error ?? '', /persist.*completion/i);
  assert.equal(result.artifact, undefined);
  assert.equal(result.artifacts, undefined);
  assert.deepEqual(saved.filter(e => e.type === 'process_finished' && e.attempt.attemptId === match.attemptId).map(e => e.attempt), [result]);
  assert.equal((await next.result).status, 'succeeded');
});

test('permanent terminal persistence failure halts admission and settles the queue and close', { timeout: 5_000 }, async t => {
  const started: string[] = [];
  const { runner } = await fixture(t, { onEvent(event) {
    if (event.type === 'process_started') started.push(event.attempt.attemptId);
    if (event.type === 'process_finished') throw new Error('Synthetic persistent storage failure');
  } });
  const grant = await runner.grant({ ...file, bytes: Buffer.from('x\n4\n') });
  const first = runner.start({ ...match, grantId: grant.id });
  const queued = ['next-1', 'next-2'].map(attemptId => runner.start({ ...match, attemptId, grantId: grant.id }));
  const result = await first.result;
  assert.equal(result.status, 'failed');
  assert.equal(result.artifact, undefined);
  assert.match(result.error ?? '', /persist.*completion/i);
  assert.throws(() => runner.start({ ...match, attemptId: 'late', grantId: grant.id }), { code: 'CLOSED' });
  for (const handle of queued) {
    const stopped = await handle.result;
    assert.notEqual(stopped.status, 'succeeded');
    assert.equal(stopped.pid, null);
    assert.equal(stopped.artifact, undefined);
  }
  await runner.close();
  assert.deepEqual(started, [match.attemptId]);
});

test('a grant ID does not authorize a different project or session, or changed bytes', async t => {
  const { runner, dataDir } = await fixture(t);
  const grant = await runner.grant({ ...file, bytes: Buffer.from('amount\n10\n') });
  for (const target of [{ ...match, projectId: 'project-2' }, { ...match, sessionId: 'session-2' }]) {
    const denied = await runner.start({ ...target, grantId: grant.id }).result;
    assert.equal(denied.status, 'failed');
    assert.equal(denied.pid, null);
    assert.match(denied.error ?? '', /unavailable to this project and session/);
  }
  const input = join(dataDir, 'csv-jobs', 'grants', grant.id, 'input.csv');
  await chmod(input, 0o600);
  await writeFile(input, 'amount\n70\n');
  const corrupt = await runner.start({ ...match, grantId: grant.id }).result;
  assert.equal(corrupt.status, 'failed');
  assert.equal(corrupt.pid, null);
  assert.match(corrupt.error ?? '', /input failed grant verification/);
  await assert.rejects(runner.grant({ ...file, bytes: Buffer.alloc(CSV_LIMITS.inputBytes + 1) }), { code: 'INVALID_INPUT' });
});

test('artifact downloads reject changed data, symlinks and cross-session receipts', async t => {
  const { runner } = await fixture(t);
  const grant = await runner.grant({ ...file, bytes: Buffer.from('a\n10\n') });
  const result = await runner.start({ ...match, grantId: grant.id }).result;
  const { artifact, cwd } = result;
  assert.ok(artifact && cwd, result.stderr);
  const original = await runner.download(artifact);
  await assert.rejects(runner.download({ ...artifact, sessionId: 'session-2' }), { code: 'ARTIFACT_DENIED' });
  const output = join(cwd, artifact.name);
  await chmod(output, 0o600);
  const altered = Buffer.from(original.toString().replace('"max":10', '"max":90'));
  assert.notDeepEqual(altered, original);
  await writeFile(output, altered);
  await assert.rejects(runner.download(artifact), { code: 'ARTIFACT_DENIED' });
  await rm(output);
  const copy = join(cwd, 'copy.json');
  await writeFile(copy, original);
  await symlink(copy, output);
  await assert.rejects(runner.download(artifact), { code: 'ARTIFACT_DENIED' });
});

test('malformed CSV returns an MCP tool error even with a clean transport exit', async t => {
  const events: CsvJobEvent[] = [];
  const { runner } = await fixture(t, { onEvent: event => events.push(event) });
  const grant = await runner.grant({ ...file, bytes: Buffer.from('x,y\n"not closed,y\n') });
  const result = await runner.start({ ...match, grantId: grant.id }).result;
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, 0);
  assert.equal(result.cancellation, 'not_requested');
  assert.match(result.error ?? '', /Unclosed quoted CSV field/);
  assert.equal(result.artifact, undefined);
  assert.equal(events.flatMap(event => event.type === 'process_output' && event.stream === 'stderr' ? [event.text] : []).join(''), result.stderr);
});

test('concurrency, queue capacity and cancellation are enforced on a live process group', { timeout: 5_000 }, async t => {
  const started = Promise.withResolvers<CsvJobEvent['attempt']>();
  const { runner } = await fixture(t, { onEvent(event) {
    if (event.type === 'process_started' && event.attempt.attemptId === match.attemptId) started.resolve(event.attempt);
  } });
  const grant = await runner.grant({ ...file, bytes: Buffer.from(`x\n${'5\n'.repeat(99_000)}`) });
  const first = runner.start({ ...match, grantId: grant.id });
  const { pid } = await started.promise;
  assert.ok(pid);
  process.kill(pid, 'SIGSTOP');
  const queued = Array.from({ length: CSV_LIMITS.queue }, (_, i) => runner.start({ ...match, attemptId: `queued-${i}`, grantId: grant.id }));
  assert.throws(() => runner.start({ ...match, attemptId: 'overflow', grantId: grant.id }), { code: 'QUEUE_FULL' });
  await runner.close();
  assert.equal((await first.result).status, 'cancelled');
  assert.equal((await first.result).signal, 'SIGKILL');
  assert.equal((await first.result).cancellation, 'confirmed');
  assert.throws(() => process.kill(-pid, 0), { code: 'ESRCH' });
  for (const pending of queued) {
    const result = await pending.result;
    assert.equal(result.status, 'cancelled');
    assert.equal(result.pid, null);
    assert.equal(result.cancellation, 'confirmed');
  }
});

test('a stopped child times out and releases its process slot after confirmed termination', { timeout: 5_000 }, async t => {
  const { runner } = await fixture(t, { timeoutMs: 500, onEvent(event) {
    if (event.type === 'process_started' && event.attempt.attemptId === match.attemptId && event.attempt.pid) {
      process.kill(event.attempt.pid, 'SIGSTOP');
    }
  } });
  const grant = await runner.grant({ ...file, bytes: Buffer.from('x\n4\n') });
  const first = runner.start({ ...match, grantId: grant.id });
  const second = runner.start({ ...match, attemptId: 'attempt-next', grantId: grant.id });
  const timed = await first.result;
  assert.equal(timed.status, 'timed_out');
  assert.equal(timed.exitCode, null);
  assert.equal(timed.signal, 'SIGKILL');
  assert.equal(timed.cancellation, 'confirmed');
  assert.equal(timed.artifact, undefined);
  const next = await second.result;
  assert.equal(next.status, 'succeeded', next.stderr || next.error);
  assert.notEqual(timed.cwd, next.cwd);
});

test('a recovered running receipt reports interruption and does not redispatch or signal its PID', async t => {
  const running = Promise.withResolvers<CsvJobEvent['attempt']>();
  const { runner, dataDir } = await fixture(t, { onEvent(event) {
    if (event.type === 'process_started' && event.attempt.pid) {
      process.kill(event.attempt.pid, 'SIGSTOP');
      running.resolve(event.attempt);
    }
  } });
  const grant = await runner.grant({ ...file, bytes: Buffer.from('x\n5\n') });
  const handle = runner.start({ ...match, grantId: grant.id });
  const prior = await running.promise;
  const observed = Promise.withResolvers<CsvJobEvent['attempt']>();
  const recovered = new CsvJobRunner({ dataDir, recoveredAttempts: [prior], onEvent: event => observed.resolve(event.attempt) });
  t.after(() => recovered.close());
  const restored = await observed.promise;
  assert.equal(restored.pid, prior.pid);
  assert.equal(restored.status, 'interrupted');
  assert.equal(restored.cancellation, 'unknown');
  assert.equal(restored.exitCode, null);
  assert.throws(() => recovered.start({ ...match, grantId: grant.id }), { code: 'DUPLICATE_ATTEMPT' });

  // The original handle alone can terminate this stopped process. Confirm it
  // was live before that handle acted, and that the owning runner saw the exit.
  assert.ok(prior.pid);
  assert.equal(process.kill(-prior.pid, 0), true);
  handle.cancel();
  assert.equal((await handle.result).cancellation, 'confirmed');
});
