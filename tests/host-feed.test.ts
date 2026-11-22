import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';

test('HTTP reconnect replays a project created in the bootstrap gap and rejects an old host epoch', { timeout: 15_000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'athena-resume-'));
  const credentialKey = randomBytes(32).toString('hex');
  const stops: (() => Promise<void>)[] = [];
  t.after(async () => {
    for (const stop of stops) await stop();
    await rm(dataDir, { recursive: true, force: true });
  });
  const start = async (projects:string) => {
    const child = spawn(process.execPath, ['runtime/server.ts'], { env: { ...process.env, ATHENA_API_KEY: '', ATHENA_CREDENTIAL_KEY: credentialKey,
      ATHENA_DATA_DIR: dataDir, ATHENA_PORT: '0', ATHENA_MODEL: 'unrequested', ATHENA_ENDPOINT: 'http://127.0.0.1:1/v1',
      ATHENA_EXECUTION_PROJECTS:projects },
      stdio: ['ignore', 'pipe', 'inherit'] });
    const exit = once(child, 'exit');
    const stop = async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await exit; };
    stops.push(stop);
    for await (const line of createInterface({ input: child.stdout })) if (line.startsWith('Athena listening at ')) {
      const base = line.slice('Athena listening at '.length);
      return { base, stop };
    }
    throw new Error('Host exited before listening.');
  };
  const first = await start('*');
  const initial = await fetch(first.base + '/api/bootstrap').then(r => r.json());
  const created = await fetch(first.base + '/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'createProject', args: [{ name: 'At the boundary' }] }) }).then(r => r.json());
  const path = '/api/events?epoch=' + initial.cursor.epoch + '&after=' + initial.cursor.sequence;
  const stream = await fetch(first.base + path, { signal: AbortSignal.timeout(4_000) });
  assert.ok(stream.body);
  let data = '';
  for await (const chunk of stream.body.pipeThrough(new TextDecoderStream())) {
    data += chunk;
    if (data.includes('\n\n')) break;
  }
  const line = data.split('\n').find(l => l.startsWith('data: '));
  assert.ok(line);
  const frame = JSON.parse(line.slice(6));
  assert.equal(frame.snapshot.projectId, created.result.project.id);
  assert.equal(frame.snapshot.execution.enabled,false,'A wildcard never enables a project.');
  assert.equal(frame.sequence, initial.cursor.sequence + 1);
  await first.stop();
  const second = await start('other, '+created.result.project.id);
  const reset = await fetch(second.base + path).then(r => r.text());
  assert.equal(JSON.parse(reset.slice(6)).type, 'reset');
  const restored = await fetch(second.base + '/api/bootstrap').then(r => r.json());
  assert.equal(restored.snapshot.projectId, created.result.project.id);
  assert.deepEqual(restored.execution,restored.snapshot.execution);
  assert.equal(restored.execution.enabled,true);
  assert.equal(restored.execution.runtime.available,true,'Prepared WASI runtime must be available without a host image.');
  assert.equal(restored.execution.backend,'wasi');
  assert.equal(restored.execution.network,false);
  assert.equal(restored.execution.shell,false);
  assert.equal(restored.execution.limits.workspaceFiles,32);
  assert.notEqual(restored.cursor.epoch, initial.cursor.epoch);
});
