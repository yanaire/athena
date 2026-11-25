import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Connections, baseURL } from '../runtime/connections.ts';

test('verification does I/O without saving; rejected input never redirects the credential; saved settings survive reopening', async t => {
  const path = await mkdtemp(join(tmpdir(), 'athena-connection-test-'));
  const connections = new Set<Connections>();
  let visits = 0;
  const endpoint = createServer((req, res) => {
    visits++;
    assert.equal(req.url, '/v1/models');
    if (req.headers.authorization !== 'Bearer fixture') { res.writeHead(401).end(); return; }
    res.end(JSON.stringify({ data: [{ id: 'model-a' }] }));
  });
  t.after(async () => {
    // Close every owned handle before removing files, including after an
    // assertion fails. A failed cleanup must not prevent the other disposals.
    const closed = await Promise.allSettled([
      ...[...connections].map(connection => Promise.resolve().then(() => connection.close())),
      new Promise<void>((resolve, reject) => {
        endpoint.close(error => {
          if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
          else resolve();
        });
        endpoint.closeAllConnections();
      }),
    ]);
    const removed = await Promise.allSettled([rm(path, { recursive: true, force: true })]);
    const failures = [...closed, ...removed].flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, 'Connection fixture cleanup failed.');
  });
  await new Promise<void>(ok => endpoint.listen(0, '127.0.0.1', ok));
  const address = endpoint.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/v1`;
  const model = { provider: 'athena', modelId: 'model-a' };
  const first = new Connections(path, url, model, 'fixture');
  connections.add(first);
  assert.equal((await first.verifyConnection({ ...first.defaults, endpoint: 'https://other.example' })).status, 'failed');
  assert.equal(visits, 0);
  assert.equal((await first.verifyConnection(first.defaults)).status, 'connected');
  assert.equal(visits, 1);
  assert.equal(first.getState().configurationId, undefined);
  const saved = first.saveConfig(first.defaults);
  assert.throws(() => first.saveConfig({ ...first.defaults, defaultModel: 'unavailable' }));
  first.close();
  connections.delete(first);
  const reopened = new Connections(path, url, model, 'wrong-fixture');
  connections.add(reopened);
  assert.equal(reopened.getState().configurationId, saved.configurationId);
  assert.equal(reopened.getState().verification.status, 'not_checked');
  assert.equal((await reopened.verifyConnection(reopened.defaults)).message, 'Authentication failed (HTTP 401).');
  assert.doesNotMatch(JSON.stringify(reopened.getState()), /wrong-fixture/);
});

test('a non-local HTTP endpoint and embedded credentials cannot be pinned', () => {
  assert.throws(() => baseURL('http://example.org/v1'));
  assert.throws(() => baseURL('https://secret@example.org/'));
});
