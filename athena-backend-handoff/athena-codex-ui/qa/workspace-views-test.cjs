'use strict';
// Deterministic DOM contracts only. No browser, backend, extraction, or PDF service is run.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const dependencyPaths=[__dirname,...(process.env.ATHENA_QA_DEPENDENCIES?[process.env.ATHENA_QA_DEPENDENCIES]:[])];
const {parseHTML}=require(require.resolve('linkedom',{paths:dependencyPaths}));
const base=path.resolve(__dirname,'..')+path.sep;
function env(overrides={},fetchFile,historyMessages=[{role:'assistant',content:'Measurements checked.'}]){
 const {window,document}=parseHTML('<html><body><div id="athena-codex"><div id="host"></div></div></body></html>');
 Object.defineProperty(window.HTMLElement.prototype,'open',{configurable:true,get(){return this.hasAttribute('open');},set(value){this.toggleAttribute('open',Boolean(value));}});
 Object.defineProperty(window.HTMLSelectElement.prototype,'value',{configurable:true,get(){return [...this.options].find(o=>o.hasAttribute('selected'))?.value||this.options[0]?.value||'';},set(value){for(const o of this.options)o.toggleAttribute('selected',o.value===String(value));}});
 let snapshot={mode:'runtime',projectId:'project-rc',sessionId:'session-a',taskManagerConnected:false,run:{status:'ready'},tasks:[],agents:[],tools:[],artifacts:[],events:[],approvals:[],capabilities:{},...overrides};
 let callback,nav=[],copied=[],retry=[],cancelTasks=[],historyCalls=[],cancelled=0;
 const store={getState:()=>snapshot,subscribe(fn){callback=fn;fn(snapshot);return()=>{callback=null}},retryTask:id=>retry.push(id),cancelTask:id=>cancelTasks.push(id),cancel:()=>cancelled++,async getAgentHistory(conversationId,agentSessionId){historyCalls.push([conversationId,agentSessionId]);return historyMessages;}};
 window.AthenaPiActivity={iconHTML:()=>'<svg></svg>',toolPresentation:()=>({icon:'terminal'})};
 if(fetchFile) window.fetch=fetchFile;
 const context={window,document,AbortController,URL,Date,Blob,setTimeout,clearTimeout,navigator:{clipboard:{writeText:async value=>copied.push(value)}}};
 vm.runInNewContext(fs.readFileSync(base+'ui/activity-labels.js','utf8'),context);
 vm.runInNewContext(fs.readFileSync(base+'ui/research-records.js','utf8'),context);
 const records=window.AthenaResearchRecords.create({projectId:'project-rc'});
 records.ensureDocument({documentId:'research-note',text:'Current document v1',title:'Current research',version:'1',originalSample:true,evidence:[{sourceId:'source-a',version:'1'}],review:{status:'approved',version:'1'}});
 vm.runInNewContext(fs.readFileSync(base+'ui/result-files.js','utf8'),context);
 vm.runInNewContext(fs.readFileSync(base+'ui/workspace-views.js','utf8'),context);
 const host=document.querySelector('#host'),api=window.AthenaWorkspaceViews.mount(host,{store,records,onNavigate:(view,selection)=>nav.push({view,...selection})});
 const q=selector=>host.querySelector(selector),fire=(node,type)=>node.dispatchEvent(new window.Event(type,{bubbles:true,cancelable:true}));
 return{api,records,q,host,nav,copied,retry,cancelTasks,historyCalls,get cancelled(){return cancelled},put(data){snapshot={...snapshot,...data};callback(snapshot)},click(selector){const node=q(selector);assert.ok(node,selector);fire(node,'click')},change(selector,value){const node=q(selector);node.value=value;fire(node,'change')},destroy(){api.destroy();records.destroy()}};
}
// DOM visibility contract only: closed details expose their summary, never their body.
function displayedText(root){
 if(root.nodeType===3)return root.textContent;
 if(root.nodeType!==1||root.hasAttribute('hidden'))return '';
 const own=[root.getAttribute('aria-label'),root.getAttribute('title')].filter(Boolean).join(' ');
 const children=root.localName==='details'&&!root.hasAttribute('open')?[root.querySelector('summary')].filter(Boolean):[...root.childNodes];
 return own+' '+children.map(displayedText).join(' ');
}
function hidesIds(root,ids){const text=displayedText(root);for(const id of ids)assert.equal(text.includes(id),false,'Visible text must not include '+id);}
test('agent history keeps raw tool results in closed diagnostics while preserving user and assistant messages',async()=>{
 const taskId='task-1',agentSessionId='agent-session-history',toolCallId='tool-call-history';
 const user='Keep task-1 as written <b>not markup</b>.';
 const assistant='The value for task-1 is 17.';
 const raw=JSON.stringify({taskId,attemptId:'attempt-1',result:17});
 const messages=[{role:'user',content:user},{role:'assistant',content:[{type:'text',text:assistant}]},{role:'toolResult',toolName:'get_task',toolCallId,content:[{type:'text',text:raw}]}];
 const e=env({taskManagerConnected:true,tasks:[{id:taskId,title:'Inspect measurements',status:'succeeded'}],agents:[{id:'agent-history',name:'Research agent',taskId,agentSessionId,status:'succeeded'}],capabilities:{agentHistory:true}},undefined,messages);
 try{
  e.api.open('timeline',{agentSessionId});await new Promise(resolve=>setImmediate(resolve));
  const rows=[...e.q('[data-awv-agent-messages]').children];assert.equal(rows.length,3);
  assert.equal(rows[0].querySelector('.awv-record-text').textContent,user);
  assert.equal(rows[1].querySelector('.awv-record-text').textContent,assistant);
  assert.equal(rows[0].querySelector('b'),null);
  const details=rows[2].querySelector('[data-aw-diagnostics]');
  assert.ok(details);assert.equal(details.open,false);
  assert.equal(displayedText(rows[2]).includes(taskId),false);
  assert.equal(displayedText(rows[2]).includes(toolCallId),false);
  assert.ok(details.textContent.includes(toolCallId));
  assert.equal([...details.querySelectorAll('dd')].at(-1).textContent,raw);
  details.open=true;
  assert.ok(displayedText(rows[2]).includes(taskId)&&displayedText(rows[2]).includes('attempt-1'),'The preserved tool payload becomes visible after explicit expansion.');
 }finally{e.destroy();}
});
test('Pi-only runtime exposes no tasks or sample artifacts, even for a requested sample ID',()=>{
 const e=env();assert.match(e.host.textContent,/TaskManager not connected/);assert.equal(e.q('[data-awv-task]'),null);
 e.api.open('artifacts');assert.match(e.host.textContent,/No artifacts reported/);assert.equal(e.q('[data-awv-chart]'),null);
 e.api.open('artifacts',{artifactId:'response-plot',version:'1'});assert.match(e.host.textContent,/Artifact version unavailable/);assert.equal(e.q('[data-awv-chart]'),null);e.destroy();
});
test('runtime artifact identity and version never fall back to static example content',async()=>{
 const body='Runtime <script>not executable</script>\n'+'complete text '.repeat(23000);
 const e=env({taskManagerConnected:true,artifacts:[{id:'response-plot',title:'Measured data',kind:'plot',version:'host-2',taskId:'task-real',text:body,evidence:[{id:'source-real',version:'v7'}]},{id:'binary',version:'8',kind:'pdf',location:{uri:'javascript:alert(1)'}}]});
 e.api.open('artifacts',{artifactId:'response-plot',version:'host-2'});assert.equal(e.q('.awv-record-text').textContent,body);assert.equal(e.q('[data-awv-chart]'),null);assert.equal(e.q('script'),null);assert.match(e.q('.awv-record-evidence').textContent,/source-real · vv7/);
 e.click('[data-awv-action="copy-artifact"]');await Promise.resolve();assert.equal(e.copied[0],body);
 e.api.open('artifacts',{artifactId:'response-plot',version:'host-1'});assert.match(e.host.textContent,/Artifact version unavailable/);assert.equal(e.q('.awv-record-text'),null);
 e.api.open('artifacts',{artifactId:'binary',version:'8'});assert.match(e.host.textContent,/no text preview/);assert.equal(e.q('a'),null);
 e.put({mode:'preview',sessionId:null});e.api.open('artifacts',{artifactId:'response-plot'});assert.ok(e.q('[data-awv-chart]'));e.put({mode:'runtime',sessionId:'session-b',artifacts:[]});assert.equal(e.q('[data-awv-chart]'),null);assert.equal(e.q('.awv-record-text'),null);e.destroy();
});
test('runtime workflow uses exact tool/artifact IDs and only shows authorized mutation controls; unknown progress stays unknown',()=>{
 const e=env({taskManagerConnected:true,run:{status:'running'},tasks:[{id:'task-real',title:'Analyze actual input',status:'failed',dependencies:[]}],tools:[{id:'tool-real-7',name:'read',taskId:'task-real'}],artifacts:[{id:'result-a',title:'Output',kind:'text',version:'server-5',taskId:'task-real',text:'Output'}]});
 assert.match(e.host.textContent,/Progress not reported/);assert.equal(e.q('[role="progressbar"]'),null);assert.equal(e.q('[data-awv-retry]'),null);assert.equal(e.q('[data-awv-action="cancel-run"]'),null);
 e.click('[data-awv-open-tool]');assert.deepEqual(e.nav.pop(),{view:'execution',toolId:'tool-real-7',taskId:'task-real'});
 e.click('[data-awv-open-artifact]');assert.deepEqual(e.nav.pop(),{view:'artifacts',artifactId:'result-a',version:'server-5'});
 e.put({capabilities:{retryTask:true,cancelRun:true}});e.click('[data-awv-retry]');e.click('[data-awv-action="cancel-run"]');assert.deepEqual(e.retry,['task-real']);assert.equal(e.cancelled,1);e.destroy();
});
test('canonical document is revision-bound; original sample PDF remains a separate explicit reference',()=>{
 const e=env({mode:'preview'});e.api.open('artifacts',{artifactId:'research-note'});assert.equal(e.q('.awv-record-text').textContent,'Current document v1');assert.equal(e.q('[data-awv-action="export-record-pdf"]').disabled,true);assert.equal(e.q('.awv-paper'),null);
 e.records.updateDraft('research-note','Edited complete document');const revision=e.records.commitDraft('research-note');assert.equal(e.q('.awv-record-text').textContent,'Edited complete document');assert.match(e.q('.awv-record-review').textContent,/unreviewed/);
 e.click('[data-awv-action="open-manuscript"]');assert.deepEqual(e.nav.pop(),{view:'manuscript',documentId:'research-note',version:revision.version});
 e.change('[data-awv-document-version]','1');assert.equal(e.q('.awv-record-text').textContent,'Current document v1');assert.match(e.q('.awv-record-review').textContent,/approved/);
 e.click('[data-awv-action="original-reference"]');assert.match(e.q('[data-awv-original-reference]').textContent,/Immutable authored reference/);assert.ok(e.q('.awv-paper'));e.change('[data-awv-page-select]','3');assert.match(e.q('.awv-paper').textContent,/Traceable local evidence/);
 e.click('[data-awv-action="note-mode"][data-awv-value="pdf"]');assert.match(e.q('object').getAttribute('data'),/sample-research-note.pdf/);assert.equal(e.q('.awv-record-text').textContent,'Current document v1');e.destroy();
});
test('runtime document binding requires an actual host revision instead of reusing the preview record',()=>{
 const e=env({taskManagerConnected:true,artifacts:[{id:'research-note',version:'artifact-2',documentId:'research-note',documentVersion:'1',text:'Runtime content, not a preview substitution'}]});
 e.api.open('artifacts',{artifactId:'research-note',version:'artifact-2'});assert.equal(e.q('.awv-record-text').textContent,'Runtime content, not a preview substitution');assert.equal(e.q('[data-awv-action="original-reference"]'),null);
 e.records.acceptDocument({projectId:'project-rc',documentId:'actual-note',version:'host-3',title:'Host document',text:'Exact host revision',evidence:[{sourceId:'source-host',version:'v5'}],review:{status:'approved',version:'old'}});
 e.put({artifacts:[{id:'live-note',version:'artifact-3',documentId:'actual-note',documentVersion:'host-3',text:'Optional artifact text'}]});e.api.open('artifacts',{artifactId:'live-note',version:'artifact-3'});
 assert.equal(e.q('.awv-record-text').textContent,'Exact host revision');assert.equal(e.q('[data-awv-document-version]').disabled,true);assert.match(e.q('.awv-record-review').textContent,/unreviewed/);assert.equal(e.q('[data-awv-action="original-reference"]'),null);
 e.click('[data-awv-action="open-manuscript"]');assert.deepEqual(e.nav.pop(),{view:'manuscript',documentId:'actual-note',version:'host-3'});e.destroy();
});

