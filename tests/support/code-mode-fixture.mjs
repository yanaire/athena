import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { privateTestDirectory, systemEnvironment } from '../platform-test-helpers.ts';
import { READ_ARTIFACT, RESEARCH_BOARD } from '../../runtime/code-mode-contracts.ts';
import { Storage } from '../../runtime/storage.ts';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const terminal = new Set(['succeeded','failed','cancelled','paused']);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const text = value => typeof value === 'string' ? value : Array.isArray(value) ? value.map(part => part?.text || '').join('\n') : '';
const pin = ({id, version, hash}) => ({id, version, hash});
const tool = (name, args = {}) => ({name,args});
export const request = '이 연구 미션에 연결된 결과 파일들을 읽고, 실험 조건별 수치와 출처를 비교해서 누락·불일치를 정리해 줘.';
export const subjects = [
  {name:'baseline.csv', label:'Baseline', temperature:20, rows:'voltage_mV\n9\n11\n'},
  {name:'hot.csv', label:'Hot', temperature:40, rows:'voltage_mV\n18\n22\n'},
  {name:'replicate.csv', label:'Repeat', temperature:20, rows:'voltage_mV\n11\n13\n'},
  {name:'missing.csv', label:'Missing voltage', temperature:60, rows:'temperature_C\n60\n60\n'},
  {name:'untransferred.csv', label:'Untransferred', temperature:80, rows:'voltage_mV\n39\n41\n'},
];
export const expected = {
  values: [
    {condition:'Baseline', temperatureC:20, meanMv:10, count:2},
    {condition:'Hot', temperatureC:40, meanMv:20, count:2},
    {condition:'Repeat', temperatureC:20, meanMv:12, count:2},
  ],
  missing: [{condition:'Missing voltage', field:'voltage_mV.mean'}],
  differences: [{temperatureC:20, conditions:['Baseline','Repeat'], deltaMv:2}],
  readFailures: [],
};

// For A/B the controlled responder aggregates returned text with this function.
// For C the same function runs inside QuickJS over live host-tool results.
function compare(items) {
  const values = [], missing = [], differences = [], readFailures = [];
  const byTemperature = new Map();
  for (const item of items) {
    const [condition, degrees] = item.label.split(' | ');
    const temperatureC = Number(degrees);
    if (item.failure) { readFailures.push({condition, error:item.failure}); continue; }
    const stats = item.data.statistics.find(column => column.column === 'voltage_mV');
    if (!stats || !Number.isFinite(stats.mean)) {
      missing.push({condition, field:'voltage_mV.mean'});
      continue;
    }
    values.push({condition, temperatureC, meanMv:stats.mean, count:stats.count});
    const previous = byTemperature.get(temperatureC);
    if (previous && Math.abs(previous.meanMv - stats.mean) > 1)
      differences.push({temperatureC, conditions:[previous.condition,condition], deltaMv:Math.abs(previous.meanMv - stats.mean)});
    else if (!previous) byTemperature.set(temperatureC, values.at(-1));
  }
  return {values, missing, differences, readFailures};
}

function comparisonSource(board, artifact, missionId, probes = []) {
  return `
const board = ${JSON.stringify(board)};
const artifact = ${JSON.stringify(artifact)};
const expectedIds = ${JSON.stringify(probes)};
const mission = await tools.call({...board,args:{missionId:${JSON.stringify(missionId)}}});
const refs = mission.evidence.flatMap(item => item.artifacts.map(ref => ({ref,label:item.title})));
const items = [];
for (let i = 0; i < refs.length; i += 4) {
  const batch = refs.slice(i,i+4);
  const results = await Promise.allSettled(batch.map(item => tools.call({...artifact,args:{artifactId:item.ref.id}})));
  for (let j = 0; j < results.length; j++) {
    const result = results[j];
    items.push({label:batch[j].label,...(result.status === 'fulfilled' ? {data:JSON.parse(result.value.content)} : {failure:result.reason.message})});
  }
}
const summary = (${compare.toString()})(items);
if (expectedIds.length) {
  summary.denied = [];
  for (const artifactId of expectedIds) {
    try { await tools.call({...artifact,args:{artifactId}}); }
    catch (error) { summary.denied.push(error.message.split(':')[0]); }
  }
}
return summary;`;
}

