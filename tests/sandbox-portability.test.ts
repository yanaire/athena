import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AnalysisFiles } from '../runtime/analysis-files.ts';
import { JobRunner } from '../runtime/jobs.ts';

test('WASI writes to invalid or closed descriptors return EBADF and leave the guest running',
  { timeout: process.platform === 'win32' ? 180_000 : 60_000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'athena-wasi-errors-'));
    const runner = new JobRunner({ dataDir: directory });
    t.after(async () => { await runner.close(); await rm(directory, { recursive: true, force: true }); });
    const scope = { projectId: 'platform', sessionId: 'sandbox', taskId: 'recoverable-errors' };
    const source = `import errno, os, json
checks = []
def bad_descriptor(action, label):
    try: action()
    except OSError as error:
        assert error.errno == errno.EBADF, (label, error.errno)
        checks.append(label)
    else: raise AssertionError('invalid descriptor was accepted: ' + label)
bad_descriptor(lambda: os.write(999, b'x'), 'invalid-write')
bad_descriptor(lambda: os.pwrite(999, b'x', 0), 'invalid-pwrite')
fd = os.open('/outputs/checks.json', os.O_CREAT | os.O_RDWR | os.O_TRUNC)
os.close(fd)
bad_descriptor(lambda: os.write(fd, b'x'), 'closed-write')
bad_descriptor(lambda: os.pwrite(fd, b'x', 0), 'closed-pwrite')
with open('/outputs/checks.json', 'w') as result: json.dump(checks, result)
`;
    const result = await runner.startAnalysis({ ...scope, attemptId: 'wasi-errors', requestId: 'one', toolId: 'analysis',
      language: 'python', script: { name: 'errors.py', bytes: Buffer.from(source) }, inputs: [],
      outputs: ['checks.json'] }).result;
    assert.equal(result.status, 'succeeded', `${result.error ?? ''}\n${result.stderr}`);
    const files = new AnalysisFiles(directory);
    assert.deepEqual(JSON.parse(await files.read(scope, 'checks.json')),
      ['invalid-write', 'invalid-pwrite', 'closed-write', 'closed-pwrite']);
  });

test('WASI file limits cover append, positional writes, truncate, descriptor exhaustion and reopened stdin',
  { timeout: process.platform === 'win32' ? 180_000 : 60_000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'athena-wasi-portability-'));
    const runner = new JobRunner({ dataDir: directory });
    t.after(async () => { await runner.close(); await rm(directory, { recursive: true, force: true }); });
    const scope = { projectId: 'platform', sessionId: 'sandbox', taskId: 'boundaries' };
    const source = `import os, json
limit = 1024 * 1024
checks = []
def denied(action, label):
    try: action()
    except OSError: checks.append(label)
    else: raise AssertionError('limit was bypassed: ' + label)
path = '/outputs/data.txt'
fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_TRUNC)
assert os.write(fd, b'a' * limit) == limit
denied(lambda: os.write(fd, b'x'), 'write')
os.lseek(fd, 0, os.SEEK_SET)
assert os.write(fd, b'Z') == 1
denied(lambda: os.pwrite(fd, b'x', limit), 'pwrite')
assert os.pwrite(fd, b'Y', 1) == 1
denied(lambda: os.ftruncate(fd, limit + 1), 'truncate')
os.close(fd)
fd = os.open(path, os.O_WRONLY | os.O_APPEND)
denied(lambda: os.write(fd, b'x'), 'append')
denied(lambda: os.pwrite(fd, b'x', 0), 'append-pwrite')
os.close(fd)
assert os.stat(path).st_size == limit
# Preview 1 may recycle a closed stdio number for a file. It must receive file
# limits, not the unlimited-stream path merely because its number is small.
os.close(0)
handles = []
for _ in range(96):
    fd = os.open('/outputs/reused.txt', os.O_WRONLY | os.O_CREAT)
    handles.append(fd)
    if fd == 0: break
assert fd == 0, 'the test must actually recycle stdin'
denied(lambda: os.write(fd, b'x' * (limit + 1)), 'reused-stdin')
assert os.stat('/outputs/reused.txt').st_size == 0, 'oversized write reached the filesystem'
for handle in handles: os.close(handle)
handles = []
try:
    for _ in range(100): handles.append(os.open('/workspace/input.txt', os.O_RDONLY))
except OSError: checks.append('descriptors')
else: raise AssertionError('descriptor limit was bypassed')
assert 16 <= len(handles) < 96
for handle in handles: os.close(handle)
with open('/outputs/checks.json', 'w') as result: json.dump(checks, result)
`;
    const result = await runner.startAnalysis({ ...scope, attemptId: 'native-limits', requestId: 'one', toolId: 'analysis',
      language: 'python', script: { name: 'limits.py', bytes: Buffer.from(source) },
      inputs: [{ name: 'input.txt', bytes: Buffer.from('bounded input') }],
      outputs: ['data.txt', 'reused.txt', 'checks.json'] }).result;
    assert.equal(result.status, 'succeeded', `${result.error ?? ''}\n${result.stderr}`);
    const files = new AnalysisFiles(directory);
    assert.deepEqual(JSON.parse(await files.read(scope, 'checks.json')),
      ['write', 'pwrite', 'truncate', 'append', 'append-pwrite', 'reused-stdin', 'descriptors']);
    const bounded = await files.read(scope, 'data.txt');
    assert.equal(bounded.length, 1024 * 1024);
    assert.equal(bounded.slice(0, 2), 'ZY');
    assert.equal(await files.read(scope, 'reused.txt'), '');
  });
