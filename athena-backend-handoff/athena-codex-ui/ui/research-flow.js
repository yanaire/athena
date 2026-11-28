// The host owns transitions. This panel only reads receipts and invokes explicit recovery.
window.AthenaResearchFlow={mount(root,options){
  const el=(tag,txt)=>{const e=document.createElement(tag);if(txt!==undefined)e.textContent=txt;return e;};
  const button=(txt,action)=>{const b=el('button',txt);b.type='button';b.onclick=action;return b;};
  let service,snapshot,scope='',selectedRun='',generation=0,timer,signature='',tab='progress',report,version,versionState='',hostRun='',requesting=false;
  const listeners=new AbortController();
  const body=root.querySelector('[data-flow-body]'),notice=root.querySelector('[data-flow-notice]');
  const call=(method,args={})=>service(method,{projectId:snapshot.projectId,sessionId:snapshot.sessionId,...args});
  function viewSignature(){
    const data=tab==='preview'&&report?[report.runId,report.history,report.sections,report.sources,report.version]:report;
    return JSON.stringify([data,version?.version,version?.compilation,version?.review,tab]);
  }
  function tableOrigin(r,table){
    const group=el('details'),summary=el('summary',table.count+' '+table.condition+' · result and inputs');
    group.append(summary);let loaded=false;
    group.ontoggle=async()=>{
      if(!group.open||loaded)return;loaded=true;
      const g=generation;
      try{
        const data=await call('researchTableInputs',{runId:r.runId,artifactId:table.artifactId,version:table.version});
        if(g!==generation||!group.isConnected)return;
        group.append(button(data.result.name,()=>options.open('artifacts',{artifactId:data.result.id,version:data.result.version})),
          button('Worker and program call',()=>options.open('workflow',{taskId:data.taskId})));
        for(const file of data.inputs){
          group.append(el('p',(file.name||file.id)+' · '+file.version));
          if(file.excerpt)group.append(el('pre',file.excerpt));
        }
      }catch(e){loaded=false;notice.textContent=e.message;}
    };
    return group;
  }
  function render(){
    signature=viewSignature();
    const opened=new Set([...body.querySelectorAll('details[open]')].map(d=>d.querySelector('summary')?.firstChild?.textContent));
    const frag=document.createDocumentFragment();
    const r=report;
    if(!r){if(snapshot?.run&&scope){frag.append(el('p','Loading recorded research stages…'));body.replaceChildren(frag);return;}frag.append(el('p','Send the topic, research question and LaTeX template in chat. Attach any research inputs.'));body.replaceChildren(frag);return;}
    if(r.history.length>1){
      const history=el('select');history.setAttribute('aria-label','Research request');
      for(const entry of r.history){const opt=el('option',entry.title);opt.value=entry.runId;history.append(opt);}
      history.value=r.runId;history.onchange=()=>{selectedRun=history.value;generation++;signature='';update();};frag.append(history);
    }
    if(tab==='progress'){
      const list=el('ol');list.className='ac-flow-stages';
      for(const stage of r.stages){
        const li=el('li'),details=el('details'),summary=el('summary'),title=el('strong',stage.title),status=el('span',stage.status);
        status.dataset.state=stage.status;summary.append(title,status);details.append(summary);
        if(stage.description)details.append(el('p',stage.description));
        if(stage.title==='Research plan' && r.plan){
          if(r.plan.coordinatorModel)details.append(el('p','Main coordinator · '+r.plan.coordinatorModel));
          const steps=el('ol'), criteria=el('ul');
          for(const step of r.plan.stages)steps.append(el('li',step));
          for(const criterion of r.plan.acceptanceCriteria)criteria.append(el('li',criterion));
          details.append(steps,el('strong','Acceptance criteria'),criteria);
        }
        if(stage.title==='Experiment' && r.experimentMission){
          const mission=r.experimentMission, c=mission.contract, trials=el('ol');
          const metric=c.metricPath.at(-1) || c.resultFile;
          const showValue=value=>String(Number(value.toPrecision(7)));
          details.append(el('p',metric+' '+(c.direction==='at_most'?'≤':'≥')+' '+c.target+' · '+c.maxTrials+' trials allowed'));
          if(mission.best)details.append(el('p','Best measured value: '+showValue(mission.best.value)+' (trial '+mission.best.trial+')'));
          for(const t of mission.trials){
            const row=el('li'), decision=t.decision;
            row.append(el('strong',decision?.parentTrial?'Based on trial '+decision.parentTrial:'Trial '+t.number));
            if(decision?.instruction)row.append(el('p',decision.instruction));
            if(decision)row.append(el('p',decision.reason));
            if(t.workerNote){
              const note=el('details');
              note.append(el('summary','Worker observation'),el('p',t.workerNote));
              row.append(note);
            }
            const planner=t.planners.at(-1);
            if(planner)row.append(button('Planner',()=>options.open('workflow',{taskId:planner.taskId})));
            if(t.outcome?.artifact){
              const {artifact,value}=t.outcome;
              row.append(button(metric+' = '+showValue(value),()=>options.open('artifacts',{artifactId:artifact.id,version:artifact.version})));
            }else if(t.outcome?.error){
              row.append(el('p',t.outcome.error));
              const candidate=t.outcome.candidate;
              if(candidate)row.append(button('Inspect result',()=>options.open('artifacts',{artifactId:candidate.id,version:candidate.version})));
            }
            trials.append(row);
          }
          details.append(trials);
        }
        if(stage.taskId)details.append(button('Worker, attempts and tools',()=>options.open('workflow',{taskId:stage.taskId})));
        li.append(details);list.append(li);
      }
      frag.append(list,button('Workflow graph',()=>options.open('workflow',{taskId:r.stages[0].taskId})));
      if(r.canResume)frag.append(button('Resume from saved checkpoint',()=>recover('resumeResearch',{runId:r.runId,expectedAttemptId:r.checkpoint})));
      if(r.error)frag.append(el('p',r.error));
      for(const art of r.artifacts){
        frag.append(button(art.name,()=>options.open('artifacts',{artifactId:art.id})));
        const measured=r.tables?.find(t=>t.artifactId===art.id&&t.version===art.version);
        const data=measured?{samples:measured.rows}:null;
        if(Array.isArray(data?.samples)&&data.samples.length&&data.samples.every(row=>row&&typeof row==='object'&&!Array.isArray(row))){
          const tbl=el('table'),keys=Object.keys(data.samples[0]).slice(0,5);
          const origin=tableOrigin(r,measured),caption=el('caption');caption.append(button((measured?.count??data.samples.length)+' '+(measured?.condition||'sampled conditions'),()=>{origin.open=true;origin.scrollIntoView({block:'nearest'});}));tbl.append(caption);
          const head=el('tr');keys.forEach(k=>head.append(el('th',k)));tbl.append(head);
          for(const row of data.samples.slice(0,12)){const tr=el('tr');keys.forEach(k=>tr.append(el('td',typeof row[k]==='number'?Number(row[k].toPrecision(6)):String(row[k]))));tbl.append(tr);}
          frag.append(tbl,origin);
          if(keys.length>=2){
            const values=data.samples.map(item=>item[keys[1]]).filter(Number.isFinite);
            if(values.length){
              const chart=el('div');chart.className='ac-flow-chart';chart.setAttribute('aria-label',keys[1]+' by sampled condition');
              const scale=Math.max(...values.map(Math.abs))||1,lo=Math.min(0,...values)/scale,hi=Math.max(0,...values)/scale;
              const span=hi-lo||1,baseline=100*hi/span;
              for(const v of values.slice(0,40)){
                const slot=el('span'),bar=el('i');slot.title=keys[1]+' '+v;
                const height=Math.abs(v/scale)/span*100;bar.style.height=Math.max(.8,height)+'%';
                bar.style.top=(v>0?baseline-height:baseline)+'%';slot.append(bar);chart.append(slot);
              }
              frag.append(chart);
            }
          }
        }
      }
      const tools=el('details');tools.append(el('summary','Connected experiment and browsing tools'));
      tools.append(el('p',r.connections.length?r.connections.map(s=>s.name+' · '+s.tools.join(', ')).join('\n'):'No external MCP connection. Browser Use page research and Computer Use GUI experiments require an enabled, verified server.'));
      for(const kind of ['browser','computer'])if(!r.connections.some(c=>c.capability===kind))tools.append(el('p',kind==='browser'?'Browser Use · no designated page-reading connection':'Computer Use · no designated GUI connection'));
      for(const c of r.connections)for(const job of c.calls)tools.append(el('p',c.name+' / '+job.tool+' · '+job.status));
      frag.append(tools);
    }else{
      if(version){
        frag.append(el('h3',version.title),el('p','Revision '+version.version.slice(0,8)+' · '+version.review.status));
        const c=version.compilation;
        if(c?.state==='succeeded'){
          for(const file of [c.tex,c.pdf]){const a=el('a',file.name);a.href=file.uri;a.download=file.name;frag.append(a,document.createTextNode('  '));}
          frag.append(button('Review JSON',async()=>{try{const receipt=await call('exportPaper',{documentId:r.documentId,version:version.version,format:'json'});const a=el('a');a.href=receipt.uri;a.download=receipt.name;a.click();}catch(e){notice.textContent=e.message;}}));
          for(const [n,page] of (c.pages||[]).entries()){const img=el('img');img.src=page.uri;img.alt='Compiled PDF page '+(n+1);img.className='ac-flow-page';frag.append(img);}
          if(c.previewError)frag.append(el('p',c.previewError));
        }else if(version.review.status==='approved'){
          frag.append(el('p',c?.error||'Waiting for LaTeX compilation.'),button('Typeset reviewed revision',()=>recover('compilePaper',{documentId:r.documentId,version:version.version})));
        }
        for(const table of r.tables||[]){if(r.sources?.some(s=>s.source?.id===table.artifactId&&s.source.version===table.version)){frag.append(tableOrigin(r,table));}}
        for(const src of r.sources||[]){if(src.source?.kind==='artifact')frag.append(button(src.quote+' · input and result',()=>options.open('workflow',{taskId:src.source.taskId})));}
        const sectionList=el('details');sectionList.append(el('summary','Section checks'));
        for(const section of r.sections||[]){
          const start=version.text.indexOf(section.heading);
          const next=start<0?-1:version.text.indexOf('\n## ',start+section.heading.length);
          const count=version.links.filter(l=>start>=0&&l.manuscriptOffset>=start&&(next<0||l.manuscriptOffset<next)&&l.sourceOffset>=0).length;
          sectionList.append(el('p',section.heading+' · draft saved · '+count+' linked passages · '+(version.review.status==='approved'?'in independently reviewed revision':version.review.status)));
        }
        frag.append(sectionList,button('Open manuscript editor',()=>options.editor(r.documentId).catch(e=>{notice.textContent=e.message;})));
        const draft=el('details');draft.append(el('summary','Saved manuscript'),el('pre',version.text));frag.append(draft);
      }else if(r.sections?.length){
        for(const s of r.sections)frag.append(el('h4',s.heading),el('p',s.text),el('small','Draft · awaiting review'));
      }else frag.append(el('p','No section has been saved yet.'));
    }
    for(const detail of frag.querySelectorAll('details'))detail.open=opened.has(detail.querySelector('summary')?.firstChild?.textContent);
    body.replaceChildren(frag);
  }
  async function recover(method,args){try{await call(method,args);signature='';await update();}catch(e){notice.textContent=e.message;}}
  async function update(){
    clearTimeout(timer);if(!scope||!service||requesting)return;
    const g=generation;requesting=true;
    try{
      const r=await call('researchFlow',selectedRun?{runId:selectedRun}:{});if(g!==generation)return;
      report=r;
      const revision=JSON.stringify([r?.version,r?.stages.slice(-2)]);
      if(version?.version!==r?.version)version=null;
      function refresh(){
        if(viewSignature()!==signature)render();
      }
      refresh();
      if(r?.version&&revision!==versionState){
        const saved=await call('getDocument',{documentId:r.documentId,version:r.version});
        if(g!==generation)return;
        version=saved;versionState=revision;refresh();
      }
      const stage=r?.stages.find(s=>s.status==='Running')||r?.stages.filter(s=>s.status==='Succeeded').at(-1);
      options.stage(stage?stage.title+' · '+stage.status:'');
      notice.textContent='';
    }catch(e){if(g===generation)notice.textContent=e.message;}
    finally{requesting=false;if(scope&&service)timer=setTimeout(update,g===generation?800:0);}
  }
  root.addEventListener('click',e=>{const b=e.target.closest('[data-flow-tab]');if(!b)return;tab=b.dataset.flowTab;
    root.querySelectorAll('[data-flow-tab]').forEach(btn=>btn.setAttribute('aria-pressed',String(btn===b)));render();},{signal:listeners.signal});
  return {attach(fn){service=fn;if(scope)update();},scope(s){snapshot=s;const next=s.projects?.find(p=>p.id===s.projectId)?.researchWorkflow&&s.sessionId||'';
    const run=(s.run?.id||'')+' '+(s.run?.status||'');
    if(scope===next){if(scope&&hostRun!==run){hostRun=run;if(!report)render();if(!requesting)update();}return;}
    hostRun=run;scope=next;selectedRun='';generation++;report=null;version=null;signature='';versionState='';root.hidden=!scope;clearTimeout(timer);notice.textContent='';options.stage('');render();if(scope)update();},
    destroy(){listeners.abort();generation++;scope='';clearTimeout(timer);}};
}};
