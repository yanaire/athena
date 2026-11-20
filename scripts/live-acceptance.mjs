// Opt-in: runs actual inference against the configured endpoint. No fixture transport.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

assert.ok(process.env.ATHENA_ENDPOINT && process.env.ATHENA_MODEL, 'Set the endpoint and model first.');
const dataDir = await mkdtemp(join(tmpdir(), 'athena-acceptance-'));
console.log(`Workspace: ${dataDir}`);
let child, url, exited, stream;
async function start() {
  child = spawn(process.execPath, ['runtime/server.ts'], { cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, ATHENA_PORT: '0', ATHENA_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'inherit'] });
  exited = once(child, 'exit');
  for await (const line of createInterface({ input: child.stdout })) {
    if (line.startsWith('Athena listening at ')) { url = line.split(' ').at(-1); return; }
  }
  throw Error('Host stopped before listening.');
}
async function stop() {
  stream?.abort();
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  if (exited) await exited;
}
const bootstrap = async () => (await fetch(url + '/api/bootstrap')).json();
async function rpc(method, ...args) {
  const response = await fetch(url + '/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) });
  const body = await response.json();
  if (!response.ok) throw Error(body.error);
  return body.result;
}
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
try {
  await start();
  const config = (await bootstrap()).connection.configuration;
  const checked = await rpc('verifyConnection', config);
  assert.equal(checked.status, 'connected', checked.message);
  const saved = await rpc('saveConfig', config);
  const { project } = await rpc('createProject', { name: 'File read acceptance' });
  const { sessionId } = await rpc('createSession', { projectId: project.id, title: 'Read a fresh marker', configurationId: saved.configurationId });
  const marker = `ATH-${randomBytes(5).toString('hex')}`;
  const data = Buffer.from(`Calibration serial number: ${marker}\n`);
  const { fileReferences } = await rpc('stageFiles', sessionId, [{ name: 'calibration.txt', mimeType: 'text/plain', data: data.toString('base64') }]);
  const prompt = { type: 'prompt', id: randomUUID(), message: 'Use the read tool on the attached calibration file. Then reply with its exact calibration serial number.', fileReferences };
  stream = new AbortController();
  const deadline = AbortSignal.timeout(180000);
  const sse = await fetch(url + '/api/events', { signal: AbortSignal.any([stream.signal, deadline]) });
  let deltas = 0;
  const settled = (async () => {
    let buf = '';
    for await (const chunk of sse.body.pipeThrough(new TextDecoderStream())) {
      buf += chunk;
      let at;
      while ((at = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, at); buf = buf.slice(at + 2);
        const data = frame.split('\n').find(line => line.startsWith('data: '));
        if (!data) continue;
        const packet = JSON.parse(data.slice(6));
        if (packet.type === 'pi' && packet.sessionId === sessionId && packet.event.assistantMessageEvent?.type === 'text_delta') deltas++;
        if (packet.type === 'snapshot' && packet.snapshot.sessionId === sessionId && ['succeeded', 'failed', 'cancelled', 'paused'].includes(packet.snapshot.run?.status)) return packet.snapshot;
      }
    }
    throw Error('Event stream ended before settlement.');
  })();
  settled.catch(() => {}); // the HTTP ack can fail while the stream is already reading
  const accepted = await rpc('pi', sessionId, prompt);
  assert.equal(accepted.success, true, accepted.error);
  const before = await settled;
  assert.equal(before.run.status, 'succeeded', JSON.stringify(before.events.slice(-2)));
  assert.ok(deltas > 0, 'No live assistant text_delta was observed.');
  const tool = before.tools.find(tool => tool.status === 'succeeded' && tool.sdkToolName === 'read');
  assert.ok(tool, 'Real read call missing.');
  const task = before.tasks.find(t => t.id === tool.taskId);
  assert.ok(task && tool.runId === before.run.id && tool.projectId === project.id && tool.sessionId === sessionId);
  const getMessages = async () => (await rpc('pi', sessionId, { type: 'get_messages', id: randomUUID() })).data.messages;
  const messages = await getMessages();
  const answer = messages.filter(m => m.role === 'assistant').at(-1).content.filter(p => p.type === 'text').map(p => p.text).join('');
  assert.ok(answer.includes(marker), `Answer did not contain the serial: ${answer}`);
  await stop();
  await start();
  const again = await bootstrap();
  assert.equal(again.connection.configurationId, saved.configurationId);
  assert.equal(again.connection.verification.status, 'not_checked');
  assert.equal(again.snapshot.projectId, project.id);
  assert.equal(again.snapshot.run.id, before.run.id);
  assert.ok(again.snapshot.tools.some(t => t.id === tool.id));
  await rpc('openSession', sessionId);
  const reread = await getMessages();
  assert.equal(sha(reread), sha(messages));
  console.log(JSON.stringify({ model: before.run.model, projectId: project.id, sessionId, runId: before.run.id, taskId: task.id, toolId: tool.id,
    fileReference: fileReferences[0].id, deltas, answer, originalSHA256: createHash('sha256').update(data).digest('hex'),
    messages: messages.length, beforeSHA256: sha(messages), afterSHA256: sha(reread), restart: 'PASS' }, null, 2));
} finally { await stop(); }
