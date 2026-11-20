/* Pi SDK / JSON event presentation only. No SDK import, transport, shell,
 * credentials, or network request. See docs/PI-EVENT-MAP.md for source contracts.
 */
(() => {
  'use strict';
  const PHASES = Object.freeze({
    idle: ['circle', 'Ready', false, 'none'],
    waiting: ['hourglass', 'Waiting', true, 'pulse'],
    thinking: ['brain-circuit', 'Thinking', true, 'pulse'],
    replying: ['message-square-text', 'Replying', true, 'pulse'],
    preparing: ['braces', 'Preparing tool call', true, 'pulse'],
    working: ['wrench', 'Running', true, 'pulse'],
    approval: ['shield-check', 'Awaiting approval', false, 'none'],
    retrying: ['rotate-cw', 'Retrying', true, 'rotate'],
    compacting: ['archive', 'Compacting context', true, 'pulse'],
    complete: ['check', 'Complete', false, 'none'],
    error: ['circle-alert', 'Needs attention', false, 'none'],
    stopped: ['square', 'Stopped', false, 'none'],
    paused: ['pause', 'Paused', false, 'none']
  });
  const PHASE_ALIASES = Object.freeze({ ready: 'idle', queued: 'waiting', blocked: 'approval', awaiting: 'approval', 'awaiting-approval': 'approval', running: 'working', tool: 'working', reply: 'replying', done: 'complete', succeeded: 'complete', completed: 'complete', failed: 'error', cancelled: 'stopped', aborted: 'stopped' });
  const TOOL_KINDS = Object.freeze({
    read: ['file-text', 'Reading file', 'Read file', 'File read', 'File read failed'],
    write: ['file-plus-2', 'Writing file', 'Write file', 'File written', 'File write failed'],
    edit: ['file-pen-line', 'Editing file', 'Edit file', 'File edited', 'File edit failed'],
    bash: ['square-terminal', 'Running terminal command', 'Run terminal command', 'Command finished', 'Command failed'],
    powershell: ['terminal', 'Running PowerShell', 'Run PowerShell', 'PowerShell finished', 'PowerShell failed'],
    grep: ['search-code', 'Searching file contents', 'Search file contents', 'Contents searched', 'Content search failed'],
    find: ['files', 'Finding files', 'Find files', 'Files found', 'File search failed'],
    ls: ['folder-open', 'Listing directory', 'List directory', 'Directory listed', 'Directory listing failed'],
    codemode: ['braces', 'Running code', 'Run code', 'Code finished', 'Code failed'],
    custom: ['plug', 'Running tool', 'Run tool', 'Tool finished', 'Tool failed']
  });
  const ICONS = new Set([...Object.values(PHASES).map(item => item[0]), ...Object.values(TOOL_KINDS).map(item => item[0])]);
  const textValue = (value, maximum = 4000) => typeof value === 'string' ? value.slice(0, maximum) : '';
  const bounded = (value, fallback, min, max) => Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
  const deepFreeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; };

  function phase(value = 'idle') {
    const requested = typeof value === 'string' ? value.toLowerCase() : 'idle';
    const id = Object.hasOwn(PHASES, requested) ? requested : Object.hasOwn(PHASE_ALIASES, requested) ? PHASE_ALIASES[requested] : 'idle';
    const [icon, label, active, motion] = PHASES[id];
    return Object.freeze({ id, icon, label, active, motion });
  }

  function iconHTML(name, options = {}) {
    const icon = ICONS.has(name) ? name : 'wrench';
    const value = options && typeof options === 'object' ? options : {};
    const active = value.active === true;
    const motion = active && ['pulse', 'rotate'].includes(value.motion) ? value.motion : active ? 'pulse' : 'none';
    const extra = typeof value.className === 'string' ? value.className.replace(/[^a-zA-Z0-9_ -]/g, '').trim().slice(0, 80) : '';
    return '<span class="ap-icon' + (extra ? ' ' + extra : '') + '" data-pi-active="' + active + '" data-pi-motion="' + motion + '" aria-hidden="true"><i data-lucide="' + icon + '" aria-hidden="true"></i></span>';
  }

  function phaseIcon(name, options = {}) {
    const item = phase(name);
    return iconHTML(item.icon, { active: item.active, motion: item.motion, ...options });
  }

  function toolPresentation(name, args = {}, status = 'running') {
    const toolName = textValue(name, 100);
    const kind = Object.hasOwn(TOOL_KINDS, toolName) ? toolName : 'custom';
    const info = TOOL_KINDS[kind];
    const state = ['done', 'complete', 'completed', 'succeeded'].includes(status) ? 'succeeded' : ['error', 'failed'].includes(status) ? 'failed' : ['stopped', 'cancelled', 'aborted'].includes(status) ? 'stopped' : ['queued', 'pending', 'waiting', 'paused', 'blocked'].includes(status) ? 'queued' : 'running';
    const value = args && typeof args === 'object' ? args : {};
    const path = textValue(value.path || value.file_path || value.filePath, 500);
    let detail = ['bash', 'powershell'].includes(kind) ? textValue(value.command, 1200) : ['grep', 'find'].includes(kind) ? [textValue(value.pattern, 240), path].filter(Boolean).join(' · ') : kind === 'ls' ? path || '.' : path;
    if (kind === 'custom') detail = [toolName, detail || textValue(value.query || value.url, 240)].filter(Boolean).join(' · ');
    if (kind === 'codemode') detail = textValue(value.description || value.title, 240);
    const label = state === 'succeeded' ? info[3] : state === 'failed' ? info[4] : state === 'queued' ? info[2] : state === 'stopped' ? info[2] + ' · stopped' : info[1];
    return Object.freeze({ kind, icon: info[0], label, detail, status: state, active: state === 'running', motion: state === 'running' ? 'pulse' : 'none' });
  }

  function safeArgs(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const copy = {};
    for (const key of Object.keys(value).slice(0, 30)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
      const item = value[key];
      if (typeof item === 'string') copy[key] = item.slice(0, 4000);
      else if (typeof item === 'number' && Number.isFinite(item) || typeof item === 'boolean' || item === null) copy[key] = item;
    }
    return copy;
  }

  function resultText(result) {
    if (typeof result === 'string') return result;
    if (!result || typeof result !== 'object') return '';
    if (Array.isArray(result.content)) return result.content.filter(item => item?.type === 'text' && typeof item.text === 'string').map(item => item.text).join('\n');
    return typeof (result.output || result.text) === 'string' ? result.output || result.text : '';
  }
  function inputPreview(value) {
    const args = safeArgs(value);
    const shown = JSON.stringify(args);
    let original;
    try { original = JSON.stringify(value && typeof value === 'object' ? value : {}); } catch (_) { original = null; }
    return { args, inputTruncated: original !== shown, inputCharacters: original == null ? null : original.length, inputPreviewCharacters: shown.length };
  }

  function create(options = {}) {
    const now = typeof options.now === 'function' ? options.now : Date.now;
    const maxTools = bounded(options.maxTools, 100, 5, 500);
    const maxActivity = bounded(options.maxActivity, 100, 10, 500);
    // Primary assistant messages stay complete. Tool output remains an explicitly
    // marked tail preview; its length metadata is separate from received text.
    const maxText = Infinity, maxOutput = 65536;
    const listeners = new Set();
    const outputModes = safeArgs(options.toolOutputModes);
    let destroyed = false, started = false, counter = 0, current = null, blocks = new Map();
    let messageBoundary = 0, lastTerminal = null;
    const completedMessages = new Map();
    const messageKey = (message, event) => message?.id ?? message?.messageId ?? event?.messageId ?? null;
    let state;

    function initial(runId = 0) {
      return { phase: 'idle', label: 'Ready', icon: 'circle', active: false, settled: true, sequence: 0, runId, text: '', textRevision: 0, messageId: null, messages: [], tools: [], activity: [], thinkingCharacters: 0, queue: { steering: 0, followUp: 0 }, error: null };
    }
    state = initial();
    const snapshot = () => deepFreeze(JSON.parse(JSON.stringify(state)));
    function publish() {
      const next = snapshot();
      for (const listener of [...listeners]) listener(next);
      return next;
    }
    function setPhase(name) {
      const next = phase(name);
      state.phase = next.id; state.label = next.label; state.icon = next.icon; state.active = next.active;
    }
    function activity(type, label, icon, detail = '', toolCallId = null) {
      state.activity.push({ id: 'pi-event-' + (++counter), eventType: type, label, icon, detail, toolCallId, phase: state.phase, at: now() });
      if (state.activity.length > maxActivity) state.activity.splice(0, state.activity.length - maxActivity);
    }
    function ensureMessage() {
      if (current) return current;
      blocks = new Map();
      const index = state.messages.length ? state.messages[state.messages.length - 1].index + 1 : 0;
      current = { id: 'pi-' + state.runId + '-message-' + index, index, text: '', complete: false, stopReason: null };
      state.messages.push(current);
      state.messageId = current.id;
      return current;
    }
    function syncText() {
      if (current) current.text = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(entry => entry[1]).join('').slice(0, maxText);
      const text = state.messages.map(message => message.text).filter(Boolean).join('\n\n').slice(-maxText);
      if (text !== state.text) { state.text = text; state.textRevision += 1; }
    }
    function finishMessage(message, source, event) {
      if (!message || message.role !== 'assistant') return;
      const externalId = messageKey(message, event);
      const known = externalId == null ? null : completedMessages.get(String(externalId));
      if (known && current && known !== current) return;
      // Pi's stream can report `done` and then the outer `message_end` for the
      // same message. Pair those terminal envelopes within one message boundary;
      // never deduplicate by text, because separate messages can be identical.
      const companion = !current && lastTerminal && !lastTerminal.paired && lastTerminal.boundary === messageBoundary && lastTerminal.source !== source && (externalId == null || lastTerminal.externalId == null || String(externalId) === String(lastTerminal.externalId));
      const record = known || (companion ? lastTerminal.record : ensureMessage());
      if (Array.isArray(message.content)) {
        if (record === current) {
          blocks.clear();
          message.content.forEach((block, i) => { if (block?.type === 'text') blocks.set(i, textValue(block.text, maxText)); });
        } else record.text = message.content.filter(block => block?.type === 'text').map(block => textValue(block.text, maxText)).join('');
      } else if (typeof message.content === 'string') {
        if (record === current) { blocks.clear(); blocks.set(0, message.content); }
        else record.text = message.content;
      }
      syncText();
      record.complete = true; record.stopReason = textValue(message.stopReason, 50) || null;
      if (externalId != null) { record.sourceMessageId = String(externalId); completedMessages.set(String(externalId), record); }
      lastTerminal = { record, source, externalId, boundary: messageBoundary, paired: Boolean(known || companion) };
      if (message.stopReason === 'aborted') { setPhase('stopped'); state.error = textValue(message.errorMessage, 4000) || null; }
      else if (message.stopReason === 'error') { setPhase('error'); state.error = textValue(message.errorMessage, 4000) || 'The response could not be completed.'; }
      current = null; blocks = new Map();
    }
    function findTool(id) { return state.tools.find(item => item.toolCallId === id); }
    function ensureTool(event, status = 'running') {
      const id = textValue(event.toolCallId, 300);
      if (!id) return null;
      let tool = findTool(id);
      if (!tool) {
        const toolName = textValue(event.toolName, 100) || 'custom';
        tool = { id, toolCallId: id, toolName, ...inputPreview(event.args), status, output: '', outputCharacters: 0, outputPreviewCharacters: 0, outputTruncated: false, outputRevision: 0, durationMs: null, parentToolCallId: textValue(event.parentToolCallId, 300) || null, startedAt: status === 'running' ? now() : null, endedAt: null };
        state.tools.push(tool);
        if (state.tools.length > maxTools) { const removable = state.tools.findIndex(item => item !== tool && item.status !== 'running'); state.tools.splice(removable < 0 ? 0 : removable, 1); }
      } else {
        if (typeof event.toolName === 'string' && event.toolName) tool.toolName = textValue(event.toolName, 100);
        if (event.args) Object.assign(tool, inputPreview(event.args));
      }
      return tool;
    }
    function decorate(tool) { Object.assign(tool, toolPresentation(tool.toolName, tool.args, tool.status)); }
    function putOutput(tool, text, append = false) {
      const value = (append ? tool.output + text : text).slice(-maxOutput);
      tool.outputCharacters = append ? (tool.outputCharacters || 0) + text.length : text.length;
      tool.outputPreviewCharacters = value.length;
      tool.outputTruncated = tool.outputCharacters > value.length;
      if (value !== tool.output) { tool.output = value; tool.outputRevision += 1; }
    }
    function restPhase() { setPhase(state.tools.some(tool => tool.status === 'running') ? 'working' : 'waiting'); }

    function receive(event) {
      if (destroyed || !event || typeof event !== 'object' || typeof event.type !== 'string') return false;
      const type = event.type;
      const meaningful = ['agent_start','agent_end','agent_settled','turn_start','turn_end','message_start','message_update','message_end','tool_execution_start','tool_execution_update','tool_execution_end','queue_update','compaction_start','compaction_end','auto_compaction_start','auto_compaction_end','auto_retry_start','auto_retry_end','summarization_retry_scheduled','summarization_retry_attempt_start','summarization_retry_finished','bash_execution_update','extension_error','ui_prompt_start','ui_prompt_end'];
      if (!meaningful.includes(type)) return false;
      if (state.settled && started && !['agent_start','queue_update'].includes(type)) return false;
      if (['message_start','message_update','message_end'].includes(type) && event.message?.role && event.message.role !== 'assistant') return false;
      const previousText = state.textRevision;
      if (type === 'agent_start') {
        if (state.settled) { state = initial(state.runId + 1); current = null; blocks.clear(); completedMessages.clear(); lastTerminal = null; messageBoundary++; }
        started = true; state.settled = false; state.error = null; setPhase('waiting');
        activity(type, 'Waiting for a response', 'hourglass');
      } else if (type === 'queue_update') {
        state.queue = { steering: Array.isArray(event.steering) ? event.steering.length : 0, followUp: Array.isArray(event.followUp) ? event.followUp.length : 0 };
      } else {
        started = true; state.settled = false;
        if (type === 'turn_start') { current = null; blocks.clear(); messageBoundary++; lastTerminal = null; restPhase(); }
        else if (type === 'message_start') {
          if (event.message?.role !== 'assistant') return false;
          current = null; blocks.clear(); messageBoundary++; lastTerminal = null; ensureMessage(); restPhase();
        } else if (type === 'message_update') {
          const update = event.assistantMessageEvent;
          if (!update || typeof update.type !== 'string') return false;
          const index = bounded(update.contentIndex, 0, 0, 1000);
          const oldPhase = state.phase;
          if (['text_start','text_delta','text_end'].includes(update.type)) {
            ensureMessage();
            if (update.type === 'text_start' && !blocks.has(index)) blocks.set(index, '');
            if (update.type === 'text_delta') blocks.set(index, ((blocks.get(index) || '') + textValue(update.delta, maxText)).slice(0, maxText));
            if (update.type === 'text_end' && typeof update.content === 'string') blocks.set(index, update.content.slice(0, maxText));
            syncText(); setPhase('replying');
          } else if (update.type.startsWith('thinking_')) {
            if (update.type === 'thinking_delta') state.thinkingCharacters += textValue(update.delta, maxText).length;
            setPhase(update.type === 'thinking_end' ? 'waiting' : 'thinking');
          } else if (update.type.startsWith('toolcall_')) {
            const call = update.toolCall || update.partial?.content?.[index];
            const toolCallId = textValue(update.id || call?.id, 300);
            if (toolCallId) {
              const tool = ensureTool({ toolCallId, toolName: update.toolName || call?.name, args: call?.arguments }, 'queued');
              if (tool) decorate(tool);
            }
            setPhase('preparing');
          } else if (update.type === 'error') {
            finishMessage(update.error, 'update', event); setPhase(update.reason === 'aborted' ? 'stopped' : 'error');
          } else if (update.type === 'done') { finishMessage(update.message, 'update', event); restPhase(); }
          else if (update.type === 'start') restPhase();
          else return false;
          if (oldPhase !== state.phase) activity(type, state.label, state.icon);
        } else if (type === 'message_end') {
          finishMessage(event.message, 'end', event);
          if (!['error','stopped'].includes(state.phase)) restPhase();
        } else if (type.startsWith('tool_execution_')) {
          const previous = findTool(textValue(event.toolCallId, 300));
          if (previous && !['running','queued'].includes(previous.status) && type !== 'tool_execution_end') return false;
          const tool = ensureTool(event);
          if (!tool) return false;
          if (type === 'tool_execution_start') { tool.status = 'running'; tool.startedAt = tool.startedAt ?? now(); tool.endedAt = null; }
          if (type === 'tool_execution_update') {
            if (!['running','queued'].includes(tool.status)) return false;
            tool.status = 'running'; putOutput(tool, resultText(event.partialResult), outputModes[tool.toolName] === 'append');
          }
          if (type === 'tool_execution_end') {
            tool.status = event.isError === true || event.result?.isError === true ? 'failed' : 'succeeded';
            tool.endedAt = now();
            tool.durationMs = typeof event.durationMs === 'number' && event.durationMs >= 0 ? event.durationMs : null;
            putOutput(tool, resultText(event.result));
          }
          decorate(tool); restPhase();
          if (type !== 'tool_execution_update') activity(type, tool.label, tool.icon, tool.detail, tool.id);
        } else if (type === 'bash_execution_update') {
          const tool = ensureTool({ toolCallId: 'rpc-bash:' + (textValue(event.id, 250) || 'unidentified'), toolName: 'bash' });
          tool.status = 'running'; putOutput(tool, textValue(event.delta, Infinity), true); decorate(tool); setPhase('working');
        } else if (type === 'agent_end') {
          if (event.willRetry) setPhase('retrying');
          else if (!['error','stopped'].includes(state.phase)) restPhase();
        } else if (type === 'agent_settled') {
          const final = event.aborted || state.phase === 'stopped' ? 'stopped' : state.error || state.phase === 'error' ? 'error' : 'complete';
          for (const tool of state.tools) if (['queued','running'].includes(tool.status)) { tool.status = 'stopped'; tool.endedAt = now(); decorate(tool); }
          setPhase(final); state.settled = true; current = null; blocks.clear();
          activity(type, state.label, state.icon);
        } else if (type === 'compaction_start' || type === 'auto_compaction_start' || type === 'summarization_retry_attempt_start') {
          setPhase('compacting'); activity(type, state.label, state.icon);
        } else if (type === 'compaction_end' || type === 'auto_compaction_end') {
          if (event.errorMessage && !event.willRetry) { state.error = textValue(event.errorMessage); setPhase('error'); }
          else if (event.willRetry) setPhase('retrying');
          else restPhase();
        } else if (type === 'auto_retry_start' || type === 'summarization_retry_scheduled') {
          setPhase('retrying'); activity(type, state.label, state.icon);
        } else if (type === 'auto_retry_end') {
          if (event.success === false) { state.error = textValue(event.finalError) || 'Retry failed.'; setPhase('error'); }
          else { state.error = null; restPhase(); }
        } else if (type === 'summarization_retry_finished' || type === 'ui_prompt_end') restPhase();
        else if (type === 'ui_prompt_start') { setPhase('approval'); activity(type, 'Waiting for your response', 'shield-check'); }
        else if (type === 'extension_error') { state.error = textValue(event.error) || 'An extension reported an error.'; setPhase('error'); activity(type, state.label, state.icon); }
        // turn_end records a boundary, not final settlement.
      }
      state.sequence += 1;
      const next = publish();
      if (previousText !== state.textRevision) options.onText?.(state.text, next);
      return true;
    }
    return Object.freeze({
      receive,
      getState: snapshot,
      subscribe(listener) { if (destroyed || typeof listener !== 'function') return () => {}; listeners.add(listener); listener(snapshot()); return () => listeners.delete(listener); },
      reset() { if (destroyed) return false; state = initial(state.runId + 1); started = false; current = null; blocks.clear(); completedMessages.clear(); lastTerminal = null; messageBoundary++; publish(); return true; },
      destroy() { if (destroyed) return; destroyed = true; listeners.clear(); current = null; blocks.clear(); completedMessages.clear(); lastTerminal = null; }
    });
  }

  window.AthenaPiActivity = Object.freeze({ phase, phaseIcon, toolPresentation, iconHTML, create, toolNames: Object.freeze(['read','bash','powershell','edit','write','grep','find','ls']) });
})();
