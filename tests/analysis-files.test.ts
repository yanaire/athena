import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, link, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ANALYSIS_FILE_LIMITS as limits, AnalysisFileError, AnalysisFiles } from '../runtime/analysis-files.ts';
import { assertPrivatePermissions, directoryLink, makePublicPermissions } from './platform-test-helpers.ts';

const scope = { projectId: 'project', sessionId: 'session', taskId: 'task' };
const attempt = { ...scope, attemptId: 'attempt' };
const file = (name: string, content: string) => ({ name, bytes: Buffer.from(content) });

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'analysis-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, files: new AnalysisFiles(root) };
}

async function taskPath(root: string) {
  const [key] = await readdir(join(root, 'analysis-files'));
  assert.ok(key);
  return join(root, 'analysis-files', key);
}

test('task files persist; other tasks, sessions and projects cannot see them', async t => {
  const { files, root } = await fixture(t);
  await files.write(scope, 'calc.py', 'print(1)');
  assert.equal(await new AnalysisFiles(root).read(scope, 'calc.py'), 'print(1)');
  const dir = await taskPath(root);
  await assertPrivatePermissions(dir, 0o700);
  for (const key of ['projectId', 'sessionId', 'taskId']) {
    const other = { ...scope, [key]: 'other' };
    assert.equal(await files.has(other, 'calc.py'), false);
    await assert.rejects(files.read(other, 'calc.py'), AnalysisFileError);
  }
});

test('grants and runtime snapshots are detached; grant names remain read-only on reopen', async t => {
  const { root, files } = await fixture(t);
  const staged = file('Input.csv', '\uFEFFx,y\r\n1,2\r\n');
  await files.grant(scope, staged);
  await files.grant(scope, staged);
  staged.bytes.fill(65);
  const reopened = new AnalysisFiles(root);
  assert.equal(await reopened.has(scope, 'input.csv'), true);
  const [input] = await reopened.snapshot(scope, ['Input.csv']);
  assert.ok(input);
  input.bytes.fill(0);
  assert.equal(await reopened.read(scope, 'Input.csv'), '\uFEFFx,y\r\n1,2\r\n');
  await assert.rejects(reopened.grant(scope, staged), AnalysisFileError);
  await assert.rejects(reopened.write(scope, 'INPUT.csv', 'new'), AnalysisFileError);
  await assert.rejects(reopened.publish(attempt, ['input.csv'], [file('input.csv', 'new')]), AnalysisFileError);
});

test('plain names, explicit output lists and transfer limits apply before publication', async t => {
  const { files } = await fixture(t);
  for (const name of ['/a.md', '../a.md', 'a/../b.md', 'a\\b.md', '.report.md', 'r\n.md', 'a.zip', 'a.md\0']) {
    await assert.rejects(files.write(scope, name, 'x'), AnalysisFileError);
    await assert.rejects(files.has(scope, name), AnalysisFileError);
    await assert.rejects(files.publish(attempt, [name], [file(name, 'x')]), AnalysisFileError);
  }
  const output = file('a.md', '# actual');
  await assert.rejects(files.publish(attempt, [], [output]), AnalysisFileError);
  await assert.rejects(files.publish(attempt, ['a.md'], []), AnalysisFileError);
  await assert.rejects(files.publish(attempt, ['b.md'], [output]), AnalysisFileError);
  await assert.rejects(files.publish(attempt, ['a.md', 'A.md'], [output, output]), AnalysisFileError);
  await assert.rejects(files.snapshot(scope, Array.from({ length: limits.batchFiles + 1 }, (_, i) => `${i}.md`)), AnalysisFileError);
  for (const bytes of [Buffer.from([255]), Buffer.from([65, 0]), Buffer.alloc(limits.fileBytes + 1, 65)]) {
    await assert.rejects(files.publish(attempt, ['a.md'], [{ name: 'a.md', bytes }]), AnalysisFileError);
    await assert.rejects(files.grant(scope, { name: 'a.md', bytes }), AnalysisFileError);
  }
  await assert.rejects(files.write(scope, 'a.txt', 'é'.repeat(limits.fileBytes / 2 + 1)), AnalysisFileError);
  await files.write(scope, 'a.txt', 'é'.repeat(limits.fileBytes / 2));
  for (let i = 1; i < limits.workspaceFiles; i++) await files.write(scope, `${i}.md`, '');
  await assert.rejects(files.write(scope, 'full.md', ''), AnalysisFileError);
  await files.write(scope, 'a.txt', 'replacement');
  assert.equal(await files.read(scope, 'a.txt'), 'replacement');
});

