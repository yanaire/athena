import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { CODE_LIMITS, executeCode } from '../runtime/code-mode.ts';
import { describeReadTools, checkReadCall, READ_ARTIFACT, RESEARCH_BOARD } from '../runtime/code-mode-contracts.ts';
import { hash, ManagerError } from '../runtime/orchestration.ts';

const run = (source: string, options: Partial<Parameters<typeof executeCode>[0]> = {}) =>
  executeCode({receipt:{id:randomUUID(), sourceSha256:hash(source), language:'javascript', bindings:[],
    limits:CODE_LIMITS, queuedAt:Date.now(), startedAt:Date.now(), endedAt:null, calls:[], peakConcurrency:0},
    source, signal:new AbortController().signal, concurrency:1, update:() => {}, observe:() => {},
    read:async () => ({value:null}), ...options});

async function workerReleased() {
  // The result can settle just ahead of Worker exit. A new run has its own VM.
  await delay(60);
}

test('only authorized local tool metadata and exact, versioned contracts are discoverable', () => {
  const boardOnly = (id: string) => id === RESEARCH_BOARD;
  const result = describeReadTools({}, boardOnly);
  assert.ok('tools' in result);
  assert.deepEqual(result.tools.map(tool => tool.id), [RESEARCH_BOARD]);
  assert.ok(!('inputSchema' in result.tools[0]!));
  const tool = describeReadTools({id:RESEARCH_BOARD}, boardOnly);
  assert.ok('inputSchema' in tool);
  assert.ok('outputSchema' in tool);
  assert.equal(checkReadCall({id:tool.id, version:tool.version, hash:tool.hash, args:{}}, boardOnly).id, tool.id);
  assert.throws(() => describeReadTools({id:READ_ARTIFACT}, boardOnly), {code:'TOOL_UNAVAILABLE'});
  assert.throws(() => checkReadCall({id:tool.id, version:tool.version, hash:tool.hash, args:{projectId:'forged'}}, boardOnly), {code:'INVALID_INPUT'});
  assert.throws(() => checkReadCall({id:tool.id, version:99, hash:tool.hash, args:{}}, boardOnly), {code:'CONTRACT_CHANGED'});
  assert.throws(() => checkReadCall({id:'third-party.read_only', version:1, hash:tool.hash, args:{}}, () => true), {code:'TOOL_UNAVAILABLE'});
});

test('actual QuickJS awaits branching and bounded parallel reads while isolating host facilities', {timeout:12_000}, async () => {
  const result = await run(`
    const values = await Promise.all([4, 5, 6, 7].map(n => tools.call({n})));
    let even = 0;
    for (const n of values) if (n % 2 === 0) even += n;
    let imports = 0;
    for (const name of ['node:fs', 'qjs:std', 'https://localhost/test']) {
      try { await import(name); } catch { imports++; }
    }
    return {even, imports, host: [typeof process, typeof require, typeof fetch, typeof XMLHttpRequest, typeof WebSocket, typeof run_code]};
  `, {concurrency:2, read:async request => { await delay(30); return {value:(request as {n:number}).n}; }});
  assert.deepEqual(result.result, {even:10, imports:3, host:Array(6).fill('undefined')});
  assert.equal(result.peakConcurrency, 2);
  assert.ok(result.calls[1]!.startedAt! <= result.calls[0]!.endedAt!);
  assert.ok(result.calls[2]!.startedAt! >= result.calls[0]!.endedAt!);
  assert.equal(new Set(result.calls.map(call => call.id)).size, 4);
  assert.ok(result.calls.every(call => call.status === 'succeeded' && call.resultSha256));
});

test('syntax, source, active CPU, memory, output and call budgets are enforced in the engine', {timeout:20_000}, async () => {
  for (const [source, code] of [
    ['return const', 'SYNTAX_ERROR'],
    ['throw new SyntaxError("script")', 'SCRIPT_ERROR'],
    ['/*' + '문'.repeat(CODE_LIMITS.sourceBytes / 2) + '*/', 'SOURCE_LIMIT'],
    ['while (true) {}', 'CPU_LIMIT'],
    ['const items = []; while (true) items.push(String(items.length).repeat(65000))', 'RESOURCE_LIMIT'],
    ['return "x".repeat(33000)', 'OUTPUT_LIMIT'],
    ['for (let i=0; i<25; i++) await tools.call({})', 'CALL_LIMIT'],
  ] as const) {
    const result = await run(source);
    assert.equal(result.error?.code, code, JSON.stringify(result));
    assert.equal(result.calls.length, code === 'CALL_LIMIT' ? 24 : 0);
    await workerReleased();
  }
});

