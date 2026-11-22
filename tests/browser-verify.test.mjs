import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const verifier = fileURLToPath(new URL('../scripts/m21-browser-verify.mjs', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

test('offline CSV acceptance reconciles actual downloads and rejects non-WASI receipts in WASI mode', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'athena-browser-verify-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = await readFile(new URL('../docs/m21/settling.csv', import.meta.url), 'utf8');
  const source = 'with open("/workspace/settling.csv") as handle: print(handle.read())\n';
  const clean = 'trial,settling_ms\nT3,6\nT4,12\nT1,18\nT5,24\n';
  const result = '{"median_ms":15,"population_sd_ms":6.708203932499369}';
  const receiptPath = join(directory, 'receipt.json');
  const calls = (id, calls) => ({ id, calls: calls.map(call => ({ status: 'succeeded', ...call })) });
  const artifact = (id, name, bytes) => ({ id, processId: 'process', toolId: 'command', attemptId: 'worker-attempt',
    file: { name, bytes: Buffer.byteLength(bytes), sha256: sha256(bytes) }, location: { uri: `/api/artifacts/session/${id}` } });
  const artifacts = [artifact('a1', 'analysis.py', source), artifact('a2', 'clean.csv', clean), artifact('a3', 'result.json', result)];
  for (const [index, artifact] of artifacts.entries()) {
    await mkdir(join(directory, artifact.id));
    await writeFile(join(directory, artifact.id, artifact.file.name), [source, clean, result][index]);
  }
  const receipt = { run: { id: 'run', taskId: 'parent', status: 'succeeded' },
    inputs: [{ id: 'input', name: 'settling.csv', sha256: sha256(input), text: input }],
    tasks: [
      { id: 'parent', agentSessionId: 'root-agent', status: 'succeeded', result: 'T2; 15 ms; 6.708203932499369 ms. /api/artifacts/session/a2 /api/artifacts/session/a3' },
      { id: 'auditor', parentTaskId: 'parent', agentSessionId: 'audit-agent', status: 'succeeded', result: 'T2 is blank.' },
      { id: 'worker', parentTaskId: 'parent', agentSessionId: 'code-agent', status: 'succeeded' },
    ],
    sessions: [
      calls('root-agent', [{ name: 'spawn_agent', result: { taskId: 'auditor' } }, { name: 'spawn_agent', result: { taskId: 'worker' } },
        { name: 'wait_for_agents', result: { tasks: ['auditor', 'worker'] } }, { name: 'read_file', arguments: { artifactId: 'a3' },
          result: { content: [{ type: 'text', text: JSON.stringify({ artifact: { id: 'a3' }, content: result }) }] } }]),
      calls('audit-agent', [{ name: 'read', result: { content: [{ type: 'text', text: input }] } }]),
      calls('code-agent', [{ name: 'write_file', arguments: { name: 'analysis.py', content: source } },
        { name: 'run_command', toolId: 'command', attemptId: 'worker-attempt', arguments: { script: 'analysis.py', inputs: ['settling.csv'] } }]),
    ],
    processes: [{ id: 'process', taskId: 'worker', toolId: 'command', status: 'succeeded', job: { program: 'python.wasm', exitCode: 0, analysis: {
      language: 'python', backend: 'wasi', inputs: [{ name: 'settling.csv', fileId: 'input', sha256: sha256(input), versionId: sha256(input) }],
    } } }], artifacts };
  const run = async (evidence, ...mode) => {
    await writeFile(receiptPath, JSON.stringify(evidence));
    return spawnSync(process.execPath, [verifier, receiptPath, directory, ...mode], { encoding: 'utf8', timeout: 5000 });
  };

  const verified = await run(receipt, '--wasi');
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(JSON.parse(verified.stdout).execution, 'wasi-python');

  const legacy = structuredClone(receipt);
  legacy.processes[0].job.program = '/usr/bin/python3';
  delete legacy.processes[0].job.analysis.backend;
  const wrongBackend = await run(legacy, '--wasi');
  assert.equal(wrongBackend.status, 1);
  assert.match(wrongBackend.stderr, /No successful WASI Python process/);

  const mismatchedRead = structuredClone(receipt);
  mismatchedRead.sessions[0].calls[3].result.content[0].text = JSON.stringify({ artifact: { id: 'a3' }, content: '{}' });
  const wrongRead = await run(mismatchedRead, '--wasi');
  assert.equal(wrongRead.status, 1);
  assert.match(wrongRead.stderr, /The parent read differs from the downloaded JSON/);

  const legacyResult = '{"median":15,"population_sd":6.708203932499369}';
  legacy.artifacts[2] = artifact('a3', 'result.json', legacyResult);
  await writeFile(join(directory, 'a3', 'result.json'), legacyResult);
  const historical = await run(legacy);
  assert.equal(historical.status, 0, historical.stderr);

  const forged = structuredClone(receipt);
  const invalidCsv = clean.replace('T3,6', 'T3,60');
  forged.artifacts[1] = { ...artifact('a2', 'clean.csv', invalidCsv), text: clean };
  await writeFile(join(directory, 'a2', 'clean.csv'), invalidCsv);
  await writeFile(join(directory, 'a3', 'result.json'), result);
  const wrongDownload = await run(forged, '--wasi');
  assert.equal(wrongDownload.status, 1);
  assert.match(wrongDownload.stderr, /Downloaded CSV rows differ from the fixture oracle/);
});
