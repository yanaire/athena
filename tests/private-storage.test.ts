import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import test from 'node:test';
import { createPrivateDirectory } from '../runtime/private-storage.ts';
import { assertPrivatePermissions, assertPublicPermissions, makePublicPermissions, windows } from './platform-test-helpers.ts';

test('new nested storage is private and an unsafe existing directory is never repaired', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'athena-private-storage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = [join(root, 'ordinary')];
  if (windows) paths.push(win32.toNamespacedPath(join(root, 'extended')));
  for (const parent of paths) {
    const child = join(parent, 'nested');
    createPrivateDirectory(child);
    await assertPrivatePermissions(parent, 0o700);
    await assertPrivatePermissions(child, 0o700);
    createPrivateDirectory(child);
    await makePublicPermissions(child, 0o755);
    assert.throws(() => createPrivateDirectory(child), /Expected private storage/);
    await assertPublicPermissions(child, 0o755);
  }
});
