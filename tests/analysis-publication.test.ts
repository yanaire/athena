import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { AnalysisFiles } from '../runtime/analysis-files.ts';

const scope = { projectId: 'synthetic', sessionId: 'session', taskId: 'task', attemptId: 'attempt' };
const snapshot = (name: string, content: string) => ({ name, bytes: Buffer.from(content) });

for (const failure of ['blob_write', 'index_commit'] as const) {
  test(`publication rolls back new blobs and preserves prior outputs after ${failure}`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'athena-publication-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const files = new AnalysisFiles(root);
    const [prior] = await files.publish(scope, ['report.txt'], [snapshot('report.txt', 'original')]);
    assert.ok(prior);
    const [key] = await readdir(join(root, 'analysis-files'));
    assert.ok(key);
    const versions = await realpath(join(root, 'analysis-files', key, 'versions'));
    const originalBlobs = await readdir(versions);
    const write = fs.writeFileSync;
    const rename = fs.renameSync;
    const fault = new Error('Synthetic storage failure');
    let writes = 0;
    t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
      if (failure === 'blob_write' && dirname(String(args[0])) === versions && ++writes === 2) {
        write(...args); // A failed write can leave a partially created file.
        throw fault;
      }
      return write(...args);
    });
    t.mock.method(fs, 'renameSync', (...args: Parameters<typeof fs.renameSync>) => {
      if (failure === 'index_commit' && basename(String(args[1])) === '.published') throw fault;
      return rename(...args);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(files.publish({ ...scope, attemptId: 'next' },
        ['report.txt', 'new.txt'], [snapshot('report.txt', 'replacement'), snapshot('new.txt', 'new')],
        snapshot('main.py', 'print(1)')), error => error === fault);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
    assert.deepEqual(await readdir(versions), originalBlobs);
    assert.equal(await files.read(scope, 'report.txt'), 'original');
    assert.equal(await files.has(scope, 'new.txt'), false);
    assert.equal((await files.download(prior)).toString(), 'original');
  });
}
