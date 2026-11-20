import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { TaskManager } from '../runtime/manager.ts';

type Message={role:string;content:unknown;tool_call_id?:string};
type Wire={messages:Message[];tools:{function:{name:string}}[]};
type Call={name:string;args:object};
async function setup(t:TestContext,answer:(wire:Wire)=>Promise<string|Call>|string|Call){
  const directory=await mkdtemp(join(tmpdir(),'athena-m2-manager-'));
  const server=createServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
    const wire:Wire=JSON.parse(Buffer.concat(chunks).toString());
    const next=await answer(wire);
    res.writeHead(200,{'content-type':'text/event-stream'});
    const delta=typeof next==='string'?{role:'assistant',content:next}:{role:'assistant',tool_calls:[{index:0,
      id:'call_'+wire.messages.length,type:'function',function:{name:next.name,arguments:JSON.stringify(next.args)}}]};
    for(const [d,finish] of [[delta,null],[{},typeof next==='string'?'stop':'tool_calls']]){
      res.write('data: '+JSON.stringify({id:'completion',object:'chat.completion.chunk',created:1,model:'m2',choices:[{index:0,delta:d,finish_reason:finish}]})+'\n\n');
    }
    res.end('data: [DONE]\n\n');
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address && typeof address!=='string');
  const settings={ATHENA_ENDPOINT:'http://127.0.0.1:'+address.port+'/v1',ATHENA_MODEL:'m2',ATHENA_API_KEY:'',ATHENA_MODEL_CONCURRENCY:'1',ATHENA_MAX_CHILDREN:'2'};
  const restore=Object.entries(settings).map(([key,value])=>{const old=process.env[key];process.env[key]=value;return ()=>{if(old===undefined)delete process.env[key];else process.env[key]=old;};});
  const managers:TaskManager[]=[];
  t.after(async()=>{for(const manager of managers)await manager.close();restore.forEach(f=>f());server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(directory,{recursive:true,force:true});});
  return Object.assign(async()=>{const manager=new TaskManager({dataDir:directory});managers.push(manager);await manager.initialize();return manager;},{directory});
}
function finished(manager:TaskManager){
  const {promise,resolve}=Promise.withResolvers<void>();
  const unsubscribe=manager.subscribe(s=>{if(['succeeded','failed','cancelled','paused'].includes(s.run.status))resolve();});
  return promise.finally(unsubscribe);
}
function parent(w:Wire){return w.tools.some(t=>t.function.name==='spawn_agent');}
function outputs(w:Wire){return w.messages.filter(m=>m.role==='tool').map(m=>String(m.content));}