test('argument, per-read result, cumulative result and queue limits are checked', {timeout:15_000}, async () => {
  const result = await run(`
    const checks = [];
    for (const input of ["x".repeat(9000), "large", "many", "many", "many", "many", "many"]) {
      try { await tools.call({ input }); checks.push('ok'); }
      catch (error) { checks.push(error.message.split(':')[0]); }
    }
    return checks;
  `, {read:async request => ({value:'x'.repeat((request as {input:string}).input === 'large' ? 132_000 : 125_000)})});
  assert.deepEqual(result.result, ['ARGUMENT_LIMIT','RESULT_LIMIT','ok','ok','ok','ok','RESULT_LIMIT']);
  assert.equal(result.calls[0]?.startedAt, null);
  await workerReleased();
  const queue = await run('return (await Promise.allSettled(Array.from({length:10}, () => tools.call({})))).map(p => p.status)', {
    read:async () => {await delay(45); return {value:1};},
  });
  assert.equal(queue.error, undefined);
  assert.equal(queue.calls.filter(call => call.error?.code === 'QUEUE_FULL').length, 1);
  assert.equal(queue.peakConcurrency, 1);
});

test('partial failure and Stop retain finished reads and reject queued and late outcomes', {timeout:12_000}, async () => {
  const controller = new AbortController();
  const seen: string[] = [];
  let finishLate!: (value: {value:string}) => void;
  const result = await run(`
    await tools.call({ kind: 'first' });
    try { await tools.call({ kind: 'failure' }); } catch {}
    return await Promise.all([tools.call({kind: 'late'}), tools.call({kind: 'queued'})]);
  `, {signal:controller.signal,
    update(trace) {
      if (trace.calls.length === 4 && trace.calls[3]?.status === 'queued') controller.abort();
    },
    read(request) {
      const {kind} = request as {kind:string};
      seen.push(kind);
      if (kind === 'first') return Promise.resolve({value:'read'});
      if (kind === 'failure') throw new ManagerError('ARTIFACT_DENIED', 'This artifact cannot be read.');
      return new Promise(resolve => { finishLate = resolve; });
    },
  });
  assert.equal(result.error?.code, 'CANCELLED');
  assert.deepEqual(seen, ['first','failure','late']);
  assert.deepEqual(result.calls.map(call => call.status), ['succeeded','failed','cancelled','not_dispatched']);
  finishLate({value:'late'});
  await workerReleased();
  assert.equal(result.calls[2]?.resultSha256, undefined);
  const unawaited = await run('void tools.call({}); void tools.call({}); return "done"', {read:async () => { await delay(180); return {value:1}; }});
  assert.equal(unawaited.result, 'done');
  assert.deepEqual(unawaited.calls.map(call => call.status), ['cancelled','not_dispatched']);
});

test('tool waiting has its own deadline and leaves the physical read slot occupied until settlement', {timeout:10_000}, async () => {
  const started = performance.now();
  let observed = 0;
  const result = await run('return (await Promise.allSettled([tools.call({}), tools.call({})])).map(x => x.reason?.message)', {
    read:async () => {observed++; await delay(CODE_LIMITS.toolMs + 80); return {value:'late'};},
  });
  assert.equal(observed, 2);
  assert.deepEqual(result.calls.map(call => call.status), ['timed_out','timed_out']);
  assert.ok(result.calls[1]!.startedAt! >= result.calls[0]!.endedAt!);
  assert.ok(performance.now() - started >= CODE_LIMITS.toolMs * 2);
  assert.ok((result.cpuMs ?? Infinity) < CODE_LIMITS.toolMs);
});

test('successive live reads cannot extend the wall deadline', {timeout:10_000}, async () => {
  const started = performance.now();
  const result = await run('return await Promise.allSettled(Array.from({length:5}, () => tools.call({})))', {
    read:async () => { await delay(1650); return {value:1}; },
  });
  assert.equal(result.error?.code, 'WALL_LIMIT');
  assert.deepEqual(result.calls.map(call => call.status), ['succeeded','succeeded','succeeded','cancelled','not_dispatched']);
  assert.ok(performance.now() - started >= CODE_LIMITS.wallMs - 25);
});
