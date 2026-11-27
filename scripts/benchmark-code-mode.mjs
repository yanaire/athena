import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { createCodeModeFixture, expected } from '../tests/support/code-mode-fixture.mjs';

const iterations = Number(process.argv[2] ?? '3');
assert.ok(Number.isSafeInteger(iterations) && iterations >= 1 && iterations <= 10, 'Use 1–10 iterations.');
const git = args => execFileSync('git',args,{cwd:new URL('..',import.meta.url),encoding:'utf8'}).trim();
const round = value => Number(value.toFixed(2));
const refs = sources => sources.map(({id,version,sha256}) => ({id,version,sha256}));

function toolSpan(snapshot, attemptId, names) {
  const tools = snapshot.tools.filter(tool => tool.attemptId === attemptId && names.includes(tool.sdkToolName));
  const traces = tools.map(tool => {
    const start = snapshot.events.find(event => event.toolId === tool.id && event.type === 'tool_execution_start');
    const end = snapshot.events.find(event => event.toolId === tool.id && event.type === 'tool_execution_end');
    assert.ok(start && end);
    return {start:start.at,end:end.at};
  });
  return traces.length ? Math.max(...traces.map(trace => trace.end)) - Math.min(...traces.map(trace => trace.start)) : 0;
}

const samples = [];
for (let trial = 1; trial <= iterations; trial++) {
  const fixture = await createCodeModeFixture({allowGateFixture:true});
  try {
    const {sessionId} = await fixture.conversation();
    const start = Date.now();
    const run = await fixture.submit(sessionId,'benchmark');
    const snapshot = await fixture.finished(run);
    const complete = Date.now();
    const report = fixture.state('benchmark').report;
    const code = snapshot.processes.find(process => process.job.codeMode).job.codeMode;
    assert.equal(code.peakConcurrency,1);
    assert.equal(code.calls.filter(call => call.status === 'succeeded').length,5);
    const modes = {};
    for (const mode of ['A','B','C']) {
      const task = snapshot.tasks.find(task => task.title === 'Compare conditions ' + mode);
      const attempt = snapshot.attempts.find(item => item.id === task.attemptId);
      const hits = fixture.requests.filter(item => item.scenario === 'benchmark' && item.mode === mode);
      const sent = hits.flatMap(item => item.tools);
      const verified = report[mode];
      assert.deepEqual(verified.result,expected);
      assert.deepEqual(refs(verified.sources),refs(report.A.sources));
      await fixture.verifySources(snapshot,verified);
      const codeExecutions = sent.filter(name => name === 'run_code').length;
      modes[mode] = {
        modelRoundTrips:hits.length,
        inputTokens:null, outputTokens:null, cachedInputTokens:null, billedCost:null,
        measuredRequestBytes:hits.reduce((total,item) => total + item.requestBytes,0),
        initialRequestBytes:hits[0].requestBytes,
        workerElapsedMs:attempt.endedAt-attempt.startedAt,
        queryTools:sent.filter(name => name === 'discover_read_tools').length,
        ordinaryReadCalls:sent.filter(name => ['get_research_board','read_file','call_read_tool'].includes(name)).length,
        codeExecutions,
        nestedReadCalls:mode === 'C' ? code.calls.length : 0,
        ordinaryReadBatchMs:toolSpan(snapshot,attempt.id,['get_research_board','read_file','call_read_tool']),
        discoveryBatchMs:toolSpan(snapshot,attempt.id,['discover_read_tools']),
        codeElapsedMs:mode === 'C' ? code.endedAt-code.startedAt : null,
        nestedReadTotalMs:mode === 'C' ? code.calls.reduce((total,call) => total+call.endedAt-call.startedAt,0) : null,
        workerCpuMs:mode === 'C' ? code.cpuMs : null,
        controlledResponderMs:round(hits.reduce((total,item) => total+item.responderMs,0)),
        codeSourceBytes:hits.reduce((total,item) => total+item.sourceBytes,0),
        codeRevisions:Math.max(0,codeExecutions-1),
        retries:snapshot.events.filter(event => event.attemptId === attempt.id && event.type === 'auto_retry_start').length,
        correct:true, verifiedSources:verified.sources.length,
      };
    }
    samples.push({trial, fixtureAnalysisGate:fixture.fixtureGate, sharedRunElapsedMs:complete-start,
      identicalSources:refs(report.C.sources), modes});
  } finally { await fixture.close(); }
}
const medians = {};
for (const mode of ['A','B','C']) {
  medians[mode] = Object.fromEntries(Object.entries(samples[0].modes[mode]).filter(([,value]) => typeof value === 'number').map(([key]) => {
    const sorted = samples.map(sample => sample.modes[mode][key]).sort((a,b) => a-b);
    const middle = Math.floor(sorted.length/2);
    return [key,round(sorted.length % 2 ? sorted[middle] : (sorted[middle-1]+sorted[middle])/2)];
  }));
}
const output = JSON.stringify({
  checkoutRevision:git(['rev-parse','HEAD']),
  platform:process.platform, arch:process.arch, node:process.version,
  model:'Controlled local OpenAI-compatible SSE responder through the real Pi SDK',
  realModelAcceptance:'NOT RUN',
  tokenAndBillingMetrics:'NOT RUN. The responder supplies no token usage or billing.',
  modelConcurrency:1, jobRunnerConcurrency:1, readConcurrency:1,
  result:expected, medians, samples,
},null,2) + '\n';
if (process.argv[3]) await writeFile(process.argv[3],output);
else process.stdout.write(output);
