import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile, realpath, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { privateTestDirectory } from './platform-test-helpers.ts';
import { JobRunner } from '../runtime/jobs.ts';
import { TaskManager } from '../runtime/manager.ts';
import type { ResearchEvidence, ResearchMission, ResearchReview } from '../runtime/research.ts';

type Wire = { model: string; messages: { role: string; content: unknown }[]; tools: { function: { name: string } }[] };
type Call = { name: string; args: object };
type Snapshot = ReturnType<TaskManager['getSnapshot']>;
type Assignment = Pick<ResearchReview, 'id' | 'missionId' | 'question' | 'targets'> & { reviewId: string };
const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(part => part && typeof part === 'object' && 'text' in part ? String(part.text) : '').join('\n');
  return '';
}
function users(wire: Wire) { return wire.messages.filter(message => message.role === 'user'); }
function outputs(wire: Wire): string[] {
  return wire.messages.slice(wire.messages.findLastIndex(message => message.role === 'user') + 1)
    .filter(message => message.role === 'tool').map(message => text(message.content));
}
function parent(wire: Wire) { return wire.tools.some(tool => tool.function.name === 'spawn_agent'); }
function complete(response: ServerResponse, next: string | Call) {
  const delta = typeof next === 'string' ? { role: 'assistant', content: next } : { role: 'assistant', tool_calls: [{ index: 0,
    id: 'call_' + randomUUID(), type: 'function', function: { name: next.name, arguments: JSON.stringify(next.args) } }] };
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [chunk, reason] of [[delta, null], [{}, typeof next === 'string' ? 'stop' : 'tool_calls']]) {
    response.write('data: ' + JSON.stringify({ id: 'research-fixture', object: 'chat.completion.chunk', created: 1,
      model: 'research-fixture', choices: [{ index: 0, delta: chunk, finish_reason: reason }] }) + '\n\n');
  }
  response.end('data: [DONE]\n\n');
}
function when(manager: TaskManager, predicate: (snapshot: Snapshot) => boolean): Promise<Snapshot> {
  if (predicate(manager.getSnapshot())) return Promise.resolve(manager.getSnapshot());
  return new Promise(resolve => {
    const off = manager.subscribe(() => { const snapshot = manager.getSnapshot(); if (predicate(snapshot)) { off(); resolve(snapshot); } });
  });
}
const terminal = (manager: TaskManager) => when(manager, snapshot => ['succeeded', 'failed', 'cancelled', 'paused'].includes(snapshot.run.status));

