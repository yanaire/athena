// Read-only acceptance check for a finished UI run using docs/measurements.csv.
// The inspector cannot prompt the model or create a task, tool, process or artifact.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const base = new URL(process.argv[2] || 'http://127.0.0.1:4317');
assert.equal(base.hostname, '127.0.0.1', 'Choose the local Athena host.');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = value => sha(JSON.stringify(value));
async function inspect(sessionId, agentId) {
  const r = await fetch(new URL('/api/rpc', base), { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'getAgentHistory', args: [sessionId, agentId] }) });
  const data = await r.json();
  assert.ok(r.ok, data.error);
  return data.result.messages;
}
const r = await fetch(new URL('/api/bootstrap', base));
assert.ok(r.ok);
const { snapshot: s } = await r.json();
assert.equal(s.run.status, 'succeeded');
const root = s.tasks.find(t => !t.parentTaskId && t.runId === s.run.id);
assert.ok(root, 'No root task for selected run.');
const children = s.tasks.filter(t => t.parentTaskId === root.id);
assert.equal(children.length, 2);
const tasks = [root, ...children];
for (const field of ['id', 'agentSessionId', 'attemptId']) {
  assert.ok(tasks.every(t => t[field]));
  assert.equal(new Set(tasks.map(t => t[field])).size, 3);
}
const histories = await Promise.all(tasks.map(t => inspect(s.sessionId, t.agentSessionId)));
const calls = messages => messages.filter(m => m.role === 'assistant').flatMap(m => Array.isArray(m.content) ? m.content.filter(p => p.type === 'toolCall') : []);
const mainCalls = calls(histories[0]);
for (const [i, history] of histories.entries()) {
  for (const c of calls(history)) {
    const tool = s.tools.find(t => t.id === c.id && t.rawToolCallId === c.rawToolCallId && t.attemptId === tasks[i].attemptId);
    assert.equal(tool?.agentSessionId, tasks[i].agentSessionId, 'Persisted tool must belong to its SDK session.');
    assert.ok(history.some(m => m.role === 'toolResult' && m.toolCallId === c.id && m.rawToolCallId === c.rawToolCallId));
  }
}
assert.ok(mainCalls.filter(c => c.name === 'spawn_agent').length >= 2, 'Parent model did not request two children.');
assert.ok(mainCalls.some(c => c.name === 'wait_for_agents'), 'Parent model did not request join.');
const workers = histories.slice(1).map(calls);
const calcIndex = workers.findIndex((items, i) => items.some(c => c.name === 'calculate_csv') &&
  workers.some((other, j) => i !== j && other.some(c => c.name === 'read')));
assert.ok(calcIndex >= 0, 'Distinct workers must read and calculate.');
const job = s.processes.find(p => p.taskId === children[calcIndex].id && (p.exitCode ?? p.job?.exitCode) === 0);
assert.ok(job, 'No successful OS process for the calculation child.');
const artifact = s.artifacts.find(a => a.processId === job.id && a.toolId === job.toolId && a.taskId === job.taskId && a.attemptId === children[calcIndex].attemptId);
assert.ok(artifact?.location?.uri, 'No result file for the calculation attempt.');
const location = new URL(artifact.location.uri, base);
assert.equal(location.origin, base.origin);
const download = await fetch(location);
assert.ok(download.ok, 'Could not download result.');
const bytes = Buffer.from(await download.arrayBuffer());
assert.equal(sha(bytes), artifact.file.sha256);
const result = JSON.parse(bytes.toString('utf8'));
assert.equal(result.rowCount, 5);
assert.deepEqual(result.statistics.find(x => x.column === 'measurement_mV'),
  { column: 'measurement_mV', count: 4, missing: 1, nonNumeric: 0, min: 7, max: 35, mean: 19 });
const finalMessage = histories[0].filter(m => m.role === 'assistant').at(-1);
const answer = finalMessage.content.filter(part => part.type === 'text').map(part => part.text).join('');
assert.match(answer, /\b19(?:\.0+)?\b/, 'Final answer does not include the known mean.');
assert.match(answer, /statistics\.json/);
assert.ok(s.artifacts.some(a => answer.includes(a.location.uri)), 'Final answer must cite a generated artifact.');
console.log(JSON.stringify({ projectId: s.projectId, sessionId: s.sessionId, runId: s.run.id,
  tasks: tasks.map((t, i) => ({ taskId: t.id, parentTaskId: t.parentTaskId ?? null, agentSessionId: t.agentSessionId,
    attemptId: t.attemptId, status: t.status, historySha256: digest(histories[i]), messages: histories[i].length,
    calls: calls(histories[i]).map(c => ({ name: c.name, id: c.id })) })),
  tools: s.tools.map(t => ({ toolId: t.id, rawToolId: t.rawToolCallId, taskId: t.taskId, attemptId: t.attemptId, status: t.status })),
  executionSha256: digest({tasks:s.tasks, attempts:s.attempts, tools:s.tools, processes:s.processes, artifacts:s.artifacts}),
  process: { id: job.processId || job.id, taskId: job.taskId, attemptId: job.attemptId, toolId: job.toolId,
    pid: job.pid ?? job.job?.pid, exitCode: job.exitCode ?? job.job?.exitCode }, artifact: { id: artifact.id, sha256: sha(bytes), bytes: bytes.length, result }, answer }, null, 2));