test('measurement board follows the process and reads the published artifact URL',async()=>{
 const process={id:'proc',runId:'run',taskId:'child',status:'running',job:{mcp:{tool:'calculate_csv',phase:'tools/list'}}};
 const artifact={id:'file',title:'statistics.json',sessionId:'session-a',processId:'proc',taskId:'child',version:'v1',location:{uri:'/api/artifacts/session-a/file'}};
 const reads=[];
 const e=env({run:{id:'run',status:'running'},processes:[process],tasks:[{id:'child',title:'Voltage',status:'running'}]},async url=>{
   reads.push(url);
   return {ok:true,json:async()=>({schemaVersion:1,rowCount:5,statistics:[{column:'measurement_mV',count:4,missing:1,nonNumeric:0,min:7,mean:19,max:35}]})};
 });
 for(const [status,label] of [['running','Running'],['failed','Failed'],['cancelled','Cancelled']]){
   e.put({processes:[{...process,status}]});
   assert.match(e.q('[data-awv-measurements]').textContent,new RegExp('MCP · calculate_csv · tools/list'+label));
   assert.equal(e.q('[data-awv-measurements] [data-awv-open-artifact]'),null);
 }
 e.put({processes:[{...process,status:'succeeded',job:{mcp:{tool:'calculate_csv',phase:'tools/call'},artifact:{id:'file'}}}],artifacts:[artifact]});
 e.api.open('artifacts',{artifactId:'file',version:'v1'});
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(reads,['/api/artifacts/session-a/file']);
 assert.equal(e.q('a[download]').getAttribute('href'),reads[0]);
 assert.deepEqual([...e.q('tbody tr').children].map(cell=>cell.textContent),['measurement_mV','4','1','0','7','19','35']);
 e.destroy();
});

