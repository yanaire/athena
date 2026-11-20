import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Connections, baseURL } from '../runtime/connections.ts';

test('verification does I/O without saving; rejected input never redirects the credential; saved settings survive reopening', async t => {
  const path = await mkdtemp(join(tmpdir(), 'athena-connection-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  let visits = 0;
  const endpoint = createServer((req, res) => {
    visits++;
    assert.equal(req.url, '/v1/models');
    if (req.headers.authorization !== 'Bearer fixture') { res.writeHead(401).end(); return; }
    res.end(JSON.stringify({ data: [{ id: 'model-a' }] }));
  });
  await new Promise<void>(ok => endpoint.listen(0, '127.0.0.1', ok));
  t.after(() => endpoint.close());
  const address = endpoint.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/v1`;
  const model = { provider: 'athena', modelId: 'model-a' };
  const first = new Connections(path, url, model, 'fixture');
  assert.equal((await first.verifyConnection({ ...first.defaults, endpoint: 'https://other.example' })).status, 'failed');
  assert.equal(visits, 0);
  assert.equal((await first.verifyConnection(first.defaults)).status, 'connected');
  assert.equal(visits, 1);
  assert.equal(first.getState().configurationId, undefined);
  const saved = first.saveConfig(first.defaults);
  assert.throws(() => first.saveConfig({ ...first.defaults, defaultModel: 'unavailable' }));
  first.close();
  const reopened = new Connections(path, url, model, 'wrong-fixture');
  t.after(() => reopened.close());
  assert.equal(reopened.getState().configurationId, saved.configurationId);
  assert.equal(reopened.getState().verification.status, 'not_checked');
  assert.equal((await reopened.verifyConnection(reopened.defaults)).message, 'Authentication failed (HTTP 401).');
  assert.doesNotMatch(JSON.stringify(reopened.getState()), /wrong-fixture/);
});

test('a non-local HTTP endpoint and embedded credentials cannot be pinned', () => {
  assert.throws(() => baseURL('http://example.org/v1'));
  assert.throws(() => baseURL('https://secret@example.org/'));
});
