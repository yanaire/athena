import assert from 'node:assert/strict';
import {execFile, spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {promisify} from 'node:util';
import test, {type TestContext} from 'node:test';
import {AnalysisFiles} from '../runtime/analysis-files.ts';
import {CsvJobRunner, type CsvJobRunnerOptions, type CsvAttempt} from '../runtime/jobs.ts';

const docker=promisify(execFile);
const scope={projectId:'project',sessionId:'session',taskId:'task'};
const identity={...scope,attemptId:'one',requestId:'req',toolId:'tool'};
const job=(source:string)=>({...identity,language:'python' as const,script:{name:'main.py',bytes:Buffer.from(source)},inputs:[],outputs:[]});
const live={skip:process.env.ATHENA_ANALYSIS_IMAGE ? false : 'Set ATHENA_ANALYSIS_IMAGE to the immutable test image ID.',timeout:30000};
async function fixture(t:TestContext,opts:Partial<CsvJobRunnerOptions>={}) {
  const dir=await mkdtemp(join(tmpdir(),'athena-analysis-')); const files=new AnalysisFiles(dir);
  const runner=new CsvJobRunner({dataDir:dir,...opts});
  t.after(async()=>{await runner.close();await rm(dir,{recursive:true,force:true});});
  return {dir,files,runner};
}
const remaining=async(id:string)=>(await docker('docker',['ps','-aq','--no-trunc','--filter','id='+id])).stdout.trim();

test('mutable tags never authorize an interpreter or host-native fallback',async t=>{
  const old=process.env.ATHENA_ANALYSIS_IMAGE;
  process.env.ATHENA_ANALYSIS_IMAGE='untrusted:latest';
  t.after(()=>{if(old===undefined)delete process.env.ATHENA_ANALYSIS_IMAGE;else process.env.ATHENA_ANALYSIS_IMAGE=old;});
  const {runner}=await fixture(t);
  const result=await runner.startAnalysis(job('print(42)')).result;
  assert.equal(result.status,'failed'); assert.equal(result.startedAt,null); assert.equal(result.artifacts,undefined);
  assert.match(result.error??'',/immutable sha256/);
});

test('Python works on frozen inputs, enforces isolation, and publishes reusable outputs plus the exact source',live,async t=>{
  const {runner,files,dir}=await fixture(t);
  const access=await runner.analysisAccess(); assert.ok(access.available,JSON.stringify(access));
  assert.match(access.node.version,/^v\d+/); assert.match(access.python.version,/^Python 3\./);
  const canary=join(dir,'host-only.txt'); await writeFile(canary,'host only');
  const source=["import os, sys, socket, pathlib, subprocess", "p=pathlib.Path", "assert os.getuid()==65534", "assert set(os.environ) <= {'PATH','LANG','HOME','TZ','LC_CTYPE'}",
    "assert 'CapEff:\t0000000000000000' in p('/proc/self/status').read_text()", "assert 'NoNewPrivs:\t1' in p('/proc/self/status').read_text()",
    "assert not p(sys.argv[1]).exists() and not p('/var/run/docker.sock').exists()", "assert sys.argv[2]=='--literal;$(unused)'",
    "assert all(row.split()[0]=='lo' for row in p('/proc/net/route').read_text().splitlines()[1:])",
    "try: socket.create_connection(('192.0.2.1',9),timeout=1)", "except OSError as e: assert e.errno==101, repr(e)", "else: raise AssertionError('external route unexpectedly available')",
    "for dest in ['source.txt','/workspace/extra.txt','/outputs/extra.txt']:", " try: p(dest).write_text('not allowed')", " except OSError: pass", " else: raise AssertionError(dest)",
    "p('/outputs/answer.txt').write_text(p('source.txt').read_text().upper())", "p('/outputs/empty.txt').write_text('')", "print('finished')",
    "subprocess.Popen(['/bin/sleep','120'],start_new_session=True)"].join('\n');
  const inputs=[{name:'source.txt',bytes:Buffer.from('granted'),fileId:'f',versionId:'v'}];
  const request={...job(source),inputs,outputs:['answer.txt','empty.txt'],args:[canary,'--literal;$(unused)']};
  await files.write(scope,'main.py','newer workspace revision');
  const handle=runner.startAnalysis(request); inputs[0]?.bytes.fill(0); request.script.bytes.fill(0);
  const result=await handle.result; assert.equal(result.status,'succeeded',result.error+' '+result.stderr);
  assert.equal(result.stdout,'finished\n'); assert.ok(result.containerId); assert.equal(await remaining(result.containerId),'');
  const [script,answer,empty]=result.artifacts??[]; assert.ok(script && answer && empty);
  assert.deepEqual((result.artifacts??[]).map(a=>a.name),['main.py','answer.txt','empty.txt']);
  assert.equal((await files.download(script)).toString(),source); assert.equal((await files.download(answer)).toString(),'GRANTED');
  assert.equal((await files.download(empty)).length,0); assert.equal(await files.read(scope,'main.py'),'newer workspace revision');
  const snapshots=await files.snapshot(scope,['answer.txt']);
  const second=await runner.startAnalysis({...identity,attemptId:'two',language:'node',script:{name:'reuse.mjs',bytes:Buffer.from("import fs from 'node:fs'; fs.writeFileSync('/outputs/result.json',JSON.stringify(fs.readFileSync('answer.txt','utf8')))")},inputs:snapshots,outputs:['result.json']}).result;
  assert.equal(second.status,'succeeded',second.error+' '+second.stderr); assert.equal(await files.read(scope,'result.json'),'"GRANTED"');
});

test('a successful interpreter without its declared file fails without publishing partial artifacts',live,async t=>{
  const {runner,files}=await fixture(t);
  const result=await runner.startAnalysis({...job("open('/outputs/present.txt','w').write('ok')"),outputs:['present.txt','absent.txt']}).result;
  assert.equal(result.exitCode,0); assert.equal(result.status,'failed'); assert.match(result.error??'',/not written: absent.txt/);
  assert.equal(result.artifacts,undefined); assert.equal(await files.has(scope,'present.txt'),false);
});

const sleeping="import subprocess,time; subprocess.Popen(['/bin/sleep','120'],start_new_session=True); print('descendant ready',flush=True); time.sleep(120)";
for(const mode of ['cancelled','timed_out'] as const) test('the runner removes a live container and its descendants when '+mode,live,async t=>{
  const started=Promise.withResolvers<CsvAttempt>();
  const {runner,dir}=await fixture(t,{timeoutMs:mode==='timed_out'?2000:10000,onEvent:event=>{
    if(event.type==='process_started')started.resolve(event.attempt);
  }});
  const handle=runner.startAnalysis(job(sleeping));
  const receipt=await Promise.race([started.promise,handle.result]);assert.ok(receipt.containerId,receipt.error);
  const id=receipt.containerId;
  // Observe an independently sessioned descendant alive before requesting cancellation.
  let found=false; for(let n=0;n<30&&!found;n++) {
    const {stdout}=await docker('docker',['top',id,'-eo','pid,comm']); found=stdout.includes('sleep'); if(!found)await delay(25);
  }
  assert.ok(found,'expected real sleep child');
  if(mode==='cancelled'){
    const restored=Promise.withResolvers<CsvAttempt>();
    const reopened=new CsvJobRunner({dataDir:dir,recoveredAttempts:[receipt],onEvent:e=>restored.resolve(e.attempt)});t.after(()=>reopened.close());
    assert.equal((await restored.promise).status,'interrupted'); assert.equal(await remaining(id),id);
    assert.throws(()=>reopened.startAnalysis(job(sleeping)),{code:'DUPLICATE_ATTEMPT'});
    handle.cancel();
  }
  const result=await handle.result; assert.equal(result.status,mode,result.error); assert.equal(result.cancellation,'confirmed');
  assert.equal(result.artifacts,undefined); assert.equal(await remaining(id),'');
});

test('killing the Node host cannot outlive the independent guest deadline',live,async t=>{
  const {dir}=await fixture(t);const childDir=join(dir,'owner');await mkdir(childDir,{mode:0o700});
  const url=new URL('../runtime/jobs.ts',import.meta.url).href;
  const child=spawn(process.execPath,['--input-type=module','-e',
    'import {CsvJobRunner} from '+JSON.stringify(url)+';const runner=new CsvJobRunner({dataDir:process.argv[1],timeoutMs:1500,onEvent:e=>{if(e.type==="process_started") console.log(e.attempt.containerId);}}); const request='+JSON.stringify({...job(''),script:undefined})+';const result=await runner.startAnalysis({...request,script:{name:"main.py",bytes:Buffer.from('+JSON.stringify(sleeping)+')}}).result; if (result.status==="failed") console.error(result.error);',childDir],{stdio:['ignore','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
  let diagnostic=''; child.stderr.on('data',chunk=>{diagnostic+=chunk;});
  const died=once(child,'exit'); const id=await Promise.race([once(child.stdout,'data').then(([bytes])=>String(bytes).trim()),died.then(()=>{throw new Error('host died before ready: '+diagnostic);})]);
  assert.match(id,/^[0-9a-f]{64}$/);assert.equal(await remaining(id),id);child.kill('SIGKILL');await died;
  const end=Date.now()+8000; while(await remaining(id)) {assert.ok(Date.now()<end,'auto-removal deadline exceeded');await delay(100);}
});