test('offline analysis joins source and both outputs with immutable input provenance after restart',
  {timeout:60000,skip:!process.env.ATHENA_ANALYSIS_IMAGE && 'Set ATHENA_ANALYSIS_IMAGE to a trusted local image to run the Docker integration.'}, async t=>{
  const script="from pathlib import Path\nimport sys,json\nx=int(Path('scores.csv').read_text().splitlines()[1])+int(sys.argv[1])\nPath('/outputs/result.json').write_text(json.dumps(x))\nPath('/outputs/note.txt').write_text('sum='+str(x))";
  let joined: {id:string;sha256:string;uri:string;name:string}[]=[];let checked='',diagnostic='';let conflicts:string[]=[];
  const launch=await setup(t,w=>{
    const r=outputs(w);
    if(parent(w)){
      if(!r.length)return {name:'spawn_agent',args:{title:'Writer',prompt:'Author a script.'}};
      if(r.length===1)return {name:'wait_for_agents',args:{}};
      if(r.length===2){const join=JSON.parse(r[1]??'');joined=join.tasks[0].artifacts;
        assert.deepEqual(join.inspect,[{name:'result.json',tool:'read_file',arguments:{artifactId:joined.find(f=>f.name==='result.json')?.id}}]);
        return {name:join.inspect[0].tool,args:join.inspect[0].arguments};}
      checked=r[2]??'';return 'Coordinator finished.';
    }
    if(!r.length)return {name:'write_file',args:{name:'analysis.py',content:script}};
    if(r.length===1){const receipt=JSON.parse(r[0]??'');assert.equal(receipt.execution,'not executed');assert.equal(receipt.published,false);
      return {name:'run_command',args:{language:'python',script:'analysis.py',inputs:['scores.csv'],outputs:['result.json','note.txt'],args:['5']}};}
    if(r.length===2)return {name:'write_file',args:{name:'fail.py',content:"import sys\nprint('out witness')\nprint('err witness',file=sys.stderr)\nsys.exit(7)"}};
    if(r.length===3)return {name:'run_command',args:{language:'python',script:'fail.py',inputs:[],outputs:[]}};
    if(r.length===4)return {name:'write_file',args:{name:'SCORES.csv',content:'shadow'}};
    if(r.length===5)return {name:'run_command',args:{language:'python',script:'analysis.py',inputs:[],outputs:['scores.csv']}};
    if(r.length===6)return {name:'run_command',args:{language:'python',script:'analysis.py',outputs:[]}};
    assert.match(r[6]??'',/inputs/i);diagnostic=r[3]??'';conflicts=r.slice(4,6);
    return 'Worker finished.';
  });
  let manager=await launch();const {project}=await manager.createProject({name:'Analysis'});
  const s=await manager.createSession({projectId:project.id,title:'Reports'});await manager.close();
  const previous=process.env.ATHENA_EXECUTION_PROJECTS;t.after(()=>{if(previous===undefined)delete process.env.ATHENA_EXECUTION_PROJECTS;else process.env.ATHENA_EXECUTION_PROJECTS=previous;});
  process.env.ATHENA_EXECUTION_PROJECTS=project.id;manager=await launch();
  const {fileReferences}=await manager.stageFiles(s.sessionId,[{name:'scores.csv',mimeType:'text/csv',data:Buffer.from('score\n32\n').toString('base64')}]);
  const end=finished(manager);await manager.pi(s.sessionId,{type:'prompt',id:'analyze',message:'Delegate.',fileReferences});await end;
  const snapshot=manager.getSnapshot(),proc=snapshot.processes[0];assert.ok(proc);assert.equal(proc.status,'succeeded',proc.job.error);
  const failed=snapshot.processes[1];assert.ok(failed);assert.equal(snapshot.processes.length,2,'Each command runs once.');
  assert.equal(conflicts.length,2);for(const error of conflicts)assert.match(error,/Granted upload .* is read-only/);
  assert.deepEqual(JSON.parse(diagnostic),{processId:failed.id,status:'failed',stdout:'out witness\n',stderr:'err witness\n',exitCode:7,error:failed.job.error});
  assert.equal(snapshot.tools.find(t=>t.id===failed.toolId)?.status,'failed');
  assert.deepEqual(joined.map(a=>a.name),['analysis.py','result.json','note.txt']);assert.equal(JSON.parse(checked).content,'37');
  await manager.close();manager=await launch();
  const restored=manager.getSnapshot();const expected=[script,'37','sum=37'];
  for(const [i,ref] of joined.entries()){
    const row=restored.artifacts.find(a=>a.id===ref.id);assert.ok(row);
    assert.deepEqual(row.evidence,[{id:fileReferences[0]?.id,version:fileReferences[0]?.versionId}]);
    assert.equal(row.toolId,proc.toolId);assert.equal(row.processId,proc.id);assert.equal(row.attemptId,proc.attemptId);assert.equal(row.location.uri,ref.uri);
    const {bytes}=await manager.artifactDownload(s.sessionId,row.id);assert.equal(bytes.toString(),expected[i]);assert.equal(createHash('sha256').update(bytes).digest('hex'),ref.sha256);
  }
});

