import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile, realpath, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { TaskManager } from '../runtime/manager.ts';
import { freeCadSpec, type FreeCadSpec } from '../runtime/freecad.ts';
import { createPrivateDirectory } from '../runtime/private-storage.ts';
import { privateTestDirectory } from './platform-test-helpers.ts';

const block = Object.freeze({ name: 'test_part', length: 40, width: 20, height: 10, diameter: 6 });
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type Snapshot = ReturnType<TaskManager['getSnapshot']>;
type Wire = { messages: { role: string; content: unknown }[]; tools: { function: { name: string } }[] };

function complete(res: ServerResponse, callTool: boolean) {
  const delta = callTool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call_' + randomUUID(), type: 'function',
    function: { name: 'freecad_run', arguments: '{}' } }] } : { role: 'assistant', content: 'The FreeCAD tool has reported its result.' };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [content, reason] of [[delta, null], [{}, callTool ? 'tool_calls' : 'stop']]) {
    res.write('data: ' + JSON.stringify({ id: 'cad-fixture', object: 'chat.completion.chunk', created: 1,
      model: 'cad-fixture', choices: [{ index: 0, delta: content, finish_reason: reason }] }) + '\n\n');
  }
  res.end('data: [DONE]\n\n');
}

function terminal(manager: TaskManager) {
  const done = (state: Snapshot) => ['succeeded', 'failed', 'cancelled', 'paused'].includes(state.run.status);
  const state = manager.getSnapshot();
  if (done(state)) return Promise.resolve(state);
  return new Promise<Snapshot>(resolve => {
    const unsubscribe = manager.subscribe(next => {
      if (done(next as Snapshot)) { unsubscribe(); resolve(manager.getSnapshot()); }
    });
  });
}

async function fixture(t: TestContext) {
  const server = createServer(async (req, res) => {
    try {
      const content: Buffer[] = [];
      for await (const chunk of req) content.push(chunk);
      const wire = JSON.parse(Buffer.concat(content).toString('utf8')) as Wire;
      const recent = wire.messages.slice(wire.messages.findLastIndex(message => message.role === 'user') + 1);
      complete(res, wire.tools.some(tool => tool.function.name === 'freecad_run') && !recent.some(message => message.role === 'tool'));
    } catch {
      res.writeHead(500).end();
    }
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  process.env.ATHENA_ENDPOINT = 'http://127.0.0.1:' + address.port + '/v1';
  process.env.ATHENA_MODEL = 'cad-fixture';
  delete process.env.ATHENA_API_KEY;
  const retained = process.env.ATHENA_TEST_FREECAD_EVIDENCE;
  if (retained) createPrivateDirectory(retained);
  const directory = await realpath(privateTestDirectory(join(retained ?? tmpdir(), 'athena-cad-')));
  if (retained) t.diagnostic('Evidence workspace ' + directory);
  else t.after(() => rm(directory, { recursive: true, force: true }));
  const manager = new TaskManager({ dataDir: directory });
  t.after(() => manager.close());
  await manager.initialize();
  const { project } = await manager.createProject({ name: 'FreeCAD acceptance' });
  const { sessionId } = await manager.createSession({ projectId: project.id, title: 'FreeCAD acceptance' });
  return { manager, directory, sessionId };
}

async function assertVerified(manager: TaskManager, sessionId: string, state: Snapshot, spec: FreeCadSpec = block, route = 'api') {
  const process = state.processes.find(row => row.runId === state.run.id && row.job.freecad);
  assert.equal(state.run.status, 'succeeded', process?.job.error);
  assert.equal(process?.job.freecad?.route, route);
  assert.equal(process?.job.freecad?.outcome, 'verified');
  const files = state.artifacts.filter(artifact => artifact.runId === state.run.id);
  assert.deepEqual(files.map(file => file.title).sort(), ['freecad-verification.json', spec.name + '.FCStd', spec.name + '.step'].sort());
  assert.ok(state.tasks.some(task => task.runId === state.run.id && files.every(file => task.artifactIds.includes(file.id))));
  assert.ok(state.events.some(event => event.runId === state.run.id && event.summary.includes('read-only FreeCAD verifier')));
  const reportAsset = files.find(file => file.title === 'freecad-verification.json')!;
  const report = JSON.parse((await manager.artifactDownload(sessionId, reportAsset.id)).bytes.toString('utf8'));
  assert.equal(report.route, route);
  assert.equal(report.readOnlyReopen, true);
  for (const file of files.filter(item => item.id !== reportAsset.id)) {
    const bytes = (await manager.artifactDownload(sessionId, file.id)).bytes;
    assert.equal(digest(bytes), report.sha256[file.title]);
    assert.equal(digest(await readFile(join(process.job.freecad!.outputDirectory, file.title))), report.sha256[file.title]);
    const geometry = report.files[file.title];
    assert.equal(geometry.units, 'mm');
    assert.deepEqual(geometry.dimensionsMm, [spec.length, spec.width, spec.height]);
    assert.deepEqual(geometry.throughHole, { diameterMm: spec.diameter, centerMm: [spec.length / 2, spec.width / 2], depthMm: spec.height });
    assert.equal(geometry.closed && geometry.valid && geometry.solids === 1, true);
    assert.ok(Math.abs(geometry.volumeMm3 - (spec.length * spec.width - Math.PI * (spec.diameter / 2) ** 2) * spec.height) < 0.001);
    if (spec === block) assert.ok(Math.abs(geometry.volumeMm3 - 7717.2567) < 0.0001);
  }
  return files.find(file => file.title.endsWith('.FCStd'))!;
}

test('FreeCAD requests only accept scoped basenames, finite units and a feasible through-hole', () => {
  assert.deepEqual(freeCadSpec(block), block);
  for (const input of [{ ...block, name: '../part' }, { ...block, name: 'NUL' },
    { ...block, length: 1 }, { ...block, diameter: 6.002 }, { ...block, height: Infinity },
    { ...block, command: 'unexpected' }]) assert.throws(() => freeCadSpec(input), TypeError);
});

test('real FreeCAD API creates, reopens, publishes and edits the acceptance part', {
  skip: process.env.ATHENA_TEST_FREECAD !== 'api', timeout: 100_000,
}, async t => {
  delete process.env.ATHENA_FREECAD_API_AUTHORING;
  const { manager, sessionId, directory } = await fixture(t);
  assert.equal(manager.getFreeCadStatus(sessionId).available, true);
  const first = await manager.startFreeCad(sessionId, randomUUID(), block);
  assert.equal(first.success, true);
  const source = await assertVerified(manager, sessionId, await terminal(manager));
  const before = await manager.artifactDownload(sessionId, source.id);
  const updated = { ...block, name: 'edited_part', width: 24, sourceArtifactId: source.id };
  assert.equal((await manager.startFreeCad(sessionId, randomUUID(), updated)).success, true);
  await assertVerified(manager, sessionId, await terminal(manager), updated);
  await manager.close();
  const reopened = new TaskManager({ dataDir: directory });
  try {
    await reopened.initialize();
    assert.deepEqual((await reopened.artifactDownload(sessionId, source.id)).bytes, before.bytes);
    assert.ok(reopened.getSnapshot().processes.some(row => row.job.freecad?.outcome === 'verified'));
  } finally { await reopened.close(); }
});
