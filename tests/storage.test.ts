import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Storage } from '../runtime/storage.ts';

test('SQLite rejects cross-project record scope and rolls back record and revision together', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'athena-storage-'));
  const storage = new Storage(directory);
  t.after(async () => { storage.close(); await rm(directory, { recursive: true, force: true }); });
  storage.putProject({ id: 'project-a', name: 'A' });
  storage.putProject({ id: 'project-b', name: 'B' });
  storage.putSession({ id: 'session-a', projectId: 'project-a', title: 'A', sessionFile: 'a.jsonl', sessionDir: directory });
  const record = { id: 'event-a', projectId: 'project-a', sessionId: 'session-a', runId: 'run-a', summary: 'Persisted' };
  storage.putRecord('event', record);
  assert.throws(() => storage.putRecord('event', { ...record, id: 'wrong-scope', projectId: 'project-b' }), /FOREIGN KEY/);
  assert.throws(() => storage.putRecord('event', { ...record, runId: 'other-run' }), /cannot change scope/);
  assert.throws(() => storage.transaction(() => {
    storage.advanceRevision();
    storage.putRecord('event', { ...record, id: 'rolled-back' });
    throw new RangeError('Rollback the complete write');
  }), RangeError);
  assert.equal(storage.revision(), 0);
  assert.deepEqual(storage.records('event', 'session-a'), [record]);
});