async function fixture(t: TestContext, cancelFirstReview = false) {
  const directory = await realpath(privateTestDirectory(join(tmpdir(), 'athena-research-manager-')));
  const failures: unknown[] = []; const hits: Wire[] = [];
  const state = { recovering: false, inputId: '', missionId: '', evidenceId: '', authorArtifactId: '', initialReviewId: '',
    reviewerInputs: [] as string[], reviewerQuestions: [] as string[] };

  // This narrowly controlled discovery flag enables the existing approved
  // artifact-transfer gate on hosts without native WASI. No WASI call is made:
  // every actual calculation below uses the real bundled Node CSV MCP worker.
  t.mock.method(JobRunner.prototype, 'analysisAccess', async () => ({ available: true as const, engine: 'Wasmtime 50.0.3' as const,
    node: { path: 'qjs.wasm', version: 'QuickJS-ng 0.18.0' }, python: { path: 'python.wasm', version: 'CPython 3.15.2' } }));

  function answer(wire: Wire): string | Call {
    const results = outputs(wire);
    if (parent(wire)) {
      if (users(wire).length > 1) return results.length ? 'The manually retried independent reviewer completed; the original result remains 19 mV.' : { name: 'list_tasks', args: {} };
      switch (results.length) {
        case 0: return { name: 'load_skill', args: { id: 'athena-research-intake', reason: 'Define acceptance criteria for the requested measurement study.', mode: 'automatic' } };
        case 1: return { name: 'plan_research', args: { objective: 'Compute measurement statistics and independently reproduce the saved result.', acceptanceCriteria: ['Use the attached original bytes', 'Preserve missing and zero observations', 'Compare the independently calculated result with the published result'], stages: ['Plan', 'Calculate', 'Review', 'Retain method'] } };
        case 2: {
          state.missionId = (JSON.parse(results[1]!) as ResearchMission).id;
          return { name: 'spawn_agent', args: { title: 'Measurement author', prompt: 'Calculate the original measurement_mV CSV. Report only the published values.', fileIds: [state.inputId] } };
        }
        case 3: return { name: 'wait_for_agents', args: {} };
        case 4: {
          const joined = JSON.parse(results[3]!); state.authorArtifactId = joined.tasks[0].artifacts[0].id;
          return { name: 'read_file', args: { artifactId: state.authorArtifactId } };
        }
        case 5: {
          const verified = JSON.parse(JSON.parse(results[4]!).content);
          assert.equal(verified.statistics[0].mean, 19);
          return { name: 'add_research_evidence', args: { missionId: state.missionId, title: 'Original measurement calculation', fileIds: [state.inputId], artifactIds: [state.authorArtifactId] } };
        }
        case 6: {
          state.evidenceId = (JSON.parse(results[5]!) as ResearchEvidence).id;
          return { name: 'request_review', args: { missionId: state.missionId, evidenceIds: [state.evidenceId], question: 'Recompute from the original input, compare all statistics and state any discrepancy.' } };
        }
        case 7: {
          state.initialReviewId = JSON.parse(results[6]!).review.id;
          return { name: 'wait_for_agents', args: {} };
        }
        case 8: {
          if (cancelFirstReview) return 'The author result is preserved. Independent review was cancelled and remains incomplete.';
          return { name: 'propose_knowledge', args: { missionId: state.missionId, title: 'Reproducible voltage summary',
            method: 'Calculate the granted original CSV and independently recalculate before reusing the conclusion.',
            rationale: 'Explicit input versions preserve reproducibility.', applicability: ['CSV with a measurement_mV column and stated units'],
            evidenceIds: [state.evidenceId], reviewIds: [state.initialReviewId] } };
        }
        case 9: {
          assert.equal(JSON.parse(results[8]!).level, 'verified');
          return { name: 'remember_research', args: { scope: 'project', text: 'Report measurement_mV as millivolts and distinguish missing values from valid zeros.' } };
        }
        default: return 'Mean 19 mV; the independent reproduction agrees with the exact saved input and artifact.';
      }
    }
    const input = text(users(wire).at(-1)?.content);
    if (!input.includes('Review assignment: ')) {
      if (!results.length) return { name: 'load_skill', args: { id: 'athena-data-quality', reason: 'Distinguish missing, nonnumeric and valid zero measurements.', mode: 'automatic' } };
      if (results.length === 1) return { name: 'calculate_csv', args: { fileId: state.inputId, column: 'measurement_mV' } };
      assert.equal(JSON.parse(results[1]!).statistics.statistics[0].mean, 19);
      return 'The original CSV mean is 19 mV.';
    }
    const assignmentLine = input.split('\n').find(line => line.startsWith('Review assignment: ')); assert.ok(assignmentLine);
    const assignment = JSON.parse(assignmentLine.slice('Review assignment: '.length)) as Assignment;
    if (!results.length) {
      state.reviewerInputs.push(input); state.reviewerQuestions.push(assignment.reviewId);
      return { name: 'read_file', args: { artifactId: state.authorArtifactId } };
    }
    if (results.length === 1) return { name: 'calculate_csv', args: { fileId: state.inputId, column: 'measurement_mV' } };
    if (results.length === 2) {
      const original = JSON.parse(results[0]!); const computed = JSON.parse(results[1]!);
      assert.deepEqual(computed.statistics.statistics, original.statistics);
      assert.equal(computed.statistics.statistics[0].mean, 19);
      return { name: 'add_research_evidence', args: { missionId: assignment.missionId, title: 'Independent measurement reproduction', fileIds: [state.inputId], artifactIds: [computed.artifact.id] } };
    }
    if (results.length === 3) return { name: 'submit_review', args: { reviewId: assignment.reviewId, verdict: 'supported',
      checks: ['Read the published artifact and recomputed from the same granted input bytes; all saved statistics match.'], findings: [], reproductionEvidenceIds: [JSON.parse(results[2]!).id] } };
    assert.equal(JSON.parse(results[3]!).verdict, 'supported');
    return 'The independently recomputed mean is 19 mV, with all recorded statistics matching.';
  }

  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const wire = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Wire; hits.push(wire);
      const input = text(users(wire).at(-1)?.content);
      if (cancelFirstReview && !state.recovering && !parent(wire) && input.includes('Review assignment: ')) {
        await new Promise<void>(resolve => response.once('close', resolve)); return;
      }
      complete(response, answer(wire));
    } catch (error) {
      failures.push(error);
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Controlled research provider assertion failed.', type: 'authentication_error' } }));
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const environment = { ATHENA_ENDPOINT: `http://127.0.0.1:${address.port}/v1`, ATHENA_MODEL: 'research-fixture', ATHENA_PROVIDER: '',
    ATHENA_API_KEY: '', ATHENA_MODEL_CONCURRENCY: '1', ATHENA_MAX_CHILDREN: '3', ATHENA_MAX_DEPTH: '1' };
  const restore = Object.entries(environment).map(([key, value]) => { const old = process.env[key]; process.env[key] = value; return () => { if (old === undefined) delete process.env[key]; else process.env[key] = old; }; });
  const managers: TaskManager[] = [];
  t.after(async () => {
    try { for (const manager of managers) await manager.close(); }
    finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); restore.forEach(fn => fn()); await rm(directory, { recursive: true, force: true }); }
  });
  async function launch() { const manager = new TaskManager({ dataDir: directory }); managers.push(manager); await manager.initialize(); return manager; }
  const manager = await launch(); const { project } = await manager.createProject({ name: 'Research integration' });
  const { sessionId } = await manager.createSession({ projectId: project.id, title: 'Independent voltage study' });
  await manager.setProjectExecution(project.id, true);
  const csv = await readFile(new URL('../docs/measurements.csv', import.meta.url), 'utf8');
  const { fileReferences } = await manager.stageFiles(sessionId, [{ name: 'measurements.csv', mimeType: 'text/csv', data: Buffer.from(csv).toString('base64') }]);
  state.inputId = fileReferences[0]!.id;
  return { manager, launch, project, sessionId, fileReferences, csv, state, failures, hits };
}

