import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createCodeModeFixture, expected } from './support/code-mode-fixture.mjs';

const code = (snapshot, runId = snapshot.run.id) => snapshot.processes.filter(item => item.runId === runId && item.job.codeMode);
const finishedReads = row => row.job.codeMode.calls.map(call => call.status);
const sourceRefs = list => list.map(({id, version, sha256}) => ({id, version, sha256}));
const pending = row => row.job.codeMode.calls.some(call => call.status === 'running') && row.job.codeMode.calls.some(call => call.status === 'queued');

test('real Pi and JobRunner publish and transfer mission results to all three read paths', {timeout:55_000}, async t => {
  const fixture = await createCodeModeFixture({allowGateFixture:true});
  t.after(() => fixture.close());
  const {sessionId} = await fixture.conversation();
  const run = await fixture.submit(sessionId, 'benchmark');
  const snapshot = await fixture.finished(run);
  assert.equal(snapshot.run.status,'succeeded');
  const {report} = fixture.state('benchmark');
  for (const mode of ['A','B','C']) {
    assert.deepEqual(report[mode].result,expected);
    assert.deepEqual(sourceRefs(report[mode].sources),sourceRefs(report.A.sources));
    assert.equal(report[mode].sources.length,4);
    await fixture.verifySources(snapshot, report[mode]);
  }
  const [process] = code(snapshot);
  assert.equal(process.status,'succeeded');
  assert.equal(process.id,report.C.executionId);
  assert.deepEqual(process.job.codeMode.result,expected);
  assert.equal(process.job.codeMode.peakConcurrency,1);
  assert.deepEqual(finishedReads(process),Array(5).fill('succeeded'));
  assert.deepEqual(sourceRefs(process.job.codeMode.calls.flatMap(call => call.source ? [call.source] : [])),sourceRefs(report.C.sources));
  assert.deepEqual(process.evidence.map(({id,version}) => [id,version]),report.C.sources.map(({id,version}) => [id,version]));
  const tool = snapshot.tools.find(tool => tool.id === process.toolId);
  assert.equal(tool.sdkToolName,'run_code');
  assert.equal(process.job.codeMode.sourceSha256,createHash('sha256').update(tool.args.source).digest('hex'));
  assert.ok(process.job.codeMode.calls.every(call => call.id.startsWith(process.id)
    && call.contractHash.length === 64 && call.argumentsSha256.length === 64 && call.resultSha256.length === 64));
  assert.equal(snapshot.artifacts.length,5);
  assert.equal(snapshot.processes.filter(process => process.job.mcp).length,5);
  assert.ok(snapshot.artifacts.every(artifact => artifact.processId && artifact.processId !== process.id));
  assert.equal(snapshot.tasks.length,9,'Nested reads do not create tasks.');
});

test('roles, grants, project and session scope hold, with stale and invalid tool receipts', {timeout:70_000}, async t => {
  const fixture = await createCodeModeFixture({allowGateFixture:true});
  t.after(() => fixture.close());
  const foreign = await fixture.conversation();
  await fixture.finished(await fixture.submit(foreign.sessionId, 'foreign'));
  const local = await fixture.conversation();
  await fixture.finished(await fixture.submit(local.sessionId, 'sibling'));
  const {sessionId} = await fixture.conversation({projectId:local.projectId});
  let snapshot = await fixture.finished(await fixture.submit(sessionId, 'scope'));
  assert.equal(snapshot.run.status,'succeeded');
  const {report} = fixture.state('scope');
  assert.deepEqual(report.C.result,{...expected,denied:Array(3).fill('ARTIFACT_DENIED')});
  await fixture.verifySources(snapshot, report.C);
  const [partial] = code(snapshot);
  assert.deepEqual(finishedReads(partial),[...Array(5).fill('succeeded'), ...Array(3).fill('failed')]);
  assert.ok(partial.job.codeMode.calls.slice(5).every(call => !call.source && call.error.code === 'ARTIFACT_DENIED'));
  snapshot = await fixture.finished(await fixture.submit(sessionId, 'invalid'));
  const [stale, attempted] = code(snapshot);
  assert.equal(stale.job.codeMode.error.code,'CONTRACT_CHANGED');
  assert.equal(stale.job.startedAt,null);
  assert.equal(stale.job.codeMode.calls.length,0);
  assert.deepEqual(attempted.job.codeMode.result,['INVALID_INPUT','TOOL_UNAVAILABLE','CONTRACT_CHANGED','TOOL_NOT_BOUND']);
  assert.deepEqual(attempted.job.codeMode.calls.map(call => call.error.code),attempted.job.codeMode.result);
  snapshot = await fixture.finished(await fixture.submit(sessionId, 'role'));
  assert.equal(code(snapshot).length,0);
  await fixture.rpc('setProjectExecution',[local.projectId,false]);
  snapshot = await fixture.finished(await fixture.submit(sessionId, 'disabled'));
  assert.equal(code(snapshot).length,0);
  assert.ok(snapshot.tools.some(tool => tool.runId === snapshot.run.id && tool.sdkToolName === 'discover_read_tools' && tool.status === 'succeeded'));
});