test('grant transfer admits one sibling artifact only after explicit follow-up; parent reads verified bytes', {timeout:30000}, async t=>{
  const observed:string[]=[];
  let artifactId='', otherChild='';
  const launch=await setup(t,w=>{
    const results=outputs(w);
    if(parent(w)){
      switch(results.length){
        case 0:return {name:'spawn_agent',args:{title:'Producer',prompt:'Produce statistics.'}};
        case 1:return {name:'wait_for_agents',args:{}};
        case 2:artifactId=JSON.parse(results[1]??'').tasks[0].artifacts[0].id;return {name:'read_file',args:{artifactId}};
        case 3:observed.push(results[2]??'');return {name:'spawn_agent',args:{title:'Reviewer',prompt:'Inspect dataset.',fileIds:[]}};
        case 4:otherChild=JSON.parse(results[3]??'').taskId;return {name:'wait_for_agents',args:{}};
        case 5:return {name:'send_to_agent',args:{taskId:otherChild,message:'Now review the transferred result.',artifactIds:[artifactId]}};
        case 6:return {name:'wait_for_agents',args:{}};
        default:return 'Coordinator done.';
      }
    }
    const users=w.messages.filter(m=>m.role==='user');
    if(JSON.stringify(users[0]?.content).includes('Produce statistics.'))return results.length?'Produced.':{name:'calculate_csv',args:{}};
    if(users.length===1){
      if(results.length===0)return {name:'read_file',args:{artifactId}};
      if(results.length===1)return {name:'write_file',args:{name:'note.txt',content:'private draft'}};
      if(results.length===2)return {name:'read_file',args:{name:'note.txt'}};
      observed.push(...results);return 'Private review ready.';
    }
    if(results.length===3)return {name:'read_file',args:{artifactId}};
    observed.push(results.at(-1)??'');return 'Reviewed.';
  });
  let manager=await launch();const {project}=await manager.createProject({name:'Transfer'});
  const {sessionId}=await manager.createSession({projectId:project.id,title:'Review'});
  await manager.close();const saved=process.env.ATHENA_EXECUTION_PROJECTS;
  t.after(()=>{if(saved===undefined)delete process.env.ATHENA_EXECUTION_PROJECTS;else process.env.ATHENA_EXECUTION_PROJECTS=saved;});
  process.env.ATHENA_EXECUTION_PROJECTS=project.id;manager=await launch();
  const {fileReferences}=await manager.stageFiles(sessionId,[{name:'scores.csv',mimeType:'text/csv',data:Buffer.from('score\n43\n').toString('base64')}]);
  const end=finished(manager);await manager.pi(sessionId,{type:'prompt',id:'review',message:'Delegate.',fileReferences});await end;
  assert.equal(manager.getSnapshot().run.status,'succeeded');
  assert.match(observed[0]??'',/"content":/);assert.match(observed[1]??'',/outside the calling task grants/);
  assert.equal(observed[3],'private draft');assert.equal(JSON.parse(observed.at(-1)??'').statistics[0].mean,43);
  await manager.close();manager=await launch();
  assert.deepEqual(manager.getSnapshot().attempts.filter(a=>a.taskId===otherChild).map(a=>[a.fileIds,a.artifactGrants]),[[[],[]],[[],[artifactId]]]);
});

