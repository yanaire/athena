import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { inflateSync } from 'node:zlib';
import { TaskManager } from '../runtime/manager.ts';
import { FreeCadAdapter, freeCadSpec, type FreeCadSpec } from '../runtime/freecad.ts';
import { DesktopError } from '../runtime/desktop-control.ts';
import { createPrivateDirectory } from '../runtime/private-storage.ts';
import { privateTestDirectory } from './platform-test-helpers.ts';

const block = Object.freeze({ name: 'test_part', length: 40, width: 20, height: 10, diameter: 6 });
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type Snapshot = ReturnType<TaskManager['getSnapshot']>;
type Wire = { messages: { role: string; content: unknown }[]; tools: { function: { name: string } }[] };

function complete(res: ServerResponse, call?: { name: string; args: object }) {
  const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call_' + randomUUID(), type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : { role: 'assistant', content: 'The FreeCAD tool has reported its result.' };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [content, reason] of [[delta, null], [{}, call ? 'tool_calls' : 'stop']]) {
    res.write('data: ' + JSON.stringify({ id: 'cad-fixture', object: 'chat.completion.chunk', created: 1,
      model: 'cad-fixture', choices: [{ index: 0, delta: content, finish_reason: reason }] }) + '\n\n');
  }
  res.end('data: [DONE]\n\n');
}

function images(value: unknown): Buffer[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(part => {
    const url = part?.type === 'image_url' ? part.image_url?.url : undefined;
    return typeof url === 'string' && url.startsWith('data:image/png;base64,')
      ? [Buffer.from(url.slice('data:image/png;base64,'.length), 'base64')] : [];
  });
}