test('workflow and agent history show readable labels while exact identities remain actionable and inspectable',async()=>{
 const ids={session:'session-64d5ca16-f3a1-4614-a978-5dd190c2497d',run:'run-b5be9b03-aaef-49f7-9abb-2dc48bd0fa69',parent:'task-cc79e35f-d758-4bb8-b6ba-c487802e984f',child:'task-a066f560-148a-4752-96ed-049f8a58f151',missing:'task-419e8937-d0fd-4f11-afbf-cb852f12f2e6',first:'attempt-da59a44e-6ac1-4c14-bbe6-408d033b9232',second:'attempt-7e59e728-098c-4056-bac6-392c2968fec6',agent:'agent-0f89d694-9da5-45b3-b5d0-95c6ddaa027d',agentSession:'agent-session-3e602831-18e5-414b-af12-1ac5f8af67f8',otherTask:'task-f1bbc0e5-7eba-4fab-9f9e-25397fdf79c9',otherAgent:'agent-92cbf0d6-0e6c-4dfa-b18c-f14fc57775a7',otherSession:'agent-session-d970eb1d-6e6f-4715-a8da-2a5e1ee60c60'};
 const tasks=[{id:ids.parent,title:'Plan the study',status:'succeeded',dependencies:[]},{id:ids.child,title:'Analyze measurements',parentTaskId:ids.parent,attemptId:ids.second,agentSessionId:ids.agentSession,status:'running',dependencies:[ids.parent,ids.missing]},{id:ids.otherTask,title:'',status:'running',dependencies:[]}];
 const agents=[{id:ids.agent,name:ids.agent,role:'analyst',taskId:ids.child,agentSessionId:ids.agentSession,attemptId:ids.second,status:'running'},{id:ids.otherAgent,role:'reviewer',taskId:ids.otherTask,agentSessionId:ids.otherSession,status:'running'}];
 const attempts=[{id:ids.first,taskId:ids.child,status:'failed'},{id:ids.second,taskId:ids.child,status:'running',agentSessionId:ids.agentSession}];
 const e=env({revision:1,taskManagerConnected:true,sessionId:ids.session,sessions:[{id:ids.session,title:'Voltage study'}],run:{id:ids.run,status:'running'},tasks,agents,attempts,capabilities:{cancelTask:true,retryTask:true,cancelRun:true,agentHistory:true}});
 try{
  e.api.open('workflow',{taskId:ids.child});
  hidesIds(e.host,Object.values(ids));
  assert.match(displayedText(e.host),/Analyze measurements/);
  assert.match(displayedText(e.host),/Plan the study/);
  assert.match(displayedText(e.host),/Attempt 1/);
  assert.match(displayedText(e.host),/Attempt 2/);
  const diagnostics=[...e.host.querySelectorAll('[data-aw-diagnostics]')];
  assert.ok(diagnostics.length,'Technical details remain available.');
  assert.ok(diagnostics.every(node=>!node.hasAttribute('open')),'Diagnostics start closed.');
  for(const id of [ids.child,ids.first,ids.second,ids.agentSession])assert.ok(diagnostics.some(node=>node.textContent.includes(id)),'Diagnostics preserve '+id);
  e.click('[data-awv-cancel-task]');assert.deepEqual(e.cancelTasks,[ids.child]);
  e.click('[data-awv-open-agent]');assert.deepEqual(e.nav.pop(),{view:'timeline',agentSessionId:ids.agentSession,taskId:ids.child});
  e.put({revision:2,tasks:tasks.map(task=>task.id===ids.child?{...task,title:ids.child,status:'failed'}:task)});
  hidesIds(e.host,Object.values(ids));
  assert.ok(e.q('[data-awv-detail-heading]').textContent.trim(),'An untitled task still has a visible label.');
  e.click('[data-awv-retry]');assert.deepEqual(e.retry,[ids.child]);
  e.click('[data-awv-action="workflow-mode"][data-awv-value="graph"]');hidesIds(e.host,Object.values(ids));
  e.api.open('timeline',{agentSessionId:ids.agentSession});
  await new Promise(resolve=>setImmediate(resolve));
  hidesIds(e.host,Object.values(ids));
  assert.deepEqual(e.historyCalls.at(-1),[ids.session,ids.agentSession]);
  assert.equal(e.q('[data-awv-agent-select]').value,ids.agentSession);
  assert.match(e.q('[data-awv-agent-messages]').textContent,/Measurements checked\./);
  e.change('[data-awv-agent-select]',ids.otherSession);await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(e.historyCalls.at(-1),[ids.session,ids.otherSession]);hidesIds(e.host,Object.values(ids));
  e.change('[data-awv-agent-select]',ids.agentSession);await new Promise(resolve=>setImmediate(resolve));
  const selectionBefore=e.q('[data-awv-agent-select]').value;
  e.put({revision:3,hydration:2});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(e.q('[data-awv-agent-select]').value,selectionBefore);
  assert.deepEqual(e.historyCalls.at(-1),[ids.session,ids.agentSession]);
  hidesIds(e.host,Object.values(ids));
  const agentDetails=e.q('[data-awv-agent-work] [data-aw-diagnostics]');
  const diagnosticKey=agentDetails.dataset.awDiagnostics;agentDetails.open=true;
  e.put({revision:4});await new Promise(resolve=>setImmediate(resolve));
  assert.equal([...e.host.querySelectorAll('[data-aw-diagnostics]')].find(node=>node.dataset.awDiagnostics===diagnosticKey).open,true,'Chosen diagnostics stay expanded during same-session updates.');
  e.put({sessionId:'session-another',revision:1});await new Promise(resolve=>setImmediate(resolve));
  assert.ok([...e.host.querySelectorAll('[data-aw-diagnostics]')].every(node=>!node.open),'Another conversation starts with diagnostics closed.');
 }finally{e.destroy();}
});
