// Reconcile an offline inspection with files actually saved by the browser.
// Downloads must be arranged as DOWNLOAD_DIR/<artifact-id>/<original-name>.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';

const [receipt, downloadDir] = process.argv.slice(2);
assert.ok(receipt && downloadDir, 'Usage: node scripts/m21-browser-verify.mjs INSPECTION.json DOWNLOAD_DIR');
const r = JSON.parse(readFileSync(receipt, 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const { tasks, sessions } = r;
const parent = tasks.find(t => t.id === r.run.taskId);
const children = tasks.filter(t => t.parentTaskId === parent.id);
assert.equal(r.run.status, 'succeeded');
assert.equal(children.length, 2);
assert.equal(new Set(tasks.map(t => t.agentSessionId)).size, 3);
assert.ok(tasks.every(t => t.status === 'succeeded'));
const calls = task => sessions.find(s => s.id === task.agentSessionId).calls;
const parentCalls = calls(parent);
const spawns = parentCalls.filter(c => c.name === 'spawn_agent' && c.status === 'succeeded');
const childIds = new Set(children.map(t => t.id));
for (const row of children) assert.ok(spawns.some(c => JSON.stringify(c.result).includes(row.id)), `No model spawn result for ${row.id}`);
assert.ok(parentCalls.filter(c => c.name === 'wait_for_agents' && c.status === 'succeeded').some(c =>
  [...childIds].every(id => JSON.stringify(c.result).includes(id))), 'Join result did not include both children');
assert.equal(r.inputs.length, 1);
const [input] = r.inputs;
const oracle = {
  'settling.csv': { key: 'population_sd', missing: 'T2', value: Math.sqrt(45), median: 15 },
  'optics.csv': { key: 'count_ge_90', missing: 'P3', value: 2, median: 88 },
}[input.name];
assert.ok(oracle, 'Unknown acceptance fixture');
const fixture = readFileSync(new URL('../docs/m21/' + input.name, import.meta.url));
assert.equal(sha(fixture), input.sha256, 'Staged bytes differ from fixture');
const numericRows = text => text.trimEnd().split(/\r?\n/).map(line => line.split(',').map(cell => cell.trim().replace(/^"(.*)"$/, '$1')));
const [headers, ...rows] = numericRows(input.text);
const expected = rows.filter(row => row[1] !== '').map(([id, x]) => [id, Number(x)]).sort((a,b) => a[1]-b[1]);
const artifacts = r.artifacts.map(a => {
  const name = a.file.name;
  assert.match(a.id, /^[a-f0-9-]+$/i);
  assert.equal(basename(name), name);
  const bytes = readFileSync(join(downloadDir, a.id, name));
  assert.equal(sha(bytes), a.file.sha256, `Browser download differs: ${name}`);
  return { ...a, bytes };
});
const processRow = r.processes.find(p => {
  const names = artifacts.filter(a => a.processId === p.id).map(a => a.file.name);
  return p.job.exitCode === 0 && names.includes('result.json') && names.includes('clean.csv');
});
assert.ok(processRow, 'No successful process producing both outputs');
assert.ok(processRow.job.analysis?.inputs.some(f => f.name === input.name && f.fileId === input.id && f.sha256 === input.sha256 && f.versionId === input.sha256),
  'The successful command did not mount the actual staged CSV version');
const worker = children.find(t => t.id === processRow.taskId);
assert.ok(worker, 'Output process is not owned by a child');
const auditor = children.find(t => t.id !== worker.id);
assert.ok(calls(auditor).some(c => ['read','read_file'].includes(c.name) && c.status === 'succeeded' &&
  c.result?.content?.some(p => p.type === 'text' && p.text.includes(input.text.trimEnd()))),
  'No successful read of the staged CSV by the independent auditor');
assert.ok(auditor.result.includes(oracle.missing), 'The auditor did not identify the missing row');
const workerCalls = calls(worker);
const command = workerCalls.find(c => c.toolId === processRow.toolId && c.name === 'run_command' && c.status === 'succeeded');
assert.ok(command, 'No successful model command matching process tool ID');
const declaredInput = Array.isArray(command.arguments?.inputs) && command.arguments.inputs.some(entry =>
  (typeof entry === 'string' && entry === input.name) || (entry && typeof entry === 'object' && entry.name === input.name));
assert.ok(declaredInput, 'The successful command did not declare the uploaded input');
const outputs = artifacts.filter(a => a.processId === processRow.id && a.toolId === command.toolId && a.attemptId === command.attemptId);
const output = name => {
  const selected = outputs.find(a => a.file.name === name);
  assert.ok(selected, `Missing process output ${name}`);
  return selected;
};
const source = output(command.arguments.script);
assert.ok(source.bytes.toString('utf8').includes('/workspace/' + input.name), 'The model script does not open the staged input path');
const writes = workerCalls.slice(0, workerCalls.indexOf(command)).filter(c => c.name === 'write_file' && c.status === 'succeeded' && c.arguments.name === source.file.name);
assert.ok(writes.length, 'No model source write before command');
assert.deepEqual(source.bytes, Buffer.from(writes.at(-1).arguments.content), 'Source differs from the last successful model write');
const cleaned = output('clean.csv');
const [actualHeader, ...actualRows] = numericRows(cleaned.text);
assert.deepEqual(actualHeader, headers);
assert.ok(actualRows.every(row => row.length === 2 && row[1] !== ''));
assert.deepEqual(actualRows.map(([id, x]) => [id, Number(x)]), expected);
const result = output('result.json');
const numbers = JSON.parse(result.text);
assert.ok(parentCalls.some(c => c.name === 'read_file' && c.status === 'succeeded' && c.arguments.artifactId === result.id),
  'The parent did not read the canonical result artifact');
assert.equal(numbers.median, oracle.median);
assert.ok(typeof numbers[oracle.key] === 'number' && Math.abs(numbers[oracle.key]-oracle.value) < 1e-5, 'Numerical result differs from oracle');
const answer = parent.result;
assert.ok(answer.includes(oracle.missing), 'Final answer omits the audit finding');
for (const a of [cleaned, result]) assert.ok(answer.includes(a.location.uri), `Final answer omits ${a.file.name} URI`);
// Inspect the prose manually as well: numbers occurring in artifact IDs are not answers.
const prose = answer.replace(/\/api\/artifacts\/[\w/-]+/g, '');
const stated = [...prose.matchAll(/(?<![\w.])\d+(?:\.\d+)?(?![\w.])/g)].map(m => Number(m[0]));
for (const x of [oracle.value, oracle.median]) assert.ok(stated.some(n => Math.abs(n-x)<0.005), 'Final answer omits the expected computed value');
console.log(JSON.stringify({ runId: r.run.id, children: [...childIds], command: processRow.job, sourceSha256: source.file.sha256,
  outputs: outputs.map(a => ({ name: a.file.name, id: a.id, sha256: a.file.sha256, bytes: a.file.bytes })), numbers, answer }, null, 2));
