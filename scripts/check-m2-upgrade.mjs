// Run first against an M2 host with a fresh data directory, then against M2.1
// using that same directory. Nothing is written in inspection mode.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const [mode, address, expected] = process.argv.slice(2);
const base = new URL(address);
assert.equal(base.hostname, '127.0.0.1');
assert.ok(mode === 'seed' || (mode === 'compare' && expected));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function rpc(method, ...args) {
  const r = await fetch(new URL('/api/rpc', base), { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, args }) });
  const data = await r.json();
  assert.ok(r.ok, data.error);
  return data.result;
}
async function bootstrap() {
  const r = await fetch(new URL('/api/bootstrap', base));
  assert.ok(r.ok); return r.json();
}

if (mode === 'seed') {
  const { connection, snapshot } = await bootstrap();
  assert.equal(snapshot.projects.length, 0, 'Seed only a new, empty workspace.');
  const { configuration } = connection;
  assert.equal((await rpc('verifyConnection', configuration)).status, 'connected');
  const { configurationId } = await rpc('saveConfig', configuration);
  const { project } = await rpc('createProject', { name: 'M2 upgrade check' });
  const { sessionId } = await rpc('createSession', { projectId: project.id, title: 'Legacy CSV result', configurationId });
  const { fileReferences } = await rpc('stageFiles', sessionId, [{ name: 'voltage.csv', mimeType: 'text/csv',
    data: Buffer.from('trial,voltage\nA,5\nB,11\n').toString('base64') }]);
  const ack = await rpc('pi', sessionId, { type: 'prompt', id: randomUUID(), fileReferences,
    message: 'Delegate to one child: use calculate_csv on the voltage column of voltage.csv. Wait for the child and give the mean and generated statistics.json link.' });
  assert.ok(ack.success, ack.error);
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const { snapshot: s } = await bootstrap();
    if (['succeeded', 'failed', 'paused', 'cancelled'].includes(s.run.status)) break;
    await delay(300);
  }
}
const { snapshot: s } = await bootstrap();
assert.equal(s.run.status, 'succeeded');
const files = s.artifacts.filter(a => a.runId === s.run.id);
assert.ok(files.length > 0, 'Missing legacy artifact.');
const artifacts = await Promise.all(files.map(async a => {
  const uri = new URL(a.location.uri, base); assert.equal(uri.origin, base.origin);
  const r = await fetch(uri); assert.ok(r.ok);
  const bytes = Buffer.from(await r.arrayBuffer());
  const stat = JSON.parse(bytes).statistics.find(c => c.column === 'voltage');
  assert.equal(stat?.mean, 8); assert.equal(a.file.sha256, sha(bytes));
  return { uri: a.location.uri, sha256: sha(bytes), bytes: bytes.length, mean: stat.mean };
}));
const tasks = s.tasks.filter(t => t.runId === s.run.id);
assert.ok(tasks.some(t => t.parentTaskId));
const histories = await Promise.all(tasks.map(async t => {
  const { messages } = await rpc('getAgentHistory', s.sessionId, t.agentSessionId);
  return { taskId: t.id, agentSessionId: t.agentSessionId, sha256: sha(JSON.stringify(messages)) };
}));
const execution = Object.fromEntries(['tasks', 'attempts', 'tools', 'processes'].map(k => [k,s[k].filter(row => row.runId === s.run.id)]));
const summary = { sessionId: s.sessionId, runId: s.run.id, histories, artifacts, executionSha256: sha(JSON.stringify(execution)) };
if (mode === 'compare') assert.deepEqual(summary, JSON.parse(await readFile(expected, 'utf8')));
console.log(JSON.stringify(summary, null, 2));