function swatchColor(png: Buffer) {
  assert.equal(png.readUInt32BE(16), 64);
  assert.equal(png.readUInt32BE(20), 64);
  assert.equal(png[24], 8);
  assert.equal(png[25], 2);
  const data: Buffer[] = [];
  for (let offset = 8; offset + 12 <= png.length;) {
    const size = png.readUInt32BE(offset);
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') data.push(png.subarray(offset + 8, offset + 8 + size));
    offset += size + 12;
  }
  const row = inflateSync(Buffer.concat(data));
  const values = [...row.subarray(1, 4)];
  return ['red', 'green', 'blue'][values.indexOf(Math.max(...values))];
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
  const frames: Buffer[] = [];
  let probes = 0;
  const server = createServer(async (req, res) => {
    try {
      const content: Buffer[] = [];
      for await (const chunk of req) content.push(chunk);
      const wire = JSON.parse(Buffer.concat(content).toString('utf8')) as Wire;
      const pngs = wire.messages.flatMap(message => images(message.content));
      if (wire.tools.some(tool => tool.function.name === 'athena_check_window_image')) {
        assert.equal(pngs.length, 1);
        assert.ok(wire.messages.some(message => message.role === 'tool'));
        probes++;
        complete(res, { name: 'athena_check_window_image', args: { color: swatchColor(pngs[0]!) } });
        return;
      }
      frames.push(...pngs);
      const recent = wire.messages.slice(wire.messages.findLastIndex(message => message.role === 'user' && !images(message.content).length) + 1);
      const call = wire.tools.some(tool => tool.function.name === 'freecad_run') && !recent.some(message => message.role === 'tool');
      complete(res, call ? { name: 'freecad_run', args: {} } : undefined);
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
  return { manager, directory, sessionId, frames, probes: () => probes };
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

test('FreeCAD denies GUI fallback after permission denial or a write with an unknown outcome', async t => {
  let code: 'denied' | 'indeterminate' = 'denied';
  let authors = 0;
  t.mock.method(FreeCadAdapter.prototype, 'author', async (
    _workspace: string, _spec: FreeCadSpec, _signal: AbortSignal, started: (pid: number) => void,
  ) => {
    authors++;
    if (code === 'indeterminate') started(12345);
    throw new DesktopError(code, 'Controlled authoring outcome.');
  });
  const { manager, sessionId, probes } = await fixture(t);
  for (const expected of ['denied', 'indeterminate', 'indeterminate'] as const) {
    await manager.startFreeCad(sessionId, randomUUID(), block, true);
    const state = await terminal(manager);
    const job = state.processes.find(row => row.runId === state.run.id)?.job;
    assert.equal(job?.freecad?.outcome, expected);
    assert.equal(job?.freecad?.route, 'api');
    code = 'indeterminate';
  }
  assert.equal(probes(), 0);
  assert.equal(authors, 2, 'the third request must not invoke the writer');
});

test('FreeCAD reports a text-only connection before running any window input', async t => {
  delete process.env.ATHENA_MODEL_IMAGE_INPUT;
  t.mock.method(FreeCadAdapter.prototype, 'installation', () => ({ app: '/mock/FreeCAD',
    python: undefined, modules: undefined, authoringUnsupported: true }));
  const { manager, sessionId, probes } = await fixture(t);
  await manager.startFreeCad(sessionId, randomUUID(), block, true);
  const state = await terminal(manager);
  const job = state.processes.find(row => row.runId === state.run.id)?.job;
  assert.match(job?.error ?? '', /does not declare image input/);
  assert.equal(job?.freecad?.outcome, 'unsupported');
  assert.equal(job?.pid, null);
  assert.equal(probes(), 0);
});

test('real FreeCAD API creates, reopens, publishes and edits the acceptance part', {
  skip: process.env.ATHENA_TEST_FREECAD !== 'api', timeout: 100_000,
}, async t => {
  delete process.env.ATHENA_FREECAD_API_AUTHORING;
  const { manager, sessionId, directory } = await fixture(t);
  assert.equal((await manager.getFreeCadStatus(sessionId)).available, true);
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

test('real FreeCAD GUI authors both files when API authoring is unsupported and sends actual window pixels', {
  skip: process.env.ATHENA_TEST_FREECAD !== 'gui', timeout: 120_000,
}, async t => {
  process.env.ATHENA_FREECAD_API_AUTHORING = 'unsupported';
  process.env.ATHENA_MODEL_IMAGE_INPUT = '1';
  const { manager, directory, sessionId, frames, probes } = await fixture(t);
  const status = await manager.getFreeCadStatus(sessionId);
  assert.equal(status.available, false);
  assert.equal(status.windowAvailable, true, status.windowReason ?? undefined);
  assert.equal((await manager.startFreeCad(sessionId, randomUUID(), block, true)).success, true);
  const state = await terminal(manager);
  await assertVerified(manager, sessionId, state, block, 'gui');
  assert.equal(probes(), 1);
  assert.equal(frames.length, 1);
  assert.ok(frames[0]!.readUInt32BE(16) > 640 && frames[0]!.readUInt32BE(20) > 480);
  const image = join(directory, 'freecad-window.png');
  await writeFile(image, frames[0]!);
  t.diagnostic('Actual tool result window image ' + image);
  assert.ok(state.events.some(event => event.summary.includes('FreeCAD window · save native')));
  assert.ok(state.events.some(event => event.summary.includes('FreeCAD window · save step')));
  assert.equal(JSON.stringify(state).includes(frames[0]!.toString('base64')), false);

  await manager.pi(sessionId, { type: 'prompt', id: randomUUID(), message: 'Confirm the conversation is available.' });
  await terminal(manager);
  assert.equal(frames.length, 1, 'a later model turn must not receive previous window pixels');
});

test('stopping before verification leaves actual GUI outputs available for a read-only recovery', {
  skip: process.env.ATHENA_TEST_FREECAD !== 'gui', timeout: 120_000,
}, async t => {
  process.env.ATHENA_FREECAD_API_AUTHORING = 'unsupported';
  process.env.ATHENA_MODEL_IMAGE_INPUT = '1';
  const { manager, sessionId, frames } = await fixture(t);
  let stop: Promise<unknown> | undefined;
  const listen = manager.subscribe(state => {
    if (!stop && state.events.some(event => event.runId === state.run.id && event.summary.includes('read-only FreeCAD verifier'))) {
      stop = Promise.resolve().then(() => manager.cancelRun(state.run.id!));
    }
  });
  await manager.startFreeCad(sessionId, randomUUID(), block, true);
  const cancelled = await terminal(manager);
  listen();
  await stop;
  assert.equal(cancelled.run.status, 'cancelled');
  const prior = cancelled.processes.find(row => row.runId === cancelled.run.id)!;
  assert.equal(prior.job.freecad?.recoveryRequired, true);
  const native = join(prior.job.freecad!.outputDirectory, 'test_part.FCStd');
  const checksum = digest(await readFile(native));
  await manager.recoverFreeCad(sessionId, randomUUID(), prior.id);
  const verified = await terminal(manager);
  await assertVerified(manager, sessionId, verified, block, 'recovery');
  assert.equal(digest(await readFile(native)), checksum);
  assert.equal(frames.length, 0);
});

test('real FreeCAD window takeover revokes input and a restarted host checks existing files without replay', {
  skip: process.env.ATHENA_TEST_FREECAD !== 'gui', timeout: 120_000,
}, async t => {
  process.env.ATHENA_FREECAD_API_AUTHORING = 'unsupported';
  process.env.ATHENA_MODEL_IMAGE_INPUT = '1';
  const { manager, directory, sessionId } = await fixture(t);
  let takeover: Promise<unknown> | undefined;
  const stopListening = manager.subscribe(state => {
    if (!takeover && state.events.some(event => event.runId === state.run.id && event.summary.includes('FreeCAD window · new document'))) {
      // Element activation has returned. Queue the user decision before the next observation can authorize input.
      takeover = Promise.resolve().then(() => manager.takeOverFreeCad(sessionId, state.run.id!));
    }
  });
  await manager.startFreeCad(sessionId, randomUUID(), block, true);
  const stopped = await terminal(manager);
  stopListening();
  await takeover;
  assert.equal(stopped.run.status, 'cancelled');
  assert.ok(stopped.events.some(event => event.type === 'desktop_takeover'));
  const prior = stopped.processes.find(row => row.runId === stopped.run.id)!;
  assert.equal(prior.job.freecad?.outcome, 'indeterminate');
  assert.equal(prior.job.freecad?.recoveryRequired, true);
  assert.equal(stopped.events.some(event => event.summary.includes('FreeCAD window · part workbench')), false);
  const stage = prior.job.freecad!.outputDirectory;
  const entries = await readdir(stage);
  assert.equal(entries.some(name => name.endsWith('.FCStd') || name.endsWith('.step')), false);

  await manager.close();
  const restarted = new TaskManager({ dataDir: directory });
  try {
    await restarted.initialize();
    await restarted.startFreeCad(sessionId, randomUUID(), block, true);
    const blocked = await terminal(restarted);
    assert.equal(blocked.processes.find(row => row.runId === blocked.run.id)?.job.freecad?.outcome, 'indeterminate');
    await restarted.recoverFreeCad(sessionId, randomUUID(), prior.id);
    const recovered = await terminal(restarted);
    const check = recovered.processes.find(row => row.runId === recovered.run.id)!;
    assert.equal(check.job.freecad?.route, 'recovery');
    assert.equal(check.job.freecad?.outcome, 'invalid_result');
    assert.deepEqual(await readdir(stage), entries);
    await restarted.startFreeCad(sessionId, randomUUID(), block, true);
    const fresh = await terminal(restarted);
    await assertVerified(restarted, sessionId, fresh, block, 'gui');
    assert.notEqual(fresh.processes.find(row => row.runId === fresh.run.id)?.job.freecad?.outputDirectory, stage);
  } finally { await restarted.close(); }
});