test('one slot drains a durable child mailbox; duplicate spawns reuse the task and ungranted staged files remain unreadable', {timeout:25000},async t=>{
  let foreign='',requests=0;const evidence:string[]=[];
  const launch=await setup(t,w=>{
    requests++;const results=outputs(w);
    if(parent(w)){
      const spawn={title:'Analyst',prompt:'Analyze input.',requestId:'same'};
      switch(results.length){
        case 0:case 1:return {name:'spawn_agent',args:spawn};
        case 2:return {name:'spawn_agent',args:{...spawn,title:'Conflicting request'}};
        case 3:case 4:return {name:'send_to_agent',args:{taskId:JSON.parse(results[0]??'{}').taskId,message:'Follow up.',requestId:'send-once'}};
        case 5:return {name:'wait_for_agents',args:{}};
        default:evidence.push(...results);return 'Coordinator completed.';
      }
    }
    if(w.messages.filter(m=>m.role==='user').length>1)return 'Follow-up processed.';
    switch(results.length){
      case 0:return {name:'read',args:{fileId:foreign}};
      case 1:return {name:'calculate_csv',args:{column:'score'}};
      default:evidence.push(...results);return 'Analysis completed.';
    }
  });
  let manager=await launch();const {project}=await manager.createProject({name:'Project'});
  const other=await manager.createSession({projectId:project.id,title:'Other'});
  const s=await manager.createSession({projectId:project.id,title:'Scores'});
  const stage=async(name:string,data:string)=>(await manager.stageFiles(s.sessionId,[{name,mimeType:'text/csv',data:Buffer.from(data).toString('base64')}])).fileReferences[0];
  const extra=await stage('secret.csv','Do not disclose 4705');assert.ok(extra);foreign=extra.id;
  const file=await stage('scores.csv','score\n7\n11\n');assert.ok(file);
  const complete=finished(manager);const cmd={type:'prompt',id:'root',message:'Delegate analysis.',fileReferences:[file]};
  await manager.pi(s.sessionId,cmd);await complete;
  const snapshot=manager.getSnapshot();assert.equal(snapshot.run.status,'succeeded');assert.equal(snapshot.tasks.length,2);
  const child=snapshot.tasks.find(t=>t.parentTaskId);assert.ok(child);assert.equal(child.result,'Follow-up processed.');
  assert.deepEqual(snapshot.attempts.filter(a=>a.taskId===child.id).map(a=>a.result),['Analysis completed.','Follow-up processed.']);
  assert.equal(snapshot.processes.length,1);const process=snapshot.processes[0];assert.ok(process);
  assert.equal(process.job.exitCode,0);assert.equal(process.taskId,child.id);assert.equal(process.job.grant?.fileId,file.id);
  assert.ok(child.toolIds.includes(process.toolId));assert.equal(process.agentSessionId,child.agentSessionId);
  assert.ok(evidence.some(v=>v.includes('explicitly granted')));assert.ok(evidence.some(v=>v.includes('different arguments')));
  assert.ok(evidence.some(v=>v.includes('"mean":9')));assert.ok(evidence.some(v=>v.includes('Follow-up processed.')));
  assert.ok(!JSON.stringify(evidence).includes('Do not disclose 4705'));
  assert.equal(child.artifactIds.length,1);const artifactId=child.artifactIds[0];assert.ok(artifactId);
  const uri='/api/artifacts/'+s.sessionId+'/'+artifactId;
  assert.equal(snapshot.artifacts[0]?.location.uri,uri);
  assert.ok(evidence.some(v=>v.includes(uri)&&v.includes('Follow-up processed.')));
  assert.deepEqual(snapshot.events.filter(e=>e.type.startsWith('process_') && e.type!=='process_output').map(e=>e.type),['process_queued','process_started','process_finished']);
  const history=await manager.getAgentHistory(s.sessionId,child.agentSessionId);assert.ok(JSON.stringify(history.messages).includes('Follow-up processed.'));
  const count=requests;await manager.close();manager=await launch();
  const download=await manager.artifactDownload(s.sessionId,artifactId);assert.equal(download.name,'statistics.json');assert.equal(JSON.parse(download.bytes.toString()).statistics[0].mean,9);
  assert.deepEqual(JSON.parse(JSON.stringify((await manager.getAgentHistory(s.sessionId,child.agentSessionId)).messages)),JSON.parse(JSON.stringify(history.messages)));
  await assert.rejects(manager.artifactDownload(other.sessionId,artifactId),{code:'ARTIFACT_DENIED'});
  await assert.rejects(manager.getAgentHistory(other.sessionId,child.agentSessionId),{code:'SESSION_MISMATCH'});
  await manager.pi(s.sessionId,cmd);assert.equal(requests,count);
});