test('caught read failures still stop the Pi attempt and syntax failure has no calls', {timeout:55_000}, async t => {
  const fixture = await createCodeModeFixture({allowGateFixture:true});
  t.after(() => fixture.close());
  const {sessionId} = await fixture.conversation();
  let snapshot = await fixture.finished(await fixture.submit(sessionId, 'syntax'));
  const [syntax] = code(snapshot);
  assert.equal(syntax.status,'failed');
  assert.equal(syntax.job.codeMode.error.code,'SYNTAX_ERROR');
  assert.deepEqual(syntax.job.codeMode.calls,[]);
  snapshot = await fixture.finished(await fixture.submit(sessionId, 'budget'));
  const [stopped] = code(snapshot);
  assert.equal(stopped.status,'failed');
  assert.equal(stopped.job.codeMode.error.code,'TOOL_FAILURE_LIMIT');
  assert.equal(stopped.job.codeMode.result,undefined);
  assert.deepEqual(finishedReads(stopped),['failed','failed','failed']);
  assert.equal(snapshot.tasks.find(task => task.id === stopped.taskId).status,'failed');
  assert.ok(snapshot.events.some(event => event.type === 'tool_failure_limit' && event.toolId === stopped.toolId));
});

test('Stop and hard restart keep completed reads and never replay pending work', {timeout:85_000}, async t => {
  const fixture = await createCodeModeFixture({allowGateFixture:true});
  t.after(() => fixture.close());
  const {sessionId} = await fixture.conversation();
  const run = await fixture.submit(sessionId, 'cancel');
  let snapshot = await fixture.waitSnapshot(snapshot => code(snapshot,run).some(pending));
  const [active] = code(snapshot,run);
  await fixture.rpc('cancelRun',[run]);
  snapshot = await fixture.finished(run);
  const [cancelled] = code(snapshot);
  assert.equal(cancelled.status,'cancelled');
  assert.equal(cancelled.id,active.id);
  assert.equal(finishedReads(cancelled)[0],'succeeded');
  assert.ok(finishedReads(cancelled).includes('cancelled'));
  assert.ok(finishedReads(cancelled).includes('not_dispatched'));
  await delay(2000);
  assert.deepEqual(code(await fixture.rpc('getSnapshot')),[cancelled]);

  // Clear the fixture delay during authoring and transfer in a new isolated host.
  const crashed = await createCodeModeFixture({allowGateFixture:true});
  t.after(() => crashed.close());
  const next = await crashed.conversation();
  const restartRun = await crashed.submit(next.sessionId,'restart');
  const before = await crashed.waitSnapshot(snapshot => code(snapshot,restartRun).some(pending));
  await crashed.stopHost(true);
  const hits = crashed.requests.length;
  await crashed.startHost();
  const recovered = await crashed.rpc('getSnapshot');
  assert.equal(recovered.run.status,'paused');
  const [receipt] = code(recovered);
  assert.equal(receipt.id,code(before)[0].id);
  assert.equal(receipt.status,'interrupted');
  assert.equal(finishedReads(receipt)[0],'succeeded');
  assert.ok(finishedReads(receipt).includes('interrupted'));
  assert.ok(finishedReads(receipt).includes('not_dispatched'));
  await delay(300);
  assert.equal(crashed.requests.length,hits);
});

test('revoking existing file permission invalidates an already issued response and subsequent reads', {timeout:55_000}, async t => {
  const fixture = await createCodeModeFixture({allowGateFixture:true});
  t.after(() => fixture.close());
  const {projectId,sessionId} = await fixture.conversation();
  const run = await fixture.submit(sessionId,'revoke');
  await fixture.waitSnapshot(snapshot => code(snapshot,run).some(pending));
  fixture.revokeForTest(projectId);
  const snapshot = await fixture.finished(run);
  const [receipt] = code(snapshot);
  assert.deepEqual(finishedReads(receipt),['succeeded','failed','failed','failed','failed']);
  assert.ok(receipt.job.codeMode.calls.slice(1).every(call => !call.source && ['EXECUTION_DISABLED','TOOL_UNAVAILABLE'].includes(call.error.code)));
  assert.deepEqual(fixture.state('revoke').report.C.sources,[]);
  assert.equal(receipt.job.codeMode.result.readFailures.length,4);
});