test('workspace probes, reads and replacements reject links, directories, oversize and altered permissions', async t => {
  const { root, files } = await fixture(t);
  await files.write(scope, 'seed.txt', 'content');
  const dir = join(await taskPath(root), 'files');
  const outside = join(root, 'outside');
  await writeFile(outside, 'private', { mode: 0o600 });
  await link(outside, join(dir, 'hard.txt'));
  await symlink(outside, join(dir, 'soft.txt'));
  await symlink(join(root, 'absent'), join(dir, 'broken.txt'));
  await mkdir(join(dir, 'dir.txt'));
  await writeFile(join(dir, 'oversize.txt'), Buffer.alloc(limits.fileBytes + 1), { mode: 0o600 });
  await makePublicPermissions(join(dir, 'seed.txt'));
  for (const name of ['hard.txt', 'soft.txt', 'broken.txt', 'dir.txt', 'oversize.txt', 'seed.txt']) {
    await assert.rejects(files.has(scope, name), AnalysisFileError);
    await assert.rejects(files.read(scope, name), AnalysisFileError);
    await assert.rejects(files.write(scope, name, 'replacement'), AnalysisFileError);
  }
  await rm(dir, { recursive: true });
  await directoryLink(root, dir);
  await assert.rejects(files.has(scope, 'missing.txt'), AnalysisFileError);
});

test('same-name artifact versions survive process restart and reject forged references and changed bytes', async t => {
  const { root, files } = await fixture(t);
  const source = file('summary.json', '{"n":1}');
  const [first] = await files.publish(attempt, ['summary.json'], [source]);
  source.bytes.fill(65);
  const [second] = await files.publish({ ...attempt, attemptId: 'again' }, ['summary.json'], [file('summary.json', '{"n":2}')]);
  assert.ok(first && second);
  assert.notEqual(first.versionId, second.versionId);
  const moduleURL = new URL('../runtime/analysis-files.ts', import.meta.url).href;
  const program = `import {AnalysisFiles} from ${JSON.stringify(moduleURL)}; const files = new AnalysisFiles(process.argv[1]);
    for (const ref of JSON.parse(process.argv[2])) console.log((await files.download(ref)).toString('utf8'));`;
  assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', program, root, JSON.stringify([first, second])],
    { encoding: 'utf8' }), '{"n":1}\n{"n":2}\n');
  const versions = join(await taskPath(root), 'versions');
  for (const changed of [{ sessionId: 'else' }, { projectId: 'else' }, { taskId: 'else' }, { attemptId: 'else' },
    { id: second.id }, { versionId: second.versionId }, { bytes: 1 }, { name: 'renamed.json' }, { sha256: second.sha256 }]) {
    await assert.rejects(files.download({ ...first, ...changed }), AnalysisFileError);
  }
  for (const entry of await readdir(versions)) {
    const path = join(versions, entry);
    await assertPrivatePermissions(path, 0o400);
    await chmod(path, 0o600);
    await writeFile(path, '{"n":0}');
    await chmod(path, 0o400);
  }
  await assert.rejects(files.download(first), /failed verification/);
  await assert.rejects(files.download(second), /failed verification/);
});

test('publication installs only declared outputs and archives the source snapshot that ran', async t => {
  const { root, files } = await fixture(t);
  const script = file('calc.py', 'print(1)');
  await files.write(scope, script.name, 'print(2)'); // Revision made while snapshot 1 was running.
  const outputs = Array.from({ length: limits.batchFiles }, (_, i) => file(`${i}.md`, `value ${i}`));
  const names = outputs.map(f => f.name);
  const artifacts = await files.publish(attempt, names, outputs.toReversed(), script);
  assert.deepEqual(artifacts.map(a => a.name), [script.name, ...names]);
  const [source, result] = artifacts;
  assert.ok(source && result);
  assert.deepEqual(await files.download(source), script.bytes);
  const reopened = new AnalysisFiles(root);
  assert.equal(await reopened.read(scope, 'calc.py'), 'print(2)');
  assert.deepEqual(await reopened.snapshot(scope, names), outputs);
  assert.equal(await reopened.has({ ...scope, taskId: 'other' }, names[0] ?? ''), false);
  await files.write(scope, result.name, 'edited');
  assert.equal(await files.read(scope, result.name), 'edited');
  assert.equal((await files.download(result)).toString(), 'value 0');
});

test('failed publication leaves every output in the previous task revision', async t => {
  const { files } = await fixture(t);
  await files.publish(attempt, ['report.md'], [file('report.md', 'original')]);
  const next = file('report.md', 'replacement');
  await assert.rejects(files.publish(attempt, ['report.md', 'new.md'], [next, { name: 'new.md', bytes: Buffer.from([255]) }]), AnalysisFileError);
  assert.equal(await files.read(scope, 'report.md'), 'original');
  assert.equal(await files.has(scope, 'new.md'), false);
  for (let i = 1; i < limits.workspaceFiles; i++) await files.write(scope, `${i}.txt`, '');
  await assert.rejects(files.publish(attempt, ['report.md', 'new.md'], [next, file('new.md', 'new')]), AnalysisFileError);
  assert.equal(await files.read(scope, 'report.md'), 'original');
  assert.equal(await files.has(scope, 'new.md'), false);
});