test('real Pi research tools bind skills, CSV evidence, separate reviewer reproduction and durable verified Books', { timeout: 45_000 }, async t => {
  const f = await fixture(t); let manager = f.manager;
  await manager.pi(f.sessionId, { type: 'prompt', id: 'full-research', message: 'Run the complete measurement study and independently reproduce its evidence.', fileReferences: f.fileReferences });
  const snapshot = await terminal(manager); assert.deepEqual(f.failures, []);
  assert.equal(snapshot.run.status, 'succeeded');
  assert.equal(snapshot.processes.length, 2); assert.equal(snapshot.artifacts.length, 2);
  for (const calculation of snapshot.processes) {
    assert.equal(calculation.status, 'succeeded'); assert.equal(calculation.job.mcp?.server, 'athena-measurements');
    assert.equal(calculation.job.mcp?.tool, 'calculate_csv'); assert.equal(calculation.job.analysis, undefined);
    assert.equal(calculation.job.program, process.execPath);
    assert.ok(calculation.job.args.some(argument => argument.endsWith('mcp-worker.mjs')), 'Real Node MCP worker was spawned.');
  }
  const board = manager.getResearch(f.project.id, f.sessionId); const review = board.reviews[0]; const knowledge = board.books[0];
  assert.ok(review?.reviewer && knowledge);
  assert.equal(review.state, 'completed'); assert.equal(review.verdict, 'supported'); assert.equal(knowledge.level, 'verified');
  const author = snapshot.tasks.find(task => task.title === 'Measurement author')!;
  assert.notEqual(review.reviewer.agentSessionId, author.agentSessionId); assert.notEqual(review.reviewer.taskId, author.id);
  const reviewerAttempt = snapshot.attempts.find(attempt => attempt.id === review.reviewer!.attemptId)!;
  assert.deepEqual(reviewerAttempt.fileIds, [f.state.inputId]); assert.deepEqual(reviewerAttempt.artifactGrants, [f.state.authorArtifactId]);
  assert.ok(f.state.reviewerInputs.every(input => !input.includes('The original CSV mean is 19 mV.')), 'Author conclusion is not copied into the review prompt.');
  const versions = [{ id: f.state.inputId, version: sha256(f.csv) }];
  const downloaded = new Map<string, string>();
  for (const artifact of snapshot.artifacts) {
    assert.deepEqual(artifact.evidence, versions);
    const file = await manager.artifactDownload(f.sessionId, artifact.id); downloaded.set(artifact.id, sha256(file.bytes));
    assert.equal(sha256(file.bytes), artifact.file.sha256);
    assert.equal(JSON.parse(file.bytes.toString('utf8')).statistics[0].mean, 19);
  }
  const reproduction = board.evidence.find(evidence => review.reproductionEvidenceIds?.includes(evidence.id))!;
  assert.deepEqual(reproduction.targets.find(target => target.kind === 'artifact')?.inputVersions, versions);
  const extensions = manager.getExtensions(f.project.id);
  assert.ok(extensions.skillUses.some(use => use.skillId === 'athena-research-intake'));
  assert.ok(extensions.skillUses.some(use => use.skillId === 'athena-data-quality'));
  for (const use of extensions.skillUses) { assert.match(use.sha256, /^[a-f0-9]{64}$/); assert.ok(snapshot.attempts.some(attempt => attempt.id === use.attemptId)); }
  await manager.close(); manager = await f.launch();
  assert.deepEqual(manager.getResearch(f.project.id, f.sessionId), board);
  assert.deepEqual(manager.getExtensions(f.project.id).skillUses, extensions.skillUses);
  for (const [id, digest] of downloaded) assert.equal(sha256((await manager.artifactDownload(f.sessionId, id)).bytes), digest);
});

