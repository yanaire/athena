import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const program = `import csv,json,statistics
from pathlib import Path
rows=list(csv.DictReader(Path('settling.csv').open()))
excluded=[row['trial'] for row in rows if not row['settling_ms'].strip()]
clean=sorted((row for row in rows if row['settling_ms'].strip()),key=lambda row:float(row['settling_ms']))
with Path('/outputs/clean.csv').open('w',newline='') as handle:
    writer=csv.DictWriter(handle,fieldnames=['trial','settling_ms'],lineterminator='\\n')
    writer.writeheader()
    writer.writerows(clean)
values=[float(row['settling_ms']) for row in clean]
Path('/outputs/result.json').write_text(json.dumps({'excluded':excluded,'median_ms':statistics.median(values),'population_sd_ms':statistics.pstdev(values)}))
`;

// The model is a loopback wire fixture. Pi, tools, WASI, storage, HTTP and SSE are real.
test('settling CSV flows through two Pi agents, WASI outputs, streamed prose and durable restore',
  { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'athena-settling-'));
  const input = await readFile(new URL('../docs/m21/settling.csv', import.meta.url));
  const wireErrors = [];
  let requests = 0;
  const model = createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, undefined);
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const wire = JSON.parse(Buffer.concat(chunks));
      requests++;
      const results = wire.messages.filter(message => message.role === 'tool').map(message => message.content);
      const parent = wire.tools.some(tool => tool.function.name === 'spawn_agent');
      const users = JSON.stringify(wire.messages.filter(message => message.role === 'user'));
      let next;
      if (parent) {
        switch (results.length) {
          case 0: next = { name: 'spawn_agent', args: { title: 'Missing value audit', prompt: 'Audit missing values.' } }; break;
          case 1: next = { name: 'spawn_agent', args: { title: 'Settling calculation', prompt: 'Calculate settling outputs.' } }; break;
          case 2: next = { name: 'wait_for_agents', args: {} }; break;
          case 3: {
            const joined = JSON.parse(results[2]);
            const artifact = joined.tasks.flatMap(task => task.artifacts).find(file => file.name === 'result.json');
            assert.ok(artifact, JSON.stringify(joined));
            next = { name: 'read_file', args: { artifactId: artifact.id } }; break;
          }
          default: {
            const measured = JSON.parse(JSON.parse(results[3]).content);
            next = `Excluded ${measured.excluded.join(', ')}. Median ${measured.median_ms} ms; population SD ${measured.population_sd_ms} ms.`;
          }
        }
      } else if (users.includes('Audit missing values.')) {
        if (!results.length) next = { name: 'read', args: {} };
        else {
          assert.equal(results[0], input.toString());
          next = 'T2 has a missing settling value.';
        }
      } else {
        switch (results.length) {
          case 0: next = { name: 'write_file', args: { name: 'analysis.py', content: program } }; break;
          case 1: next = { name: 'run_command', args: { language: 'python', script: 'analysis.py',
            inputs: ['settling.csv'], outputs: ['clean.csv', 'result.json'] } }; break;
          default: {
            const result = JSON.parse(results[1]);
            assert.equal(result.status, 'succeeded', results[1]);
            next = 'The sorted CSV and computed JSON are published.';
          }
        }
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const emit = (delta, finish_reason = null) => response.write('data: ' + JSON.stringify({
        id: 'settling-wire', object: 'chat.completion.chunk', created: 1, model: 'settling',
        choices: [{ index: 0, delta, finish_reason }],
      }) + '\n\n');
      if (typeof next === 'string') {
        emit({ role: 'assistant' });
        for (const content of next.match(/.{1,11}/gs)) emit({ content });
        emit({}, 'stop');
      } else {
        emit({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_' + wire.messages.length,
          type: 'function', function: { name: next.name, arguments: JSON.stringify(next.args) } }] });
        emit({}, 'tool_calls');
      }
      response.end('data: [DONE]\n\n');
    } catch (error) {
      wireErrors.push(error);
      response.writeHead(500); response.end('Controlled fixture failed');
    }
  });
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  const stops = [];
  t.after(async () => {
    for (const stop of stops) await stop();
    model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const env = { ...process.env, HOME: directory, ATHENA_DATA_DIR: directory, ATHENA_PORT: '0',
    ATHENA_ENDPOINT: `http://127.0.0.1:${model.address().port}/v1`, ATHENA_MODEL: 'settling',
    ATHENA_API_KEY: '', ATHENA_PROVIDER: '', ATHENA_AUTH_PATH: '', ATHENA_EXECUTION_PROJECTS: '',
    ATHENA_CREDENTIAL_KEY: randomBytes(32).toString('hex'), ATHENA_MODEL_CONCURRENCY: '1', ATHENA_MAX_CHILDREN: '2' };
  async function start() {
    const child = spawn(process.execPath, ['runtime/server.ts'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const exited = once(child, 'exit');
    const stop = async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await exited; };
    stops.push(stop);
    for await (const line of createInterface({ input: child.stdout })) {
      if (line.startsWith('Athena listening at ')) return { base: line.slice(20), stop };
    }
    throw new Error('Host failed to start: ' + stderr);
  }
  let host = await start();
  const rpc = async (method, ...args) => {
    const response = await fetch(host.base + '/api/rpc', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) });
    const body = await response.json();
    assert.equal(response.ok, true, JSON.stringify(body)); return body.result;
  };
  const { project } = await rpc('createProject', { name: 'Controlled settling' });
  const { sessionId } = await rpc('createSession', { projectId: project.id, title: 'Settling fixture' });
  await rpc('setProjectExecution', project.id, true);
  const { fileReferences } = await rpc('stageFiles', sessionId, [{
    name: 'settling.csv', mimeType: 'text/csv', data: input.toString('base64'),
  }]);
  const initial = await fetch(host.base + '/api/bootstrap').then(response => response.json());
  const controller = new AbortController();
  t.after(() => controller.abort());
  const stream = await fetch(host.base + `/api/events?epoch=${initial.cursor.epoch}&after=${initial.cursor.sequence}`,
    { signal: controller.signal });
  const events = [];
  const settled = (async () => {
    let buffer = '';
    for await (const chunk of stream.body.pipeThrough(new TextDecoderStream())) {
      buffer += chunk;
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const data = frame.split('\n').find(line => line.startsWith('data: '));
        if (!data) continue;
        const event = JSON.parse(data.slice(6)); events.push(event);
        if (event.type === 'snapshot' && ['succeeded', 'failed', 'cancelled'].includes(event.snapshot.run.status)) return event.snapshot;
      }
    }
    throw new Error('SSE ended before the run settled');
  })();
  await rpc('pi', sessionId, { type: 'prompt', id: 'settling-acceptance',
    message: 'Audit missing values and calculate sorted settling statistics.', fileReferences });
  const snapshot = await settled;
  assert.deepEqual(wireErrors, []);
  assert.equal(snapshot.run.status, 'succeeded');
  const coordinator = snapshot.tasks.find(task => task.parentTaskId === null);
  assert.ok(coordinator);
  const children = snapshot.tasks.filter(task => task.parentTaskId === coordinator.id);
  assert.equal(children.length, 2);
  const waiting = events.find(event => event.type === 'snapshot' && event.snapshot.run.status === 'blocked');
  assert.ok(waiting, 'The coordinator releases its slot while joining children');
  assert.deepEqual(waiting.snapshot.tasks.find(task => task.id === coordinator.id).dependencies,
    children.map(task => task.id), 'The workflow must show the actual joined task dependencies');
  assert.equal(snapshot.agents.length, 3);
  assert.ok(snapshot.agents.every(agent => agent.status === 'succeeded'));
  const execution = snapshot.processes[0];
  assert.equal(snapshot.processes.length, 1);
  assert.equal(execution.status, 'succeeded');
  assert.equal(execution.job.analysis.backend, 'wasi');
  assert.deepEqual(execution.evidence, [{ id: fileReferences[0].id, version: digest(input) }]);
  const downloaded = new Map();
  for (const artifact of snapshot.artifacts) {
    const response = await fetch(host.base + artifact.location.uri);
    assert.equal(response.ok, true);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(digest(bytes), artifact.file.sha256);
    downloaded.set(artifact.file.name, bytes.toString());
  }
  assert.deepEqual([...downloaded.keys()], ['analysis.py', 'clean.csv', 'result.json']);
  assert.equal(downloaded.get('analysis.py'), program);
  assert.equal(downloaded.get('clean.csv'), 'trial,settling_ms\nT3,6\nT4,12\nT1,18\nT5,24\n');
  assert.deepEqual(JSON.parse(downloaded.get('result.json')), {
    excluded: ['T2'], median_ms: 15, population_sd_ms: 6.708203932499369,
  });
  const prose = events.filter(event => event.type === 'pi' && event.sessionId === sessionId)
    .map(event => event.event.assistantMessageEvent).filter(event => event?.type === 'text_delta')
    .map(event => event.delta).join('');
  assert.equal(prose, 'Excluded T2. Median 15 ms; population SD 6.708203932499369 ms.');
  const history = await rpc('pi', sessionId, { type: 'get_messages' });
  const requestCount = requests;
  controller.abort(); await host.stop(); host = await start();
  const restored = await fetch(host.base + '/api/bootstrap').then(response => response.json());
  assert.equal(restored.snapshot.run.id, snapshot.run.id);
  assert.deepEqual(restored.snapshot.tasks, snapshot.tasks);
  assert.deepEqual(await rpc('pi', sessionId, { type: 'get_messages' }), history);
  for (const artifact of restored.snapshot.artifacts) {
    assert.equal(await fetch(host.base + artifact.location.uri).then(response => response.text()),
      downloaded.get(artifact.file.name));
  }
  const reset = await fetch(host.base + `/api/events?epoch=${initial.cursor.epoch}&after=${initial.cursor.sequence}`)
    .then(response => response.text());
  assert.equal(JSON.parse(reset.slice(6)).type, 'reset');
  assert.equal(requests, requestCount, 'Restoring never dispatches a model request');
});
