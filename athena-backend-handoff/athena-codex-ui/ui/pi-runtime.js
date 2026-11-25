/* Athena's Pi control bridge. All effects go through an explicitly attached host.
 * Official Pi 1.5.2 RPC contract + capability-gated native SDK operations.
 * No transport is opened, credentials stored, tools run, or session created here.
 */
(() => {
  'use strict';
  const RPC = Object.freeze(['prompt','steer','follow_up','abort','clear_queue','new_session','get_state','set_model','cycle_model','get_available_models','set_thinking_level','cycle_thinking_level','get_available_thinking_levels','set_steering_mode','set_follow_up_mode','compact','set_auto_compaction','set_auto_retry','abort_retry','bash','abort_bash','get_session_stats','export_html','switch_session','fork','clone','get_fork_messages','get_entries','get_tree','get_last_assistant_text','set_session_name','get_messages','get_commands']);
  const NATIVE = Object.freeze(['get_tools','set_active_tools','list_sessions','get_context_usage','navigate_tree','reload','get_resources','import_session','set_session_label','export_jsonl','abort_compaction','abort_branch_summary','get_system_prompt','get_scoped_models','set_scoped_models','get_cache_warming','set_cache_warming','get_settings']);
  const DIRECT = Object.freeze({prompt:'prompt',steer:'steer',follow_up:'followUp',abort:'abort',clear_queue:'clearQueue',set_model:'setModel',cycle_model:'cycleModel',set_thinking_level:'setThinkingLevel',cycle_thinking_level:'cycleThinkingLevel',get_available_thinking_levels:'getAvailableThinkingLevels',set_steering_mode:'setSteeringMode',set_follow_up_mode:'setFollowUpMode',compact:'compact',set_auto_compaction:'setAutoCompactionEnabled',set_auto_retry:'setAutoRetryEnabled',abort_retry:'abortRetry',bash:'executeBash',abort_bash:'abortBash',get_session_stats:'getSessionStats',export_html:'exportToHtml',get_fork_messages:'getUserMessagesForForking',get_last_assistant_text:'getLastAssistantText',set_session_name:'setSessionName',get_tools:'getAllTools',set_active_tools:'setActiveToolsByName',get_context_usage:'getContextUsage',navigate_tree:'navigateTree',reload:'reload',export_jsonl:'exportToJsonl',abort_compaction:'abortCompaction',abort_branch_summary:'abortBranchSummary'});
  const TERMINAL = new Set(['abort','abort_retry','abort_bash','abort_compaction','abort_branch_summary','stop_all']);
  const SESSION_CHANGE = new Set(['new_session','switch_session','fork','clone','import_session','navigate_tree']);
  const MODEL_CHANGE = new Set(['set_model','cycle_model']);
  const MODEL_CONTROL = new Set(['set_model','cycle_model','set_thinking_level','cycle_thinking_level']);
  const DIALOGS = new Set(['select','confirm','input','editor']);
  const DEFAULT_MESSAGE_LIMIT = 262144;
  const OMIT = new Set(['apiKey','api_key','authorization','Authorization','headers','credentials','accessToken','refreshToken','thinkingSignature']);
  const list = value => Array.isArray(value) ? value : [];
  const string = (value, max = 32000) => value == null ? '' : String(value).slice(0, max);
  const clone = value => JSON.parse(JSON.stringify(value));
  function safe(value, depth = 0, seen = new WeakSet()) {
    if (depth > 9) return '[Nested data]';
    if (typeof value === 'string') return value;
    if (value == null || typeof value === 'number' || typeof value === 'boolean') return value ?? null;
    if (typeof value !== 'object') return undefined;
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    if (value.type === 'thinking') return { type: 'thinking', hidden: true };
    if (value.type === 'image') return { type: 'image', mimeType: value.mimeType, omitted: true };
    if (Array.isArray(value)) return value.slice(-250).map(item => safe(item, depth + 1, seen));
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 150)) {
      if (OMIT.has(key) || ['__proto__','constructor','prototype'].includes(key)) continue;
      const next = safe(item, depth + 1, seen);
      if (next !== undefined) out[key] = next;
    }
    return out;
  }
  const field = (name,label,type='text',extra={}) => ({name,label,type,...extra});
  const text = (name,label,extra={}) => field(name,label,'text',extra);
  const area = (name,label,extra={}) => field(name,label,'textarea',extra);
  const check = (name,label,value=false) => field(name,label,'checkbox',{value});
  const select = (name,label,options,value) => field(name,label,'select',{options:options.map(v=>typeof v==='string'?{value:v,label:v}:v),value});
  const action = (id,group,title,description,icon,fields=[],submitLabel) => ({id,group,title,description,icon,fields,submitLabel:submitLabel||title});
  function initial() {
    return {revision:0,connected:false,mode:'disconnected',connectionLabel:'No Pi connection',busy:[],error:null,session:{},model:null,models:[],thinkingLevel:null,thinkingLevels:[],thinkingLevelsPending:false,tools:[],activeTools:[],queues:{steering:[],followUp:[],steeringMode:'one-at-a-time',followUpMode:'one-at-a-time'},stats:{},context:{},config:{autoCompaction:null,autoRetry:null},resources:{commands:[],skills:[],prompts:[],extensions:[],themes:[],contextFiles:[],diagnostics:[]},messages:[],historyRevision:0,entries:[],tree:[],forkMessages:[],sessions:[],ui:{requests:[],pendingRequestCount:0,notifications:[],statuses:[],widgets:[],editorText:'',title:''},capabilities:{},lastResult:null,clearedQueue:null,retry:null,compaction:null,settings:{},scopedModels:[],cacheWarming:null,systemPrompt:''};
  }
  function create(options = {}) {
    const requestPrefix=window.crypto.randomUUID();
    let state=initial(),target=null,mode='disconnected',epoch=0,sessionEpoch=0,sequence=0,unsubscribe=null,destroyed=false,refreshing=null,refreshTimer=0;
    let modelRevision=0,thinkingRevision=0,messagesRevision=0,scheduledFullRefresh=false,queuedFullRefresh=false;
    const listeners=new Set(),eventListeners=new Set(),pending=new Map(),dialogTimers=new Map(),busy=new Map(),uiPending=new Map();
    let declared=null,attachOptions={},facade=null;
    function getState(){return clone(state)}
    function syncUIRequests(){state.ui.requests=[...uiPending.values()].map(record=>({...record.request,detached:record.connection!==target||record.epoch!==epoch||record.sessionEpoch!==sessionEpoch,responding:record.responding,responseError:record.responseError||null}));state.ui.pendingRequestCount=uiPending.size;}
    function publish(){if(destroyed)return;syncUIRequests();state.revision++;state.busy=[...busy.keys()];state.capabilities=Object.fromEntries([...RPC,...NATIVE,'stop_all','invoke_command'].map(id=>[id,capability(id)]));const snapshot=getState();for(const fn of listeners){try{fn(snapshot)}catch(e){options.onError?.(e)}}}
    function capability(id){
      if(!target)return {available:false,reason:'Connect a Pi runtime to use this action.'};
      if(id==='stop_all')return {available:available('abort')&&available('clear_queue'),reason:'Requires abort and queue control.'};
      if(id==='invoke_command')return capability('prompt');
      if(declared&&!declared.has(id))return {available:false,reason:'This connection does not expose this capability.'};
      if(mode==='rpc'||mode==='host')return {available:declared?declared.has(id):RPC.includes(id),reason:NATIVE.includes(id)?'Requires the native Pi host adapter.':''};
      let ok=false;
      if(id==='bash')return {available:false,reason:'Use the Pi host adapter so extension shell hooks are respected.'};
      if(id==='get_state')ok=true;
      else if(id==='get_messages')ok=Array.isArray(target.messages);
      else if(id==='get_available_models')ok=typeof target.modelRuntime?.getAvailableSnapshot==='function';
      else if(id==='get_entries')ok=typeof target.sessionManager?.getEntries==='function';
      else if(id==='get_tree')ok=typeof target.sessionManager?.getTree==='function';
      else if(id==='get_system_prompt')ok=typeof target.systemPrompt==='string';
      else if(DIRECT[id])ok=typeof target[DIRECT[id]]==='function';
      return {available:ok,reason:ok?'':'Requires the native Pi host adapter or this SDK method.'};
    }
    const available=id=>capability(id).available;
    function getInputContract(){const configured=target?.inputContract?.maxMessageCharacters??attachOptions.maxMessageCharacters,files=(mode==='rpc'||mode==='host')&&target?.supportsFileReferences===true;return {maxMessageCharacters:Number.isSafeInteger(configured)&&configured>0?configured:DEFAULT_MESSAGE_LIMIT,lengthUnit:'utf16-code-units',supportsFileReferences:Boolean(files),canStageFiles:Boolean(files&&typeof target?.stageFiles==='function')};}
    function validateMessage(value){if(value!=null&&typeof value!=='string')throw new TypeError('Message must be text.');const message=value??'',limit=getInputContract().maxMessageCharacters;if(message.length>limit){const error=new RangeError('The message contains '+message.length.toLocaleString()+' characters and exceeds this connection’s '+limit.toLocaleString()+' character limit. Nothing was sent. Keep the full draft, or attach content through a supported file reference.');error.code='INPUT_TOO_LARGE';error.limit=limit;error.actual=message.length;throw error;}return message;}
    function fileReferences(value){if(value===undefined)return undefined;if(!Array.isArray(value))throw new TypeError('File references must be an array.');if(value.length&&!getInputContract().supportsFileReferences){const error=new Error('This connection does not accept file references. Keep the attachments until a file service is connected.');error.code='FILES_UNSUPPORTED';throw error;}return value.map(ref=>{if(!ref||typeof ref.id!=='string'||!ref.id||typeof ref.name!=='string'||typeof ref.mimeType!=='string'||!Number.isSafeInteger(ref.size)||ref.size<0||ref.projectId!==null&&typeof ref.projectId!=='string'||ref.versionId!=null&&typeof ref.versionId!=='string')throw new TypeError('The file service returned an invalid file reference.');return {id:ref.id,projectId:ref.projectId,name:ref.name,mimeType:ref.mimeType,size:ref.size,...(ref.versionId==null?{}:{versionId:ref.versionId})};});}
    async function stageFiles(files,context={}){const connection=target,bound=epoch,sessionBound=sessionEpoch;if(!getInputContract().canStageFiles)throw new Error('File storage is not connected. Your attachments are still in the draft.');if(!Array.isArray(files)||!files.length)throw new TypeError('Choose files to stage.');const result=await connection.stageFiles(files,context);if(bound!==epoch||sessionBound!==sessionEpoch||connection!==target)throw new Error('The active Pi session changed while files were being stored. Nothing was sent.');const refs=fileReferences(result?.fileReferences);if(!refs||refs.length!==files.length)throw new Error('The file service did not confirm every attachment. Nothing was sent.');return {fileReferences:refs};}
    function removeUIRequest(key){clearTimeout(dialogTimers.get(key));dialogTimers.delete(key);uiPending.delete(key);}
    function cancelPendingUI(reason){for(const record of [...uiPending.values()]){if(record.connection!==target||record.epoch!==epoch)continue;record.request.cancelReason=reason;respondUI(record.request.requestKey,{cancelled:true}).catch(()=>{});}}
    const modelChanging=()=>[...MODEL_CHANGE].some(id=>busy.has(id));
    const modelKey=model=>model?string(model.provider)+'\u241f'+string(model.id):'';
    function invalidateThinkingLevels(){state.thinkingLevels=[];state.thinkingLevelsPending=available('get_available_thinking_levels');}
    function getCatalog(){
      const models=state.models.map(m=>({value:m.provider+'\u241f'+m.id,label:(m.name||m.id)+' · '+m.provider}));
      const modelKey=state.model?state.model.provider+'\u241f'+state.model.id:'';
      const entries=state.forkMessages.map(m=>({value:m.entryId,label:string(m.text,100)||m.entryId}));
      const c=[
        action('get_state','session','Refresh session','Read the active conversation and runtime state.','refresh-cw'),
        action('new_session','session','New session','Start a conversation while preserving the current session.','square-pen',[text('parentSession','Parent session path',{hint:'Optional: link the new conversation to an existing session.'})],'Create session'),
        action('list_sessions','session','Browse sessions','List saved conversations from the connected host.','folder-open',[check('all','Include all working directories')],'Load sessions'),
        action('switch_session','session','Open session','Load a saved conversation using its exact host path.','folder-open',[text('sessionPath','Session path',{required:true,placeholder:'/path/to/session.jsonl'})]),
        action('set_session_name','session','Rename session','Give this conversation a recognizable name.','pencil',[text('name','Name',{required:true,value:state.session.sessionName||state.session.name||''})],'Save name'),
        action('get_fork_messages','session','Branch points','Read user messages available as branch points.','git-branch'),
        action('fork','session','Fork conversation','Create a new session from a selected user message.','git-fork',[entries.length?select('entryId','Branch from',entries,entries[0]?.value):text('entryId','Message entry ID',{required:true})],'Create branch'),
        action('clone','session','Clone conversation','Copy the current branch into a new session.','copy'),
        action('get_tree','session','Conversation tree','Inspect all preserved branches and the active leaf.','git-branch'),
        action('navigate_tree','session','Switch branch','Change the active leaf without deleting another branch.','git-compare-arrows',[text('targetId','Target entry ID',{required:true}),check('summarize','Summarize the branch being left'),area('customInstructions','Summary instructions'),check('replaceInstructions','Replace the default summary instructions'),text('label','Branch label')]),
        action('set_session_label','session','Label an entry','Mark a useful point in this conversation.','tag',[text('entryId','Entry ID',{required:true}),text('label','Label',{hint:'Leave empty to clear the label.'})],'Save label'),
        action('get_entries','session','Session entries','Read the event tree; optionally load entries after an ID.','list-tree',[text('since','After entry ID')]),
        action('get_messages','session','Conversation messages','Inspect the active transcript. Hidden reasoning stays hidden.','messages-square'),
        action('get_last_assistant_text','session','Latest answer','Read the most recent assistant text.','message-square-text'),
        action('export_html','session','Export HTML','Save the conversation on the connected host.','file-down',[text('outputPath','Output path',{hint:'Leave empty to use the host’s default export location.'})]),
        action('export_jsonl','session','Export JSONL','Save the session in Pi’s portable format on the host.','file-json',[text('outputPath','Output path')]),
        action('import_session','session','Import session','Open a JSONL session file that already exists on the host.','file-up',[text('inputPath','JSONL path',{required:true}),text('cwdOverride','Working directory override')]),
        action('get_available_models','model','Available models','Load models configured and available to Pi.','refresh-cw'),
        action('set_model','model','Choose model','Use a model returned by this connection.','cpu',[select('modelKey','Model',models,modelKey)],'Apply model'),
        action('cycle_model','model','Next model','Cycle through the host’s active model list.','repeat-2'),
        action('get_available_thinking_levels','model','Supported reasoning levels','Read levels supported by the current model.','brain-circuit'),
        action('set_thinking_level','model','Reasoning level','Choose from the levels reported by the current model.','brain-circuit',[select('level','Level',state.thinkingLevels,state.thinkingLevel)],'Apply level'),
        action('cycle_thinking_level','model','Next reasoning level','Cycle through supported reasoning levels.','repeat-2'),
        action('get_scoped_models','model','Model rotation','Inspect the scoped model list.','list-filter'),
        action('set_scoped_models','model','Configure model rotation','Set explicit provider/model pairs for model cycling.','list-filter',[area('models','Models (JSON)',{required:true,value:JSON.stringify(state.scopedModels,null,2),hint:'An array of {"provider":"…","modelId":"…","thinkingLevel":"…"}.'})],'Save rotation'),
        action('prompt','queue','Send a message','Send text to Pi. During a run, choose how it should be delivered.','send',[area('message','Message',{required:true}),select('streamingBehavior','When a response is running',[{value:'',label:'Require an idle session'},{value:'steer',label:'Steer current work'},{value:'followUp',label:'Queue a follow-up'}],'')],'Send to Pi'),
        action('steer','queue','Steer current work','Deliver an additional instruction after the current tool calls.','corner-up-right',[area('message','Instruction',{required:true})],'Send instruction'),
        action('follow_up','queue','Queue a follow-up','Run this message after the current work has settled.','list-plus',[area('message','Follow-up',{required:true})],'Queue message'),
        action('set_steering_mode','queue','Steering delivery','Choose how queued steering instructions are consumed.','list-ordered',[select('mode','Delivery',['one-at-a-time','all'],state.queues.steeringMode)],'Save delivery'),
        action('set_follow_up_mode','queue','Follow-up delivery','Choose how queued follow-ups are consumed.','list-ordered',[select('mode','Delivery',['one-at-a-time','all'],state.queues.followUpMode)],'Save delivery'),
        action('clear_queue','queue','Clear queued messages','Remove pending messages. Returned text remains available to recover.','list-x'),
        action('abort','queue','Stop current response','Request cancellation of the current operation. Queued messages can remain.','square'),
        action('stop_all','queue','Stop and clear queue','Clear queued messages, then cancel the active operation.','square'),
        action('get_context_usage','context','Context usage','Read the host’s current context estimate.','gauge'),
        action('compact','context','Compact conversation','Summarize earlier context while retaining session history.','archive',[area('customInstructions','Instructions',{placeholder:'Preserve methods, evidence, and open questions.'})],'Compact now'),
        action('abort_compaction','context','Cancel compaction','Request cancellation of the current compaction.','square'),
        action('abort_branch_summary','context','Cancel branch summary','Request cancellation of a branch summary.','square'),
        action('set_auto_compaction','context','Automatic compaction','Let Pi compact context when its threshold is reached.','archive',[check('enabled','Enable automatic compaction',state.config.autoCompaction===true)],'Save preference'),
        action('set_auto_retry','context','Automatic retry','Allow the host’s configured recovery policy.','rotate-cw',[check('enabled','Enable automatic retry',state.config.autoRetry===true)],'Save preference'),
        action('abort_retry','context','Cancel retry','Cancel a pending recovery attempt.','square'),
        action('get_cache_warming','context','Cache warming','Read the current cache warming mode.','flame'),
        action('set_cache_warming','context','Configure cache warming','Apply a mode supported by the native host.','flame',[select('mode','Mode',['off','streaming','idle'],state.cacheWarming||'off')],'Save mode'),
        action('get_system_prompt','context','Effective instructions','Read the session’s current system instructions.','file-text'),
        action('get_tools','tools','Available tools','Inspect active and callable built-in or extension tools.','wrench'),
        action('set_active_tools','tools','Active tools','Choose the exact tool names available to future model requests.','list-checks',[area('toolNames','Tool names',{value:state.activeTools.join('\n'),hint:'One exact tool name per line. Empty disables the tool loadout.'})],'Apply tools'),
        action('bash','tools','Run a host command','Run an explicit shell command through Pi; output stays in inline activity.','square-terminal',[area('command','Command',{required:true,placeholder:'pwd'}),check('excludeFromContext','Keep this output out of model context')],'Run command'),
        action('abort_bash','tools','Cancel shell command','Cancel active direct shell execution.','square'),
        action('get_commands','resources','Commands, skills & prompts','Discover invokable resources from the connection.','book-open'),
        action('invoke_command','resources','Use a command','Invoke an installed extension, skill, or prompt by its exact command name.','slash',[select('name','Command',state.resources.commands.map(c=>({value:c.name,label:'/'+c.name+' · '+(c.source||'command')})),''),area('arguments','Instructions')],'Run command'),
        action('get_resources','resources','Loaded resources','Inspect skills, templates, extensions, context files, and diagnostics.','library'),
        action('reload','resources','Reload resources','Ask the host to reload its installed resources and extensions.','refresh-cw'),
        action('get_session_stats','usage','Refresh usage','Read message counts, tokens, cost, and context usage.','chart-no-axes-combined'),
        action('get_settings','extensions','Host configuration','Inspect nonsecret settings reported by the host.','settings-2')
      ];
      return c.map(item=>({...item,...capability(item.id)}));
    }
    function notification(message,kind='info'){
      state.ui.notifications.push({id:'notice-'+(++sequence),message:string(message),notifyType:kind,at:Date.now()});
      state.ui.notifications=state.ui.notifications.slice(-30);
    }
    function emit(event){for(const fn of eventListeners){try{fn(event)}catch(e){options.onError?.(e)}}}
    function receive(event){
      if(destroyed||!event||typeof event!=='object')return false;
      if(event.type==='response'){
        const wait=pending.get(event.id);if(!wait)return false;
        if(wait.command!==event.command){clearTimeout(wait.timer);wait.reject(new Error('Pi response command did not match its request.'));pending.delete(event.id);return false;}
        clearTimeout(wait.timer);pending.delete(event.id);wait.resolve(event);return true;
      }
      const type=event.type;
      if(type==='extension_ui_request'){
        if(DIALOGS.has(event.method)){
          const requestKey=epoch+':'+sessionEpoch+':'+event.id;
          if(typeof event.id!=='string'||!event.id||uiPending.has(requestKey))return false;
          // This collection is the actual pending queue. Presentation limits are
          // applied only by the view; request payloads and options stay intact.
          const request={id:event.id,requestKey,method:event.method,receivedAt:Date.now()};
          for(const name of ['title','message','placeholder','prefill'])if(typeof event[name]==='string')request[name]=event[name];
          if(Array.isArray(event.options))request.options=event.options.map(value=>String(value));
          if(Number.isFinite(event.timeout)&&event.timeout>=0)request.timeout=event.timeout;
          uiPending.set(requestKey,{request,connection:target,epoch,sessionEpoch,responding:false,responseError:null});
          if(Number.isFinite(event.timeout)&&event.timeout>=0){dialogTimers.set(requestKey,setTimeout(()=>{dialogTimers.delete(requestKey);if(destroyed||!uiPending.has(requestKey))return;request.expired=true;respondUI(requestKey,{cancelled:true}).catch(()=>{});},Math.min(event.timeout,2147483647)));}
        }else if(event.method==='notify')notification(event.message,['info','warning','error'].includes(event.notifyType)?event.notifyType:'info');
        else if(event.method==='setStatus'){state.ui.statuses=state.ui.statuses.filter(s=>s.key!==event.statusKey);if(event.statusText!=null)state.ui.statuses.push({key:string(event.statusKey),text:string(event.statusText)});state.ui.statuses=state.ui.statuses.slice(-30);}
        else if(event.method==='setWidget'){state.ui.widgets=state.ui.widgets.filter(w=>w.key!==event.widgetKey);if(Array.isArray(event.widgetLines))state.ui.widgets.push({key:string(event.widgetKey),lines:event.widgetLines.slice(0,100).map(v=>string(v)),placement:event.widgetPlacement==='belowEditor'?'belowEditor':'aboveEditor'});state.ui.widgets=state.ui.widgets.slice(-20);}
        else if(event.method==='setTitle')state.ui.title=string(event.title,250);
        else if(event.method==='set_editor_text')state.ui.editorText=typeof event.text==='string'?event.text:'';
        else return false;
        publish();return true;
      }
      if(type==='extension_ui_resolved'){removeUIRequest(epoch+':'+sessionEpoch+':'+event.id);publish();return true;}
      if(type==='queue_update'){state.queues.steering=list(event.steering).map(v=>String(v??''));state.queues.followUp=list(event.followUp).map(v=>String(v??''));}
      else if(type==='agent_start')state.session.isStreaming=true;
      else if(type==='agent_settled'){state.session.isStreaming=false;scheduleRefresh(true);}
      else if(type==='session_info_changed'){state.session.sessionName=string(event.name);state.session.name=string(event.name);}
      else if(type==='thinking_level_changed'){thinkingRevision++;state.thinkingLevel=string(event.level);}
      else if(type==='entry_appended'){state.entries=[...state.entries.filter(e=>e.id!==event.entry?.id),safe(event.entry)].filter(Boolean).slice(-250);}
      else if(type==='compaction_start'){state.session.isCompacting=true;state.compaction={phase:'running',reason:event.reason};}
      else if(type==='compaction_end'){state.session.isCompacting=false;state.compaction=safe(event);scheduleRefresh();}
      else if(type==='auto_retry_start'||type==='auto_retry_end'||type.startsWith('summarization_retry_'))state.retry=safe(event);
      else if(type==='session_changed'||type==='host_session_changed'){if(Array.isArray(event.capabilities))declared=new Set(event.capabilities);resetSessionData();scheduleRefresh(true);}
      else if(type==='extension_error'||type==='host_error'){state.error=string(event.message||event.error||'The host reported an error.');notification(state.error,'error');}
      else if(type==='message_end'){if(event.message){messagesRevision++;state.messages=[...state.messages,safe(event.message)].slice(-150);}}
      if(!['message_update','tool_execution_update','bash_execution_update'].includes(type))publish();
      emit(event);return true;
    }
    function scheduleRefresh(full=false){clearTimeout(refreshTimer);scheduledFullRefresh=scheduledFullRefresh||full;const bound=epoch;refreshTimer=setTimeout(()=>{refreshTimer=0;const nextFull=scheduledFullRefresh;scheduledFullRefresh=false;if(!destroyed&&bound===epoch&&target)refresh(nextFull).catch(()=>{})},100)}
    function resetSessionData(){
      cancelPendingUI('session-changed');
      sessionEpoch++;modelRevision++;thinkingRevision++;messagesRevision++;refreshing=null;queuedFullRefresh=false;
      for(const timer of dialogTimers.values())clearTimeout(timer);dialogTimers.clear();
      const next=initial();
      for(const key of ['session','messages','historyRevision','entries','tree','forkMessages','stats','context','queues','retry','compaction','ui','model','models','thinkingLevel','thinkingLevels','thinkingLevelsPending','tools','activeTools','resources','scopedModels','cacheWarming','settings','config','systemPrompt'])state[key]=next[key];
    }
    function updateResult(command,data,params,scope={model:modelRevision,thinking:thinkingRevision,modelChanging:false}){
      const result=safe(data);
      if(command==='get_state'){
        const d=data||{},modelFresh=scope.model===modelRevision&&!scope.modelChanging&&!modelChanging(),thinkingFresh=modelFresh&&scope.thinking===thinkingRevision;
        const session=safe(d);if(!modelFresh)delete session.model;if(!thinkingFresh)delete session.thinkingLevel;
        state.session={...state.session,...session,id:d.sessionId||d.id||'',file:d.sessionFile||d.file||'',name:d.sessionName||d.name||''};
        if(modelFresh&&d.model!==undefined){if(modelKey(d.model)!==modelKey(state.model)&&(state.model||state.thinkingLevels.length)){modelRevision++;thinkingRevision++;invalidateThinkingLevels();scheduleRefresh(true);}state.model=safe(d.model);}
        if(thinkingFresh&&d.thinkingLevel!==undefined)state.thinkingLevel=d.thinkingLevel;
        if(d.steeringMode)state.queues.steeringMode=d.steeringMode;if(d.followUpMode)state.queues.followUpMode=d.followUpMode;
        if(typeof d.autoCompactionEnabled==='boolean')state.config.autoCompaction=d.autoCompactionEnabled;
        if(typeof d.autoRetryEnabled==='boolean')state.config.autoRetry=d.autoRetryEnabled;
        if(Array.isArray(d.steering))state.queues.steering=d.steering.map(v=>String(v??''));if(Array.isArray(d.followUp))state.queues.followUp=d.followUp.map(v=>String(v??''));
      }else if(command==='get_available_models')state.models=list(result?.models||result);
      else if(command==='get_available_thinking_levels'){if(scope.model===modelRevision&&!scope.modelChanging&&!modelChanging()){state.thinkingLevels=list(result?.levels||result);state.thinkingLevelsPending=false;}}
      else if(command==='set_model')state.model=result?.model||result||state.model;
      else if(command==='cycle_model'){if(result?.model)state.model=result.model;if(result?.thinkingLevel&&scope.thinking===thinkingRevision)state.thinkingLevel=result.thinkingLevel;}
      else if(command==='set_thinking_level'&&scope.thinking===thinkingRevision)state.thinkingLevel=params.level;
      else if(command==='cycle_thinking_level'&&result?.level&&scope.thinking===thinkingRevision)state.thinkingLevel=result.level;
      else if(command==='get_session_stats'){state.stats=result||{};if(result?.contextUsage)state.context=result.contextUsage;}
      else if(command==='get_context_usage')state.context=result&&Object.hasOwn(result,'contextUsage')?(result.contextUsage||{}):(result||{});
      else if(command==='get_messages'){
        // A same-session history response can still predate newly observed
        // messages. Keep that live suffix and request an authoritative reread.
        if(scope.messages!==messagesRevision){scheduleRefresh(true);return;}
        state.messages=list(result?.messages||result);messagesRevision++;state.historyRevision++;
      }
      else if(command==='get_entries'){state.entries=params.since?[...state.entries,...list(result?.entries)].slice(-250):list(result?.entries);state.session.leafId=result?.leafId;}
      else if(command==='get_tree'){state.tree=list(result?.tree||result);state.session.leafId=result?.leafId;}
      else if(command==='get_fork_messages')state.forkMessages=list(result?.messages||result);
      else if(command==='list_sessions')state.sessions=list(result?.sessions||result);
      else if(command==='get_tools'){state.tools=list(result?.tools||result);state.activeTools=list(result?.activeTools);}
      else if(command==='set_active_tools')state.activeTools=list(params.toolNames);
      else if(command==='get_commands'){
        state.resources.commands=list(result?.commands||result);
        state.resources.skills=state.resources.commands.filter(c=>c.source==='skill');state.resources.prompts=state.resources.commands.filter(c=>c.source==='prompt');
      }else if(command==='get_resources')state.resources={...state.resources,...(result||{})};
      else if(command==='get_settings')state.settings=result||{};
      else if(command==='get_system_prompt')state.systemPrompt=string(result?.systemPrompt??result?.text??result);
      else if(command==='get_scoped_models')state.scopedModels=list(result?.models||result);
      else if(command==='set_scoped_models')state.scopedModels=safe(params.models);
      else if(command==='get_cache_warming')state.cacheWarming=result?.mode??result;
      else if(command==='set_cache_warming')state.cacheWarming=params.mode;
      else if(command==='set_session_name'){state.session.name=params.name;state.session.sessionName=params.name;}
      else if(command==='set_steering_mode')state.queues.steeringMode=params.mode;
      else if(command==='set_follow_up_mode')state.queues.followUpMode=params.mode;
      else if(command==='set_auto_compaction')state.config.autoCompaction=params.enabled;
      else if(command==='set_auto_retry')state.config.autoRetry=params.enabled;
      else if(command==='clear_queue'){state.clearedQueue=result||{steering:[],followUp:[]};state.queues.steering=[];state.queues.followUp=[];}
      if(SESSION_CHANGE.has(command)&&data?.cancelled!==true){resetSessionData();const draft=data?.editorText??data?.text;if(typeof draft==='string')state.ui.editorText=draft;emit({type:'session_changed',command});}
    }
    function prepare(id,params={}){
      const p={...params};
      const spec=getCatalog().find(a=>a.id===id);
      if(!spec)throw new Error('Unknown Pi action.');
      for(const f of spec.fields){if(f.type==='checkbox'&&p[f.name]!==undefined)p[f.name]=p[f.name]===true||p[f.name]==='true';if(f.required&&(p[f.name]==null||String(p[f.name]).trim()==='')&&!(f.name==='message'&&(list(p.images).length||list(p.fileReferences).length)))throw new Error(f.label+' is required.');}
      if(['prompt','steer','follow_up'].includes(id)){p.message=validateMessage(p.message);p.fileReferences=fileReferences(p.fileReferences);if(!p.message.trim()&&!list(p.images).length&&!list(p.fileReferences).length)throw new Error('Enter a message or attach a file.');if(p.streamingBehavior&&!['steer','followUp'].includes(p.streamingBehavior))throw new Error('Choose a valid streaming delivery mode.');}
      if(id==='set_model'){
        const m=state.models.find(m=>p.modelKey===m.provider+'\u241f'+m.id||(m.provider===p.provider&&m.id===p.modelId));
        if(!m)throw new Error('Choose a model returned by this connection.');return {provider:m.provider,modelId:m.id};
      }
      if(id==='set_thinking_level'&&!state.thinkingLevels.includes(p.level))throw new Error('Choose a reasoning level supported by this model.');
      if(['set_steering_mode','set_follow_up_mode'].includes(id)&&!['all','one-at-a-time'].includes(p.mode))throw new Error('Choose a delivery mode.');
      if(id==='set_cache_warming'&&!['off','streaming','idle'].includes(p.mode))throw new Error('Choose a cache warming mode.');
      if(id==='set_active_tools'){
        p.toolNames=Array.isArray(p.toolNames)?p.toolNames:String(p.toolNames||'').split(/[\n,]/).map(v=>v.trim()).filter(Boolean);
        const known=new Set(state.tools.map(t=>typeof t==='string'?t:t.name));if(p.toolNames.some(n=>!known.has(n)))throw new Error('Use exact tool names reported by this connection.');
      }
      if(id==='set_scoped_models'){
        if(typeof p.models==='string'){try{p.models=JSON.parse(p.models)}catch(_){throw new Error('Enter a valid JSON array of model identifiers.')}}
        if(!Array.isArray(p.models)||p.models.some(m=>!m||!m.provider||!m.modelId))throw new Error('Each model needs provider and modelId.');
      }
      if(id==='invoke_command'){
        if(!state.resources.commands.some(c=>c.name===p.name))throw new Error('Select an installed command.');
        const argumentsText=p.arguments==null?'':String(p.arguments);
        return {message:validateMessage('/'+p.name+(argumentsText?' '+argumentsText:'')),...(state.session.isStreaming?{streamingBehavior:'followUp'}:{})};
      }
      const allowed=new Set(spec.fields.map(f=>f.name));if(['prompt','steer','follow_up'].includes(id)){allowed.add('images');allowed.add('fileReferences');}
      // A validated attachment-only message is deliberately empty, not absent.
      // The host still requires the string field and independently checks files.
      const messageAction=['prompt','steer','follow_up'].includes(id);
      return Object.fromEntries(Object.entries(p).filter(([k,v])=>allowed.has(k)&&v!==undefined&&(v!==''||messageAction&&k==='message')));
    }
    async function direct(command,p,current){
      if(command==='get_state')return {model:current.model,thinkingLevel:current.thinkingLevel,isStreaming:current.isStreaming,isCompacting:current.isCompacting,steeringMode:current.steeringMode,followUpMode:current.followUpMode,sessionFile:current.sessionFile,sessionId:current.sessionId,sessionName:current.sessionName,autoCompactionEnabled:current.autoCompactionEnabled,autoRetryEnabled:current.autoRetryEnabled,messageCount:current.messages?.length,pendingMessageCount:current.pendingMessageCount,steering:current.getSteeringMessages?.(),followUp:current.getFollowUpMessages?.()};
      if(command==='get_messages')return {messages:current.messages};
      if(command==='get_available_models')return {models:current.modelRuntime.getAvailableSnapshot()};
      if(command==='get_system_prompt')return {systemPrompt:current.systemPrompt};
      if(command==='get_entries'){let entries=current.sessionManager.getEntries();if(p.since){const at=entries.findIndex(e=>e.id===p.since);if(at<0)throw new Error('Entry not found.');entries=entries.slice(at+1);}return {entries,leafId:current.sessionManager.getLeafId?.()};}
      if(command==='get_tree')return {tree:current.sessionManager.getTree(),leafId:current.sessionManager.getLeafId?.()};
      const method=DIRECT[command];if(!method||typeof current[method]!=='function')throw new Error('The host does not expose this operation.');
      let result;
      switch(command){
        case 'prompt':{let disposition;await current.prompt(p.message,{images:p.images,streamingBehavior:p.streamingBehavior,preflightResult:value=>{disposition=value}});return disposition?{disposition}:{};}
        case 'steer':case 'follow_up':return {disposition:await current[method](p.message,p.images)};
        case 'set_model':{const model=current.modelRuntime?.getAvailableSnapshot?.().find(m=>m.provider===p.provider&&m.id===p.modelId);if(!model)throw new Error('The model is no longer available.');await current.setModel(model);return model;}
        case 'set_thinking_level':return current[method](p.level);
        case 'set_steering_mode':case 'set_follow_up_mode':return current[method](p.mode);
        case 'set_auto_compaction':case 'set_auto_retry':return current[method](p.enabled);
        case 'set_session_name':return current[method](p.name);
        case 'compact':return current[method](p.customInstructions);
        case 'bash':return current[method](p.command,undefined,{excludeFromContext:p.excludeFromContext,id:p.id});
        case 'export_html':case 'export_jsonl':return {path:await current[method](p.outputPath)};
        case 'set_active_tools':return current[method](p.toolNames);
        case 'navigate_tree':return current[method](p.targetId,{summarize:p.summarize,customInstructions:p.customInstructions,replaceInstructions:p.replaceInstructions,label:p.label});
        case 'get_available_thinking_levels':return {levels:current[method]()};
        case 'get_fork_messages':return {messages:current[method]()};
        case 'get_last_assistant_text':return {text:current[method]()};
        case 'get_tools':return {tools:current[method](),activeTools:current.getActiveToolNames?.()||[]};
        case 'cycle_thinking_level':result=current[method]();return result?{level:result}:null;
        default:return current[method]();
      }
    }
    async function requestRaw(command,p,bound,id){
      const current=target;if(!current||bound!==epoch)throw new Error('Pi connection changed.');
      const wire={id,type:command,...p};
      if(mode==='native')return direct(command,{...p,id},current);
      let response;
      if(typeof current.request==='function')response=await current.request(wire);
      else if(typeof current.send==='function'){
        response=await new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>{pending.delete(id);reject(new Error('No response from Pi. Check the host before retrying.'))},options.requestTimeoutMs||120000);
          pending.set(id,{resolve,reject,timer,command});
          try{Promise.resolve(current.send(wire)).catch(error=>{const entry=pending.get(id);if(entry){clearTimeout(entry.timer);pending.delete(id);reject(error)}})}catch(error){clearTimeout(timer);pending.delete(id);reject(error)}
        });
      }else throw new Error('Pi transport must provide request(command) or send(command).');
      if(bound!==epoch||target!==current)throw new Error('Pi connection changed.');
      if(!response||response.type!=='response'||response.command!==command||(response.id!==undefined&&response.id!==id))throw new Error('Unexpected Pi response.');
      if(response.success!==true)throw new Error(string(response.error)||'Pi rejected the request.');
      return response.data;
    }
    async function request(command,p,bound){
      const id='athena-'+requestPrefix+'-'+bound+'-'+(++sequence);
      if(command==='bash')emit({type:'host_command_start',id,command,args:safe(p)});
      try{const data=await requestRaw(command,p,bound,id);if(bound!==epoch||destroyed)throw new Error('Pi connection changed.');if(command==='bash')emit({type:'host_command_end',id,command,data:safe(data)});return data;}
      catch(error){if(bound===epoch&&command==='bash')emit({type:'host_command_end',id,command,error:string(error?.message||error)});throw error;}
    }
    async function execute(id,params={},internal={}){
      if(destroyed||!available(id))throw new Error(capability(id).reason||'This action is not available.');
      if(busy.has(id)&&!internal.background)throw new Error('This request is already in progress.');
      if(MODEL_CONTROL.has(id)&&[...MODEL_CONTROL].some(command=>busy.has(command)))throw new Error('Wait for the current model or reasoning change to finish.');
      if(SESSION_CHANGE.has(id)&&(state.session.isStreaming||state.session.isCompacting))throw new Error('Wait for the current operation to settle before changing sessions.');
      const bound=epoch,sessionBound=sessionEpoch,command=id==='invoke_command'?'prompt':id,p=prepare(id,params),marker={};
      if(MODEL_CHANGE.has(id)){modelRevision++;thinkingRevision++;invalidateThinkingLevels();}
      else if(MODEL_CONTROL.has(id))thinkingRevision++;
      if(id==='get_available_thinking_levels')state.thinkingLevelsPending=true;
      const scope={model:modelRevision,thinking:thinkingRevision,messages:messagesRevision,modelChanging:modelChanging()};
      busy.set(id,marker);state.error=null;publish();
      try{
        let data;
        if(id==='stop_all'){
          const cleared=await request('clear_queue',{},bound);if(bound!==epoch)throw new Error('Pi connection changed.');updateResult('clear_queue',cleared,{});publish();
          await request('abort',{},bound);data={clearedQueue:cleared,cancellationRequested:true};
        }else data=await request(command,p,bound);
        if(bound!==epoch||destroyed)throw new Error('Pi connection changed.');
        if(sessionBound!==sessionEpoch&&!SESSION_CHANGE.has(id))throw new Error('The active Pi session changed.');
        updateResult(command,data,p,scope);
        if(!internal.background){
          const disposition=data?.disposition;
          state.lastResult={action:id,data:safe(data)??null,message:data?.cancelled?'The host cancelled this action.':disposition==='queued'?'Message queued.':disposition==='handled'?'Handled by an extension.':disposition==='started'?'Message accepted.':TERMINAL.has(id)?'Cancellation requested; waiting for the runtime.':'Request completed.',at:Date.now()};
        }
        if(!internal.background&&!MODEL_CHANGE.has(id)&&(!id.startsWith('get_')||SESSION_CHANGE.has(id)))scheduleRefresh(SESSION_CHANGE.has(id)||id==='reload');
        return safe(data);
      }catch(error){if(bound===epoch&&sessionBound===sessionEpoch&&!destroyed){if(id==='get_available_thinking_levels'&&scope.model===modelRevision)state.thinkingLevelsPending=false;state.error=string(error?.message||error);if(!internal.background)state.lastResult={action:id,data:null,message:state.error,error:true,at:Date.now()};}throw error;
      }finally{if(bound===epoch&&!destroyed){if(busy.get(id)===marker)busy.delete(id);if(MODEL_CHANGE.has(id)&&sessionBound===sessionEpoch)scheduleRefresh(true);publish();}}
    }
    async function refresh(full=true){
      if(destroyed||!target)return getState();if(refreshing){queuedFullRefresh=queuedFullRefresh||full;return refreshing;}
      const bound=epoch;
      const sessionBound=sessionEpoch;
      const ids=['get_state','get_session_stats',...(full?['get_messages','get_available_models','get_available_thinking_levels','get_commands','get_tools','get_resources','get_scoped_models','get_cache_warming']:[])].filter(available);
      const task=(async()=>{const results=await Promise.allSettled(ids.map(id=>execute(id,{}, {background:true})));if(bound===epoch&&sessionBound===sessionEpoch){const errors=results.filter(r=>r.status==='rejected');if(errors.length)state.error=errors.map(r=>string(r.reason?.message||r.reason)).join(' · ');publish();}return getState()})();refreshing=task;
      try{return await task}finally{if(refreshing===task){refreshing=null;if(queuedFullRefresh){queuedFullRefresh=false;scheduleRefresh(true);}}}
    }
    async function respondUI(id,response){
      const matching=[...uiPending.values()].filter(record=>record.request.id===id);
      const record=uiPending.get(id)||matching.find(record=>record.connection===target&&record.epoch===epoch&&record.sessionEpoch===sessionEpoch)||(matching.length===1?matching[0]:null);
      if(!record)throw new Error('This request is no longer pending.');
      const r=record.request,key=r.requestKey;
      if(record.responding)throw new Error('A response to this request is already being sent.');
      if(!record.connection||typeof record.connection.send!=='function')throw new Error('This connection cannot return extension UI responses.');
      if((record.connection!==target||record.epoch!==epoch||record.sessionEpoch!==sessionEpoch)&&response?.cancelled!==true)throw new Error('This request belongs to an earlier connection. Cancel it instead of answering in a different session.');
      let payload;
      if(response?.cancelled===true)payload={cancelled:true};
      else if(r.method==='confirm'&&typeof response?.confirmed==='boolean')payload={confirmed:response.confirmed};
      else if(r.method!=='confirm'&&typeof response?.value==='string'){
        if(r.method==='select'&&!list(r.options).includes(response.value))throw new Error('Choose one of the offered options.');payload={value:response.value};
      }else throw new Error('Invalid extension response.');
      const bound=epoch,sessionBound=sessionEpoch;record.responding=true;record.responseError=null;publish();
      try {
        const accepted=await record.connection.send({type:'extension_ui_response',id:r.id,...payload});
        if(accepted===false&&uiPending.has(key))throw new Error('The runtime did not accept this response. The request remains pending.');
        removeUIRequest(key);publish();return !destroyed&&bound===epoch&&sessionBound===sessionEpoch;
      } catch(error) {
        if(uiPending.has(key)){record.responseError=string(error?.message||error);state.error=record.responseError;publish();}
        throw error;
      } finally {record.responding=false;publish();}
    }
    function detach(){
      cancelPendingUI('disconnected');
      epoch++;modelRevision++;thinkingRevision++;messagesRevision++;clearTimeout(refreshTimer);refreshTimer=0;scheduledFullRefresh=false;queuedFullRefresh=false;unsubscribe?.();unsubscribe=null;
      for(const wait of pending.values()){clearTimeout(wait.timer);wait.reject(new Error('Pi disconnected.'));}pending.clear();
      for(const timer of dialogTimers.values())clearTimeout(timer);dialogTimers.clear();
      target=null;mode='disconnected';declared=null;refreshing=null;facade=null;attachOptions={};busy.clear();state=initial();publish();
    }
    function attach(connection,settings={}){
      if(destroyed)throw new Error('Pi runtime is destroyed.');
      if(!connection||typeof connection.subscribe!=='function')throw new TypeError('Pi connection needs subscribe(listener).');
      const nextMode=settings.mode||connection.mode||((typeof connection.request==='function'||typeof connection.send==='function')?'rpc':'native');
      if(!['rpc','host','native'].includes(nextMode))throw new Error('Use native, rpc, or host connection mode.');
      detach();target=connection;attachOptions=settings;mode=nextMode;
      const caps=settings.capabilities||connection.capabilities;declared=Array.isArray(caps)?new Set(caps):null;
      const bound=epoch;state.connected=true;state.mode=mode;state.connectionLabel=settings.label||connection.label||(mode==='rpc'?'Pi RPC connected':mode==='host'?'Pi SDK connected':'Pi session connected');
      const unsub=connection.subscribe(event=>{if(!destroyed&&target===connection&&bound===epoch)receive(event)});unsubscribe=typeof unsub==='function'?unsub:null;
      facade={subscribe(fn){eventListeners.add(fn);return()=>eventListeners.delete(fn)}};
      if(available('prompt'))facade.prompt=(message,p={})=>target===connection&&bound===epoch?execute('prompt',{message,...p}):Promise.reject(new Error('Pi connection changed.'));
      if(available('abort'))facade.abort=()=>target===connection&&bound===epoch?execute('abort'):Promise.reject(new Error('Pi connection changed.'));
      facade.supportsImages=settings.supportsImages===true||connection.supportsImages===true||mode==='rpc'||mode==='host'||Boolean(connection.modelRuntime);
      facade.supportsFileReferences=getInputContract().supportsFileReferences;
      Object.defineProperty(facade,'inputContract',{get:getInputContract});
      if(getInputContract().canStageFiles)facade.stageFiles=(files,context)=>target===connection&&bound===epoch?stageFiles(files,context):Promise.reject(new Error('Pi connection changed.'));
      publish();if(settings.refresh!==false)refresh().catch(()=>{});
      return {session:facade,detach:()=>target===connection&&bound===epoch?(detach(),true):false};
    }
    const api={getState,getCatalog,getInputContract,validateMessage,stageFiles,execute,refresh,receive,respondUI,attach,detach,available,subscribe(fn){listeners.add(fn);fn(getState());return()=>listeners.delete(fn)},subscribeEvents(fn){eventListeners.add(fn);return()=>eventListeners.delete(fn)},getSession:()=>facade,getPendingUIRequests:()=>{syncUIRequests();return clone(state.ui.requests);},getPendingRequestCount:()=>pending.size,destroy(){if(destroyed)return;detach();destroyed=true;listeners.clear();eventListeners.clear()}};
    return api;
  }
  window.AthenaPiRuntime=Object.freeze({create,RPC_COMMANDS:RPC,NATIVE_COMMANDS:NATIVE});
})();