test('cancelled reviewer retries with a new pinned review ID while original CSV result and grants survive restart', { timeout: 45_000 }, async t => {
  const f = await fixture(t, true); let manager = f.manager;
  await manager.pi(f.sessionId, { type: 'prompt', id: 'cancel-research-review', message: 'Calculate and request independent review.', fileReferences: f.fileReferences });
  const running = await when(manager, snapshot => snapshot.tasks.some(task => task.title === 'Independent evidence review' && task.status === 'running'));
  const reviewer = running.tasks.find(task => task.title === 'Independent evidence review')!; assert.ok(reviewer.attemptId);
  await manager.cancelTask(reviewer.id); const before = await terminal(manager); assert.deepEqual(f.failures, []);
  assert.equal(before.tasks.find(task => task.id === reviewer.id)?.status, 'cancelled');
  const boardBefore = manager.getResearch(f.project.id, f.sessionId); assert.equal(boardBefore.reviews.length, 1);
  assert.equal(boardBefore.reviews[0]?.state, 'cancelled'); assert.equal(boardBefore.books.length, 0);
  const artifact = before.artifacts[0]!; const digest = sha256((await manager.artifactDownload(f.sessionId, artifact.id)).bytes);
  await manager.close(); const callsBeforeRestart = f.hits.length; manager = await f.launch();
  assert.equal(f.hits.length, callsBeforeRestart, 'Restart does not run the paused or cancelled review automatically.');
  f.state.recovering = true;
  const retry = await manager.retryTask(reviewer.id, { requestId: 'manual-review-retry', expectedAttemptId: reviewer.attemptId });
  const after = await terminal(manager); assert.deepEqual(f.failures, []);
  assert.equal(after.tasks.find(task => task.id === reviewer.id)?.status, 'succeeded');
  const board = manager.getResearch(f.project.id, f.sessionId); assert.equal(board.reviews.length, 2);
  const original = board.reviews.find(review => review.id === boardBefore.reviews[0]!.id)!;
  const recovered = board.reviews.find(review => review.previousReviewId === original.id)!;
  assert.equal(original.state, 'cancelled'); assert.equal(original.verdict, undefined);
  assert.equal(recovered.state, 'completed'); assert.equal(recovered.verdict, 'supported');
  assert.equal(recovered.reviewer?.attemptId, retry.attemptId); assert.notEqual(recovered.id, original.id);
  assert.deepEqual(recovered.targets, original.targets);
  const attempts = after.attempts.filter(attempt => attempt.taskId === reviewer.id);
  assert.deepEqual(attempts.map(attempt => attempt.status), ['cancelled', 'succeeded']);
  assert.deepEqual(attempts[1]!.fileIds, attempts[0]!.fileIds); assert.deepEqual(attempts[1]!.artifactGrants, attempts[0]!.artifactGrants);
  assert.equal(sha256((await manager.artifactDownload(f.sessionId, artifact.id)).bytes), digest);
  assert.equal(after.artifacts.find(item => item.id === artifact.id)?.version, artifact.version);
  assert.equal(board.books.length, 0, 'Read-only parent reconciliation cannot silently promote new knowledge.');
  assert.ok(after.attempts.some(attempt => attempt.kind === 'reconciliation' && attempt.result?.includes('retried independent reviewer completed')));
  assert.equal(after.processes.length, 2); assert.ok(after.processes.every(process => process.job.mcp?.tool === 'calculate_csv' && process.job.analysis === undefined));
});