test('switching conversations does not rebind a running child; cancelling it wakes the blocked parent', {timeout:20000},async t=>{
  const observed=Promise.withResolvers<void>(), release=Promise.withResolvers<void>();
  const joined:string[]=[];
  const launch=await setup(t,async w=>{
    if(parent(w)){
      const results=outputs(w);
      if(!results.length)return {name:'spawn_agent',args:{title:'Held child',prompt:'Wait for release.'}};
      if(results.length===1)return {name:'wait_for_agents',args:{}};
      joined.push(...results);return 'Reported cancellation.';
    }
    observed.resolve();await release.promise;return 'Late response.';
  });
  const manager=await launch();const {project}=await manager.createProject({name:'Project'});
  const other=await manager.createSession({projectId:project.id,title:'Empty'});
  const first=await manager.createSession({projectId:project.id,title:'Active'});
  await manager.pi(first.sessionId,{type:'prompt',id:'active',message:'Delegate.'});
  await observed.promise;
  const child=manager.getSnapshot().tasks.find(t=>t.parentTaskId);assert.ok(child);
  assert.equal(manager.getSnapshot().run.status,'blocked');
  try {
    await manager.openSession(other.sessionId);
    assert.deepEqual(manager.getSnapshot().tasks,[]);
    await assert.rejects(manager.cancelTask(child.id),{code:'TASK_SCOPE_MISMATCH'});
    await manager.openSession(first.sessionId);
    const complete=finished(manager);const result=await manager.cancelTask(child.id);
    assert.equal(result.status,'cancelled');await complete;
    assert.ok(joined.some(s=>s.includes('"status":"cancelled"')));
    assert.equal(manager.getSnapshot().run.status,'succeeded');
  }finally{release.resolve();}
});



test('host death after CSV admission interrupts the waiting parent, worker and queued send without redispatch', {timeout:25000},async t=>{
  let requests=0;
  const launch=await setup(t,w=>{
    requests++;
    if(!parent(w))return {name:'calculate_csv',args:{}};
    const results=outputs(w);
    if(!results.length)return {name:'spawn_agent',args:{title:'Worker',prompt:'Calculate.'}};
    if(results.length===1)return {name:'send_to_agent',args:{taskId:JSON.parse(results[0]??'{}').taskId,message:'Follow up.'}};
    return {name:'wait_for_agents',args:{}};
  });
  const script=[
    'import { TaskManager } from '+JSON.stringify(new URL('../runtime/manager.ts',import.meta.url).href),
    'const m=new TaskManager({dataDir:'+JSON.stringify(launch.directory)+'});await m.initialize()',
    "const {project}=await m.createProject({name:'Crash'});const s=await m.createSession({projectId:project.id,title:'Admission'})",
    "const {fileReferences}=await m.stageFiles(s.sessionId,[{name:'scores.csv',mimeType:'text/csv',data:'c2NvcmUKNwo='}])",
    "m.subscribe(snapshot=>{if(snapshot.processes?.some(p=>p.status==='queued'))process.kill(process.pid,'SIGKILL');})",
    "await m.pi(s.sessionId,{type:'prompt',id:'interrupted',message:'Delegate.',fileReferences})",
  ].join(';');
  const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','ignore','pipe']});
  let errors='';child.stderr.on('data',b=>{errors+=String(b);});
  t.after(()=>{if(child.exitCode===null && child.signalCode===null)child.kill('SIGKILL');});
  const [,signal]=await once(child,'exit');assert.equal(signal,'SIGKILL',errors);
  const before=requests;const manager=await launch();const s=manager.getSnapshot();
  assert.equal(s.run.status,'paused');assert.deepEqual(s.attempts.map(a=>a.status),['paused','paused','paused']);
  const [proc]=s.processes;assert.ok(proc);assert.equal(proc.status,'interrupted');assert.equal(proc.job.cancellation,'unknown');
  assert.equal(proc.job.exitCode,null);assert.equal(s.artifacts.length,0);assert.equal(requests,before);
});