export async function createCodeModeFixture({ concurrency = 1, allowGateFixture = false, responseDelayMs = 0 } = {}) {
  const directory = privateTestDirectory(join(tmpdir(), 'athena-code-read-'));
  const home = join(directory, 'home');
  await mkdir(home, { mode:0o700 });
  const marker = join(directory, 'delay-verified-reads');
  const failures = [], requests = [], states = new Map(), outside = [];
  let child, origin, port = 0, log = '';
  let fixtureGate = false;

  function state(scenario) {
    if (!states.has(scenario)) states.set(scenario, {mission:null, published:[], report:{}});
    return states.get(scenario);
  }
  function coordinator(scenario, input, outputs) {
    const data = state(scenario);
    const total = outputs.length;
    if (scenario === 'role') {
      if (!total) return tool('run_code', {source:'return 1',tools:[]});
      assert.match(outputs[0], /run_code.*not found/i);
      return 'The coordinator is outside the read-code role.';
    }
    if (scenario === 'syntax' || scenario === 'budget' || scenario === 'invalid' || scenario === 'disabled') {
      if (!total) return tool('spawn_agent', {title:'Compare recorded results',prompt:'Fixture ' + scenario + ' C',fileIds:[],readTools:'discover'});
      if (total === 1) return tool('wait_for_agents');
      return 'The worker recorded the comparison attempt.';
    }
    const files = [...input.matchAll(/\{"fileId":"([^"]+)","name":"([^"]+)"\}/g)].map(match => ({id:match[1],name:match[2]}));
    const sources = scenario === 'foreign' || scenario === 'sibling' ? subjects.slice(0,1) : subjects;
    const length = sources.length;
    if (!total) return tool('plan_research', {objective:'Compare temperature runs and trace each voltage statistic to a result.',
      acceptanceCriteria:['Read the published results','Flag missing voltage and differences above 1 mV','Retain exact source versions'],stages:['Measure','Compare']});
    data.mission = JSON.parse(outputs[0]).id;
    if (total === 1) return sources.map((subject, index) => {
      const file = files.find(file => file.name === subject.name);
      assert.ok(file, 'The coordinator received the exact input file grants.');
      return tool('spawn_agent', {title:subject.label,prompt:'Fixture ' + scenario + ' source' + index,fileIds:[file.id]});
    });
    if (total === 1 + length) return tool('wait_for_agents');
    const joined = JSON.parse(outputs[1 + length]);
    assert.equal(joined.tasks.length, length);
    data.published = sources.map(subject => {
      const author = joined.tasks.find(task => task.title === subject.label);
      assert.equal(author.status, 'succeeded');
      assert.equal(author.artifacts.length, 1);
      return author.artifacts[0];
    });
    if (scenario === 'foreign' || scenario === 'sibling') {
      outside.push(data.published[0].id);
      return 'The original result was published in this conversation.';
    }
    if (total === 2 + length) return sources.map((subject, index) => tool('add_research_evidence', {missionId:data.mission,
      title:subject.label + ' | ' + subject.temperature, artifactIds:[data.published[index].id]}));
    const modes = scenario === 'benchmark' ? ['A','B','C'] : ['C'];
    if (total === 2 + length * 2) return modes.map(mode => tool('spawn_agent', {title:'Compare conditions ' + mode,
      prompt:'Fixture ' + scenario + ' ' + mode, fileIds:[], artifactIds:data.published.slice(0,4).map(source => source.id),
      ...(mode === 'A' ? {} : {readTools:'discover'})}));
    if (total === 2 + length * 2 + modes.length) return tool('wait_for_agents');
    if (scenario === 'benchmark' || scenario === 'scope') {
      const comparison = JSON.parse(outputs.at(-1)).tasks.filter(task => task.title.startsWith('Compare conditions '));
      assert.equal(comparison.length, modes.length);
      assert.ok(comparison.every(task => task.status === 'succeeded'), JSON.stringify(comparison));
      return 'The baseline, hot and repeat means were 10, 20 and 12 mV. The 60 °C result omitted voltage. The two 20 °C means differ by 2 mV. Verified sources are in the comparison.';
    }
    return 'See the recorded comparison receipt.';
  }

  async function worker(scenario, mode, input, outputs, wire) {
    const data = state(scenario);
    const toolNames = wire.tools.map(item => item.function.name);
    if (mode.startsWith('source')) {
      if (!outputs.length) return tool('calculate_csv');
      assert.ok(JSON.parse(outputs[0]).artifact.id);
      return 'Measurement statistics published.';
    }
    const given = JSON.parse(input.split('Granted result artifacts: ')[1] || '[]');
    if (mode === 'A') {
      assert.ok(toolNames.includes('get_research_board') && !toolNames.includes('discover_read_tools'));
      if (!outputs.length) return [tool('get_research_board'), ...given.map(ref => tool('read_file',{artifactId:ref.id}))];
      const board = JSON.parse(outputs[0]);
      const items = given.map((ref, index) => ({
        label:board.evidence.find(entry => entry.targets.some(target => target.id === ref.id)).title,
        data:JSON.parse(outputs[index+1]),
      }));
      data.report.A = {result:compare(items), sources:given};
      return JSON.stringify(data.report.A);
    }
    assert.ok(toolNames.includes('call_read_tool') && toolNames.includes('run_code') && !toolNames.includes('get_research_board'));
    const directRead = wire.tools.find(item => item.function.name === 'read_file');
    assert.ok(!directRead?.function.parameters?.properties?.artifactId, 'Artifact schema is deferred for this worker.');
    if (scenario === 'disabled') {
      if (!outputs.length) return tool('discover_read_tools');
      assert.deepEqual(JSON.parse(outputs[0]).tools.map(entry => entry.id), [RESEARCH_BOARD]);
      return 'Only the research board is available.';
    }
    if (!outputs.length) return [tool('discover_read_tools',{id:RESEARCH_BOARD}), tool('discover_read_tools',{id:READ_ARTIFACT})];
    const board = pin(JSON.parse(outputs[0])), artifact = pin(JSON.parse(outputs[1]));
    assert.equal(board.id, RESEARCH_BOARD);
    assert.equal(artifact.id, READ_ARTIFACT);
    if (mode === 'B') {
      if (outputs.length === 2) return [tool('call_read_tool',{...board,args:{missionId:data.mission}}),
        ...given.map(ref => tool('call_read_tool',{...artifact,args:{artifactId:ref.id}}))];
      const boardResult = JSON.parse(outputs[2]);
      const files = outputs.slice(3).map(value => JSON.parse(value));
      data.report.B = {
        result:compare(files.map(value => ({label:boardResult.evidence.find(entry => entry.artifacts.some(ref => ref.id === value.artifact.id)).title,
          data:JSON.parse(value.content)}))), sources:files.map(value => value.artifact),
      };
      return JSON.stringify(data.report.B);
    }
    if (outputs.length === 2 || (scenario === 'invalid' && outputs.length === 3)) {
      if (scenario === 'invalid' && outputs.length === 2)
        return tool('run_code', {source:'return 1',tools:[{...board,hash:'0'.repeat(64)}]});
      if (scenario === 'invalid') assert.match(outputs[2], /CONTRACT_CHANGED/);
      let source, bindings = [board, artifact];
      if (scenario === 'syntax') source = 'return const';
      else if (scenario === 'budget') source = `for (let i=0; i<8; i++) { try { await tools.call(${JSON.stringify({...artifact,args:{artifactId:'not-granted'}})}); } catch {} } return 'fake success';`;
      else if (scenario === 'invalid') source = `
const board = ${JSON.stringify(board)};
const artifact = ${JSON.stringify(artifact)};
const codes = [];
for (const request of [{...board,args:{projectId:'forged'}}, {...board,id:'external.mcp.read',args:{}}, {...board,version:999,args:{}}, {...artifact,args:{artifactId:'unknown'}}]) {
  try { await tools.call(request); } catch (error) { codes.push(error.message.split(':')[0]); }
}
return codes;`;
      else {
        source = comparisonSource(board, artifact, data.mission, scenario === 'scope' ? [data.published.at(-1).id, ...outside] : []);
        if (scenario === 'cancel' || scenario === 'restart' || scenario === 'revoke') await writeFile(marker, 'delay');
      }
      if (scenario === 'invalid') bindings = [board];
      return tool('run_code', {source,tools:bindings});
    }
    if (scenario === 'syntax') {
      assert.match(outputs[2], /SYNTAX_ERROR/);
      return 'JavaScript could not be parsed.';
    }
    if (scenario !== 'budget' && scenario !== 'cancel' && scenario !== 'restart') data.report.C = JSON.parse(outputs.at(-1));
    return 'Comparison recorded.';
  }

  const provider = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, {'content-type':'application/json'});
      res.end(JSON.stringify({data:[{id:'code-mode-fixture'}]}));
      return;
    }
    try {
      assert.equal(req.url, '/v1/chat/completions');
      const parts = [];
      for await (const part of req) parts.push(Buffer.from(part));
      const body = Buffer.concat(parts);
      const wire = JSON.parse(body);
      const last = wire.messages.findLastIndex(message => message.role === 'user');
      const input = text(wire.messages[last]?.content);
      const outputs = wire.messages.slice(last+1).filter(message => message.role === 'tool').map(message => text(message.content));
      const parent = wire.tools.some(item => item.function.name === 'spawn_agent');
      const [,scenario,mode] = (parent ? /^(?:Code-mode test: )([a-z]+)/ : /^Fixture ([a-z]+) (\w+)/).exec(input)
        || (parent && input.startsWith(request) ? ['', 'benchmark',''] : []);
      assert.ok(scenario, 'Unexpected controlled provider input: ' + input);
      const started = performance.now();
      const entry = {scenario, mode:parent?'parent':mode, requestBytes:body.length, at:Date.now()};
      requests.push(entry);
      const next = parent ? coordinator(scenario, input, outputs) : await worker(scenario, mode, input, outputs, wire);
      const calls = typeof next === 'string' ? [] : (Array.isArray(next) ? next : [next]);
      entry.tools = calls.map(call => call.name);
      entry.sourceBytes = Buffer.byteLength(calls.find(call => call.name === 'run_code')?.args.source ?? '');
      entry.responderMs = performance.now() - started;
      if (responseDelayMs) await delay(responseDelayMs);
      if (res.destroyed) return;
      const delta = typeof next === 'string' ? {role:'assistant',content:next} : {role:'assistant',tool_calls:calls.map((call,index) => ({
        index, id:'call_' + randomUUID(), type:'function', function:{name:call.name, arguments:JSON.stringify(call.args)},
      }))};
      res.writeHead(200, {'content-type':'text/event-stream'});
      for (const [chunk, reason] of [[delta,null],[{}, calls.length ? 'tool_calls' : 'stop']])
        res.write('data: ' + JSON.stringify({id:'code-mode-fixture',object:'chat.completion.chunk',created:1,
          model:'code-mode-fixture',choices:[{index:0,delta:chunk,finish_reason:reason}]}) + '\n\n');
      res.end('data: [DONE]\n\n');
    } catch (error) {
      failures.push(String(error.stack || error));
      if (!res.headersSent) res.writeHead(401, {'content-type':'application/json'});
      res.end(JSON.stringify({error:{message:'Controlled provider assertion failed.'}}));
    }
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');

  async function startHost() {
    const url = 'http://127.0.0.1:' + provider.address().port + '/v1';
    child = spawn(process.execPath, ['--import','./tests/support/code-mode-controls.mjs','runtime/server.ts'], {
      cwd:repo, stdio:['ignore','pipe','pipe'], windowsHide:true,
      env:{...systemEnvironment(), HOME:home, USERPROFILE:home, ATHENA_DATA_DIR:join(directory,'workspace'),
        ATHENA_PORT:String(port), ATHENA_ENDPOINT:url, ATHENA_MODEL:'code-mode-fixture',
        ATHENA_PROCESS_CONCURRENCY:'1', ATHENA_MODEL_CONCURRENCY:'1', ATHENA_MAX_CHILDREN:'8',
        ATHENA_CODE_READ_CONCURRENCY:String(concurrency), ATHENA_TEST_READ_DELAY_FILE:marker,
        ...(allowGateFixture ? {ATHENA_TEST_ANALYSIS_GATE:'1'} : {})},
    });
    log = '';
    const current = child;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Host did not start: ' + log)), 30_000);
      function abort(error) { clearTimeout(timer); reject(error); }
      current.once('error', abort);
      current.once('exit', (code, signal) => abort(new Error('Host exited ' + code + '/' + signal + '\n' + log)));
      current.stderr.on('data', chunk => {log += chunk;});
      current.stdout.on('data', chunk => {
        log += chunk;
        const match = /Athena listening at (http:\/\/127\.0\.0\.1:(\d+))/.exec(log);
        if (match) {origin = match[1]; port = Number(match[2]); clearTimeout(timer); resolve();}
      });
    });
    const snapshot = await rpc('getSnapshot');
    fixtureGate = snapshot.execution.runtime.available && snapshot.execution.runtime.node.path === 'fixture-unused.wasm';
  }
  async function stopHost(force = false) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const previous = child;
    const stopped = once(previous, 'exit');
    previous.kill(force ? 'SIGKILL' : 'SIGTERM');
    const timer = setTimeout(() => previous.kill('SIGKILL'), 7_000);
    try {
      const [code, signal] = await stopped;
      if (!force && process.platform !== 'win32') assert.deepEqual([code, signal], [0,null], log);
    } finally { clearTimeout(timer); }
  }
  async function rpc(method, args = []) {
    const response = await fetch(origin + '/api/rpc', {method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({method,args}),signal:AbortSignal.timeout(30_000)});
    const body = await response.json();
    assert.ok(response.ok && !body.error, JSON.stringify(body));
    return body.result;
  }
  async function waitSnapshot(predicate, timeout = 30_000) {
    const deadline = Date.now() + timeout;
    let snapshot;
    while (Date.now() < deadline) {
      assert.deepEqual(failures, []);
      snapshot = await rpc('getSnapshot');
      if (predicate(snapshot)) return snapshot;
      await delay(25);
    }
    assert.fail('Host condition did not arrive: ' + JSON.stringify({run:snapshot?.run,tasks:snapshot?.tasks,requests}));
  }
  async function close() {
    try { await stopHost(); }
    finally {
      provider.closeAllConnections();
      await new Promise(resolve => provider.close(resolve));
      await rm(directory,{recursive:true,force:true});
    }
  }
  try { await startHost(); } catch (error) { await stopHost(true); await close(); throw error; }
  return {
    get origin() { return origin; },
    get fixtureGate() { return fixtureGate; },
    requests, state, rpc, waitSnapshot, stopHost, startHost, close,
    async conversation({projectId, enabled = true} = {}) {
      const project = projectId ? {id:projectId} : (await rpc('createProject',[{name:'Code-mode acceptance',defaultModel:null}])).project;
      const conversation = await rpc('createSession',[{projectId:project.id,title:'Compare measurement runs',model:null}]);
      await rpc('setProjectExecution',[project.id,enabled]);
      return {...conversation,projectId:project.id};
    },
    async submit(sessionId, scenario) {
      const count = scenario === 'foreign' || scenario === 'sibling' ? 1 : ['benchmark','scope','cancel','restart','revoke'].includes(scenario) ? subjects.length : 0;
      const fileReferences = count ? (await rpc('stageFiles',[sessionId,subjects.slice(0,count).map(item => ({
        name:item.name,mimeType:'text/csv',data:Buffer.from(item.rows).toString('base64'),
      }))])).fileReferences : [];
      const response = await rpc('pi',[sessionId,{type:'prompt',id:randomUUID(),message:scenario === 'benchmark' ? request : 'Code-mode test: ' + scenario,fileReferences}]);
      assert.equal(response.success,true,JSON.stringify(response));
      return response.data.runId;
    },
    finished(runId) { return waitSnapshot(snapshot => snapshot.run.id === runId && terminal.has(snapshot.run.status)); },
    revokeForTest(projectId) {
      // The settings RPC already serializes permission changes with active runs.
      // Inject a storage-side permission loss to verify the live authorization check.
      const storage = new Storage(join(directory,'workspace'));
      try {
        const project = storage.project(projectId);
        assert.ok(project?.offlineAnalysis);
        storage.transaction(() => storage.putProject({...project,offlineAnalysis:false}));
      } finally { storage.close(); }
    },
    async verifySources(snapshot, result) {
      const byId = new Map(snapshot.artifacts.map(artifact => [artifact.id,artifact]));
      assert.ok(result.sources.length > 0);
      for (const source of result.sources) {
        const artifact = byId.get(source.id);
        assert.equal(source.version,artifact.version);
        assert.equal(source.sha256,artifact.file.sha256);
        const response = await fetch(origin + source.uri);
        assert.equal(response.status,200);
        assert.equal(sha256(Buffer.from(await response.arrayBuffer())),source.sha256);
      }
    },
  };
}
