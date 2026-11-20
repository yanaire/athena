// Offline receipt inspection. No host, Pi SDK, model, runtime imports, or write path.
// Scope a single run explicitly: do not silently switch to a later, better run.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';

const [dir, runId] = process.argv.slice(2);
assert.ok(dir && runId, 'Usage: node scripts/inspect-m21.mjs DATA_DIR RUN_ID');
const root = realpathSync(dir);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function dataBytes(path) {
  const canonical = realpathSync(path);
  assert.ok(canonical.startsWith(root + sep), 'Referenced file is outside evidence workspace');
  return readFileSync(canonical);
}
const db = new DatabaseSync(join(root, 'workspace.sqlite'), { readOnly: true });
db.exec('PRAGMA query_only=ON; BEGIN');
const record = (kind, id) => {
  const row = db.prepare('SELECT body FROM records WHERE kind=? AND id=?').get(kind, id);
  assert.ok(row, `Missing ${kind} ${id}`);
  return JSON.parse(row.body);
};
const run = record('run', runId);
const rows = db.prepare('SELECT kind, body FROM records WHERE project_id=? AND session_id=? AND run_id=? ORDER BY sequence')
  .all(run.projectId, run.sessionId, run.id);
const of = kind => rows.filter(row => row.kind === kind).map(row => JSON.parse(row.body));
const attempts = of('attempt'), tools = of('tool');
const sessions = [...new Set(attempts.map(a => a.agentSessionId))].map(id => {
  const session = record('agent_session', id);
  assert.equal(session.projectId, run.projectId);
  assert.equal(session.sessionId, run.sessionId);
  const bytes = dataBytes(session.sessionFile);
  const lines = bytes.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line));
  assert.equal(lines[0].id, id);
  const messages = lines.filter(x => x.type === 'message').map(x => x.message);
  const journal = of('pi_event').filter(x => x.agentSessionId === id && x.event.type === 'message_end');
  const calls = [];
  for (const entry of journal) {
    const msg = entry.event.message;
    // Match the durable SDK message, including its timestamp, not just the tool name.
    // Pi normalizes usage.totalTokens when serializing. The raw JSONL and journal
    // hashes still commit to both accounting representations independently.
    const semantic = ({ usage, ...message }) => message;
    assert.ok(messages.some(m => isDeepStrictEqual(semantic(m), semantic(msg))), 'Journal message absent from Pi JSONL');
    if (msg.role !== 'assistant') continue;
    for (const call of msg.content.filter(p => p.type === 'toolCall')) {
      const tool = tools.find(t => t.rawToolCallId === call.id && t.attemptId === entry.attemptId && t.agentSessionId === id);
      const result = journal.find(x => x.attemptId === entry.attemptId && x.event.message.role === 'toolResult' && x.event.message.toolCallId === call.id);
      calls.push({ ...call, attemptId: entry.attemptId, toolId: tool?.id ?? null, status: tool?.status ?? null,
        result: result?.event.message ?? null });
    }
  }
  return { id, role: session.role, jsonlSha256: sha(bytes), messages: journal.length, calls };
});
const inputs = [...new Set(attempts.flatMap(a => a.fileIds))].map(id => {
  const file = record('file', id);
  assert.equal(file.projectId, run.projectId);
  assert.equal(file.sessionId, run.sessionId);
  const bytes = dataBytes(file.path);
  assert.equal(sha(bytes), file.versionId);
  return { id, name: file.name, sha256: file.versionId, text: bytes.toString('utf8') };
});
const artifacts = of('artifact').map(a => {
  const f = a.file;
  assert.equal(f.projectId,run.projectId); assert.equal(f.sessionId,run.sessionId); assert.equal(f.attemptId,a.processId);
  let bytes;
  if (f.kind === 'analysis') {
    assert.equal(f.taskId,a.taskId);
    const scope = sha(JSON.stringify([f.projectId, f.sessionId, f.taskId]));
    const version = sha(JSON.stringify([f.attemptId, f.id, f.versionId, f.name, f.mimeType, f.bytes, f.sha256]));
    bytes = dataBytes(join(root, 'analysis-files', scope, 'versions', version));
  } else {
    assert.equal(f.kind,undefined); assert.equal(f.name,'statistics.json');
    const key=sha(JSON.stringify([f.projectId,f.sessionId,f.attemptId]));
    bytes=dataBytes(join(root,'csv-jobs','attempts',key,f.name));
  }
  assert.equal(sha(bytes), f.sha256);
  assert.equal(bytes.length, f.bytes);
  return { ...a, text: bytes.toString('utf8') };
});
db.close();
console.log(JSON.stringify({ run, inputs, tasks: of('task'), attempts, sessions, tools,
  processes: of('process'), artifacts, journalSha256: sha(JSON.stringify(rows)) }, null, 2));
