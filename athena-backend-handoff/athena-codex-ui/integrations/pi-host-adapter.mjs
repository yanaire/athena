/**
 * SDK host bridge for Athena. No SDK imports, process creation, network setup or
 * credential reads occur here. The caller supplies its already-created Pi objects.
 *
 * Verified against @earendil-works/pi-coding-agent 1.5.2, commit
 * 653f332b6fe22e2e927dd3d553d20234a3de27f0:
 * packages/coding-agent/src/modes/rpc/{rpc-types,rpc-mode}.ts
 * packages/coding-agent/src/core/{agent-session,agent-session-runtime}.ts
 *
 * Usage:
 *   const adapter = createPiHostAdapter({ runtime, SessionManager });
 *   const detach = AthenaApp.attachPiSession(adapter);
 *
 * Native extensions are opt-in and are bound by the host, not this constructor:
 *   await runtime.session.bindExtensions({
 *     ...existingBindings, ...adapter.extensionBindings
 *   });
 * Pass options.theme when extensions use the native Pi theme API.
 *
 * The runtime's setRebindSession is a SINGLE hook. By default it is not touched.
 * Call adapter.refreshSession() from the host's existing rebind hook, provide
 * subscribeSessionChanges(callback), or explicitly set ownsRuntimeRebind:true.
 * The last choice declares that this adapter exclusively owns the hook until
 * destroy(). onRebind(session, adapter) may perform the host's normal rebind work.
 *
 * Session replacement commands always rebind after they finish, even without
 * owning the hook. destroy() only detaches this bridge; it never aborts or disposes
 * the caller's session. No terminal-only UI is emulated.
 */
let adapterSequence = 0;
const DEFAULT_MESSAGE_LIMIT = 262144;

export const PI_RPC_COMMANDS = Object.freeze([
  'prompt', 'steer', 'follow_up', 'abort', 'clear_queue', 'new_session',
  'get_state', 'set_model', 'cycle_model', 'get_available_models',
  'set_thinking_level', 'cycle_thinking_level', 'get_available_thinking_levels',
  'set_steering_mode', 'set_follow_up_mode', 'compact', 'set_auto_compaction',
  'set_auto_retry', 'abort_retry', 'bash', 'abort_bash', 'get_session_stats',
  'export_html', 'switch_session', 'fork', 'clone', 'get_fork_messages',
  'get_entries', 'get_tree', 'get_last_assistant_text', 'set_session_name',
  'get_messages', 'get_commands'
]);

export const PI_HOST_COMMANDS = Object.freeze([
  'list_sessions', 'get_context_usage', 'get_tools', 'set_active_tools',
  'navigate_tree', 'reload', 'get_resources', 'import_session',
  'set_session_label', 'export_jsonl', 'abort_compaction',
  'abort_branch_summary', 'get_system_prompt', 'get_scoped_models',
  'set_scoped_models', 'get_cache_warming', 'set_cache_warming', 'get_settings'
]);

const hasMethod = (value, name) => Boolean(value && typeof value[name] === 'function');
const hasProperty = (value, name) => Boolean(value && name in value);
const secretKey = /^(?:__proto__|prototype|constructor|headers|authorization|cookie|set-cookie|credentials?|auth|env|environment)$/i;
const secretFragment = /api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|secret/i;

function safeUrl(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return value;
  try {
    const url = new URL(value);
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    return url.toString();
  } catch { return value; }
}

/** JSON-safe public projection. Actual SDK arguments are never run through this. */
function publicValue(value, seen = new WeakSet()) {
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return undefined;
  if (seen.has(value)) return undefined;
  if (value instanceof Date) return value.toISOString();
  if (value.type === 'thinking') return { type: 'thinking', thinking: '', redacted: true };
  if (typeof value.type === 'string' && value.type.startsWith('thinking_')) {
    return {
      type: value.type,
      ...(Number.isInteger(value.contentIndex) ? { contentIndex: value.contentIndex } : {}),
      ...(typeof value.delta === 'string' ? { characterCount: value.delta.length } : {})
    };
  }
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map(item => publicValue(item, seen)).filter(item => item !== undefined);
  } else {
    result = {};
    for (const [key, item] of Object.entries(value)) {
      if (secretKey.test(key) || secretFragment.test(key)) continue;
      const clean = /^(?:baseUrl|base_url|endpoint|httpProxy|proxyUrl|url)$/i.test(key)
        && typeof item === 'string' ? safeUrl(item) : publicValue(item, seen);
      if (clean !== undefined) result[key] = clean;
    }
  }
  seen.delete(value);
  return result;
}

function stringField(value, name, { optional = false, blank = false } = {}) {
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'string' || (!blank && !value.trim())) throw new TypeError(name + ' must be a string' + (blank ? '.' : ' with a value.'));
  return value;
}
function boolField(value, name, optional = false) {
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'boolean') throw new TypeError(name + ' must be a boolean.');
  return value;
}
function enumField(value, allowed, name) {
  if (!allowed.includes(value)) throw new TypeError(name + ' must be one of: ' + allowed.join(', ') + '.');
  return value;
}
function stringList(value, name) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new TypeError(name + ' must be an array of strings.');
  return [...value];
}
function imagesField(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(image => !image || image.type !== 'image' || typeof image.data !== 'string' || typeof image.mimeType !== 'string')) {
    throw new TypeError('images must contain ImageContent objects.');
  }
  return value.map(image => ({ type: 'image', data: image.data, mimeType: image.mimeType }));
}
function fileReferencesField(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError('fileReferences must be an array.');
  return value.map(ref => {
    if (!ref || typeof ref.id !== 'string' || !ref.id || typeof ref.name !== 'string' || typeof ref.mimeType !== 'string' || !Number.isSafeInteger(ref.size) || ref.size < 0 || (ref.projectId !== null && typeof ref.projectId !== 'string') || (ref.versionId != null && typeof ref.versionId !== 'string')) throw new TypeError('Invalid file reference.');
    return { id: ref.id, projectId: ref.projectId, name: ref.name, mimeType: ref.mimeType, size: ref.size, ...(ref.versionId == null ? {} : { versionId: ref.versionId }) };
  });
}
function modelProjection(model) {
  if (!model) return undefined;
  const result = {};
  for (const key of ['id', 'name', 'api', 'provider', 'baseUrl', 'reasoning', 'input', 'contextWindow', 'maxTokens', 'cost']) {
    if (model[key] !== undefined) result[key] = key === 'baseUrl' ? safeUrl(model[key]) : publicValue(model[key]);
  }
  return result;
}
function scopedProjection(item) {
  return {
    provider: item.model.provider, modelId: item.model.id,
    thinkingLevel: item.thinkingLevel, model: modelProjection(item.model)
  };
}
function errorMessage(error) {
  return String(error?.message || error || 'The Pi host action failed.')
    .replace(/(Bearer\s+)[^\s"',]+/gi, '$1[redacted]')
    .replace(/([?&](?:api[-_]?key|access[-_]?token|token|secret)=)[^&\s]+/gi, '$1[redacted]');
}
function resourceKeys(value) {
  return value instanceof Map ? [...value.keys()].map(String) : value && typeof value === 'object' ? Object.keys(value) : [];
}

/**
 * @param {object} options
 * @param {object} [options.runtime] Current official AgentSessionRuntime.
 * @param {object} [options.session] AgentSession for hosts without a runtime.
 * @param {object} [options.sessionManager] Explicit manager fallback.
 * @param {object} [options.SessionManager] SDK class with static list/listAll.
 * @param {object} [options.modelRuntime] Explicit runtime catalogue fallback.
 * @param {object} [options.modelRegistry] SDK ModelRegistry fallback.
 * @param {object} [options.resourceLoader] Explicit resource loader fallback.
 * @param {object} [options.settingsManager] Explicit settings fallback.
 * @param {boolean} [options.ownsRuntimeRebind=false] Exclusive hook ownership.
 * @param {function} [options.subscribeSessionChanges] Host event subscription.
 * @param {function} [options.onRebind] Extra work for the exclusively owned hook.
 * @param {object} [options.theme] Native Pi theme passed through to extensions.
 * @param {object} [options.fileService] Explicit host file store; no browser file is stored automatically.
 * @param {number} [options.maxMessageCharacters=262144] UTF-16 code unit transport limit; excess is rejected intact.
 * @returns {object} Stable request/event bridge; capability getter is live.
 */
export function createPiHostAdapter(options = {}) {
  if (options.ownsRuntimeRebind === true && !hasMethod(options.runtime, 'setRebindSession')) {
    throw new TypeError('ownsRuntimeRebind requires runtime.setRebindSession.');
  }
  const maxMessageCharacters = options.maxMessageCharacters ?? DEFAULT_MESSAGE_LIMIT;
  if (!Number.isSafeInteger(maxMessageCharacters) || maxMessageCharacters < 1) throw new TypeError('maxMessageCharacters must be a positive integer.');
  let destroyed = false;
  let destroying = false;
  let boundSession;
  let generation = 0;
  let unsubscribeSession;
  let unsubscribeChanges;
  let ownsHook = false;
  let nextDialog = 0;
  const listeners = new Set();
  const dialogs = new Map();
  const prefix = 'athena-pi-ui-' + (++adapterSequence) + '-';
  const runtime = options.runtime;
  const current = () => runtime?.session || options.session;
  const manager = () => current()?.sessionManager || options.sessionManager;
  const resources = () => current()?.resourceLoader || options.resourceLoader || runtime?.services?.resourceLoader;
  const settings = () => current()?.settingsManager || options.settingsManager || runtime?.services?.settingsManager;
  const models = () => current()?.modelRuntime || options.modelRuntime || runtime?.services?.modelRuntime;
  const registry = () => options.modelRegistry || runtime?.services?.modelRegistry;
  const allAvailableModels = () => hasMethod(models(), 'getAvailableSnapshot')
    ? models().getAvailableSnapshot() : registry().getAvailable();
  const canListModels = () => hasMethod(models(), 'getAvailableSnapshot') || hasMethod(registry(), 'getAvailable');
  function checkedMessage(value) {
    const message = stringField(value, 'message', { blank: true });
    if (message.length > maxMessageCharacters) throw new RangeError('The message exceeds this host’s ' + maxMessageCharacters + ' character limit (' + message.length + ' UTF-16 code units). Nothing was sent; retain the full draft and attachments.');
    return message;
  }
  async function preparePrompt(command) {
    let message = checkedMessage(command.message), images = imagesField(command.images);
    const references = fileReferencesField(command.fileReferences);
    if (!references.length) return { message, images };
    if (!hasMethod(options.fileService, 'resolveReferences')) throw new Error('This host has no file-reference resolver. Nothing was sent.');
    const token = generation, session = current();
    const resolved = await options.fileService.resolveReferences(references, { sessionId: session?.sessionId ?? null, command: command.type });
    if (destroyed || token !== generation || session !== current()) throw new Error('The session changed while file references were being resolved. Nothing was sent.');
    if (!resolved || typeof resolved.contextText !== 'string' || !Array.isArray(resolved.resolvedIds) || references.some(ref => !resolved.resolvedIds.includes(ref.id))) throw new Error('The file service did not resolve every attachment. Nothing was sent.');
    const resolvedImages = imagesField(resolved.images);
    if (!resolved.contextText.trim() && !resolvedImages?.length) throw new Error('The file service did not provide readable attachment context. Nothing was sent.');
    message = checkedMessage(message + (resolved.contextText ? '\n\n' + resolved.contextText : ''));
    if (resolvedImages?.length) images = [...(images || []), ...resolvedImages];
    return { message, images };
  }

  function emit(event) {
    if (destroyed) return;
    const clean = publicValue(event);
    for (const listener of [...listeners]) {
      try { listener(clean); } catch (error) { options.onListenerError?.(error); }
    }
  }

  function resolveDialog(id, result, reason = 'response') {
    const record = dialogs.get(id);
    if (!record) return false;
    dialogs.delete(id);
    if (record.timer !== undefined) clearTimeout(record.timer);
    record.signal?.removeEventListener('abort', record.onAbort);
    record.resolve(result);
    emit({ type: 'extension_ui_resolved', id, method: record.method, reason, cancelled: result === undefined || (record.method === 'confirm' && result === false) });
    return true;
  }

  function cancelDialogs(reason) {
    for (const [id, dialog] of [...dialogs]) resolveDialog(id, dialog.method === 'confirm' ? false : undefined, reason);
  }

  function refreshSession(nextSession = current()) {
    if (destroyed || nextSession === boundSession) return;
    const previous = boundSession;
    generation++;
    unsubscribeSession?.();
    unsubscribeSession = undefined;
    boundSession = nextSession;
    cancelDialogs('session-changed');
    if (hasMethod(nextSession, 'subscribe')) {
      const token = generation;
      const cleanup = nextSession.subscribe(event => {
        if (!destroyed && token === generation && boundSession === nextSession) emit(event);
      });
      if (typeof cleanup === 'function') unsubscribeSession = cleanup;
    }
    if (previous) emit({ type: 'host_session_changed', sessionId: nextSession?.sessionId, capabilities: capabilities() });
  }

  function capabilities() {
    if (destroyed || destroying) return [];
    const s = current();
    const m = manager();
    const r = resources();
    const direct = {
      prompt: 'prompt', steer: 'steer', follow_up: 'followUp', abort: 'abort',
      clear_queue: 'clearQueue', cycle_model: 'cycleModel',
      set_thinking_level: 'setThinkingLevel', cycle_thinking_level: 'cycleThinkingLevel',
      get_available_thinking_levels: 'getAvailableThinkingLevels',
      set_steering_mode: 'setSteeringMode', set_follow_up_mode: 'setFollowUpMode',
      compact: 'compact', set_auto_compaction: 'setAutoCompactionEnabled',
      set_auto_retry: 'setAutoRetryEnabled', abort_retry: 'abortRetry',
      bash: 'executeBash', abort_bash: 'abortBash', get_session_stats: 'getSessionStats',
      export_html: 'exportToHtml', get_fork_messages: 'getUserMessagesForForking',
      get_last_assistant_text: 'getLastAssistantText', set_session_name: 'setSessionName',
      get_context_usage: 'getContextUsage', set_active_tools: 'setActiveToolsByName',
      navigate_tree: 'navigateTree', reload: 'reload', export_jsonl: 'exportToJsonl',
      abort_compaction: 'abortCompaction', abort_branch_summary: 'abortBranchSummary',
      set_scoped_models: 'setScopedModels', set_cache_warming: 'setCacheWarmingMode'
    };
    const result = new Set(Object.entries(direct).filter(([, method]) => hasMethod(s, method)).map(([name]) => name));
    if (s) result.add('get_state');
    if (hasProperty(s, 'messages')) result.add('get_messages');
    if (hasProperty(s, 'systemPrompt')) result.add('get_system_prompt');
    if (hasProperty(s, 'scopedModels')) result.add('get_scoped_models');
    if (hasProperty(s, 'cacheWarmingStatus') || hasMethod(settings(), 'getCacheWarmingMode')) result.add('get_cache_warming');
    if (canListModels()) {
      result.add('get_available_models');
      if (hasMethod(s, 'setModel')) result.add('set_model');
    } else result.delete('set_scoped_models');
    if (hasMethod(runtime, 'newSession')) result.add('new_session');
    if (hasMethod(runtime, 'switchSession')) result.add('switch_session');
    if (hasMethod(runtime, 'fork')) {
      result.add('fork');
      if (hasMethod(m, 'getLeafId')) result.add('clone');
    }
    if (hasMethod(runtime, 'importFromJsonl')) result.add('import_session');
    if (hasMethod(m, 'getEntries') && hasMethod(m, 'getLeafId')) result.add('get_entries');
    if (hasMethod(m, 'getTree') && hasMethod(m, 'getLeafId')) result.add('get_tree');
    if (hasMethod(m, 'appendLabelChange')) result.add('set_session_label');
    if (hasMethod(options.SessionManager, 'list') || hasMethod(options.SessionManager, 'listAll')) result.add('list_sessions');
    if (['getExtensions', 'getSkills', 'getPrompts', 'getThemes', 'getAgentsFiles'].some(method => hasMethod(r, method))) result.add('get_resources');
    if (hasMethod(s?.extensionRunner, 'getRegisteredCommands') || hasProperty(s, 'promptTemplates') || hasMethod(r, 'getSkills')) result.add('get_commands');
    if (hasMethod(s, 'getAllTools')) result.add('get_tools');
    if (hasMethod(settings(), 'getSettings')) result.add('get_settings');
    return [...PI_RPC_COMMANDS, ...PI_HOST_COMMANDS].filter(command => result.has(command));
  }

  function getState() {
    const s = current();
    const result = { model: modelProjection(s.model) };
    for (const name of ['thinkingLevel', 'isStreaming', 'isCompacting', 'steeringMode', 'followUpMode', 'sessionFile', 'sessionId', 'sessionName', 'autoCompactionEnabled', 'pendingMessageCount']) {
      if (s[name] !== undefined) result[name] = s[name];
    }
    if (Array.isArray(s.messages)) result.messageCount = s.messages.length;
    // Actual native getters, never guessed from the RPC default settings.
    for (const name of ['isIdle', 'isRetrying', 'autoRetryEnabled', 'isBashRunning', 'retryAttempt']) {
      if (s[name] !== undefined) result[name] = s[name];
    }
    return result;
  }

  function toolState() {
    const s = current();
    return {
      tools: s.getAllTools(),
      activeTools: hasMethod(s, 'getActiveToolNames') ? s.getActiveToolNames() : undefined,
      callableTools: hasMethod(s, 'getCallableToolNames') ? s.getCallableToolNames() : undefined
    };
  }

  function commandList() {
    const s = current();
    const result = [];
    if (hasMethod(s?.extensionRunner, 'getRegisteredCommands')) {
      for (const command of s.extensionRunner.getRegisteredCommands()) {
        result.push({ name: command.invocationName, description: command.description, source: 'extension', sourceInfo: command.sourceInfo });
      }
    }
    for (const template of s?.promptTemplates || []) {
      result.push({ name: template.name, description: template.description, source: 'prompt', sourceInfo: template.sourceInfo });
    }
    if (hasMethod(resources(), 'getSkills')) {
      for (const skill of resources().getSkills().skills) {
        result.push({ name: 'skill:' + skill.name, description: skill.description, source: 'skill', sourceInfo: skill.sourceInfo });
      }
    }
    return { commands: result };
  }

  function resourceState() {
    const loader = resources();
    const result = { skills: [], prompts: [], extensions: [], themes: [], contextFiles: [], diagnostics: [] };
    for (const [method, key] of [['getSkills', 'skills'], ['getPrompts', 'prompts'], ['getThemes', 'themes'], ['getAgentsFiles', 'contextFiles']]) {
      if (hasMethod(loader, method)) {
        const loaded = loader[method]();
        result[key] = loaded[key === 'contextFiles' ? 'agentsFiles' : key] || [];
        for (const diagnostic of loaded.diagnostics || []) result.diagnostics.push({ resource: key, ...diagnostic });
      }
    }
    if (hasMethod(loader, 'getExtensions')) {
      const loaded = loader.getExtensions();
      result.extensions = (loaded.extensions || []).map(extension => ({
          path: extension.path, resolvedPath: extension.resolvedPath,
          hidden: extension.hidden, replaceable: extension.replaceable,
          sourceInfo: extension.sourceInfo, tools: resourceKeys(extension.tools),
          commands: resourceKeys(extension.commands), flags: resourceKeys(extension.flags),
          events: resourceKeys(extension.handlers)
        }));
      for (const error of loaded.errors || []) result.diagnostics.push({ resource: 'extensions', severity: 'error', ...error });
      for (const warning of loaded.warnings || []) result.diagnostics.push({ resource: 'extensions', severity: 'warning', ...warning });
    }
    if (hasMethod(loader, 'getSystemPromptSource')) result.systemPromptSource = loader.getSystemPromptSource();
    if (hasMethod(loader, 'getAppendSystemPromptSources')) result.appendSystemPromptSources = loader.getAppendSystemPromptSources();
    return result;
  }

  async function chooseModel(provider, modelId) {
    stringField(provider, 'provider');
    stringField(modelId, 'modelId');
    const available = await allAvailableModels();
    const found = available.find(model => model.provider === provider && model.id === modelId);
    if (!found) throw new Error('Model not available: ' + provider + '/' + modelId);
    return found;
  }

  async function promptAccepted(command) {
    const s = current();
    const { message: text, images } = await preparePrompt(command);
    if (s !== current() || destroyed) throw new Error('The session changed before this message was submitted. Nothing was sent.');
    const behavior = command.streamingBehavior === undefined ? undefined
      : enumField(command.streamingBehavior, ['steer', 'followUp'], 'streamingBehavior');
    return new Promise((resolve, reject) => {
      let accepted = false;
      const preflightResult = disposition => {
        accepted = true;
        resolve({ disposition: enumField(disposition, ['started', 'queued', 'handled'], 'disposition') });
      };
      let run;
      try { run = s.prompt(text, { images, streamingBehavior: behavior, source: 'rpc', preflightResult }); }
      catch (error) { reject(error); return; }
      Promise.resolve(run).then(() => {
        // Official 1.5.2 calls preflightResult. Older compatible facades can
        // complete without it; do not invent a started/handled disposition.
        if (!accepted) resolve({ completed: true });
      }, error => {
        if (!accepted) reject(error);
        else emit({ type: 'host_error', command: 'prompt', error: errorMessage(error) });
      });
    });
  }

  async function dispatch(command) {
    const s = current();
    const m = manager();
    const type = command.type;
    switch (type) {
      case 'prompt': return promptAccepted(command);
      case 'steer':
      case 'follow_up': {
        const prepared = await preparePrompt(command);
        if (s !== current() || destroyed) throw new Error('The session changed before this message was submitted. Nothing was sent.');
        const disposition = await s[type === 'steer' ? 'steer' : 'followUp'](
          prepared.message, prepared.images, { source: 'rpc' });
        return { disposition };
      }
      case 'abort': await s.abort(); return;
      case 'clear_queue': return s.clearQueue();
      case 'new_session': return runtime.newSession(command.parentSession === undefined ? undefined : { parentSession: stringField(command.parentSession, 'parentSession') });
      case 'get_state': return getState();
      case 'get_messages': return { messages: s.messages };
      case 'set_model': {
        const model = await chooseModel(command.provider, command.modelId);
        const persist = boolField(command.persist, 'persist', true);
        await s.setModel(model, persist === undefined ? {} : { persist });
        return modelProjection(s.model || model);
      }
      case 'cycle_model': {
        const direction = command.direction === undefined ? 'forward' : enumField(command.direction, ['forward', 'backward'], 'direction');
        const persist = boolField(command.persist, 'persist', true);
        const result = await s.cycleModel(direction, persist === undefined ? {} : { persist });
        return result ? { ...result, model: modelProjection(result.model) } : null;
      }
      case 'get_available_models': return { models: (await allAvailableModels()).map(modelProjection) };
      case 'set_thinking_level': {
        const level = enumField(command.level, ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], 'level');
        if (hasMethod(s, 'getAvailableThinkingLevels') && !s.getAvailableThinkingLevels().includes(level)) throw new Error('Thinking level is not supported by the current model: ' + level);
        const persist = boolField(command.persist, 'persist', true);
        s.setThinkingLevel(level, persist === undefined ? {} : { persist }); return;
      }
      case 'cycle_thinking_level': {
        const level = s.cycleThinkingLevel(); return level === undefined ? null : { level };
      }
      case 'get_available_thinking_levels': return { levels: s.getAvailableThinkingLevels() };
      case 'set_steering_mode': s.setSteeringMode(enumField(command.mode, ['all', 'one-at-a-time'], 'mode')); return;
      case 'set_follow_up_mode': s.setFollowUpMode(enumField(command.mode, ['all', 'one-at-a-time'], 'mode')); return;
      case 'compact': return s.compact(stringField(command.customInstructions, 'customInstructions', { optional: true, blank: true }));
      case 'set_auto_compaction': s.setAutoCompactionEnabled(boolField(command.enabled, 'enabled')); return;
      case 'set_auto_retry': s.setAutoRetryEnabled(boolField(command.enabled, 'enabled')); return;
      case 'abort_retry': s.abortRetry(); return;
      case 'bash': {
        const text = stringField(command.command, 'command');
        const excludeFromContext = boolField(command.excludeFromContext, 'excludeFromContext', true);
        const runner = s.extensionRunner;
        const intercepted = hasMethod(runner, 'emitUserBash') ? await runner.emitUserBash({
          type: 'user_bash', command: text, excludeFromContext: excludeFromContext ?? false,
          cwd: hasMethod(m, 'getCwd') ? m.getCwd() : options.cwd
        }) : undefined;
        if (intercepted?.result) {
          if (!hasMethod(s, 'recordBashResult')) throw new Error('The host cannot record an extension-handled shell result.');
          s.recordBashResult(text, intercepted.result, { excludeFromContext });
          return intercepted.result;
        }
        return s.executeBash(text, undefined, { excludeFromContext, id: command.id, operations: intercepted?.operations });
      }
      case 'abort_bash': s.abortBash(); return;
      case 'get_session_stats': return s.getSessionStats();
      case 'export_html': return { path: await s.exportToHtml(stringField(command.outputPath, 'outputPath', { optional: true })) };
      case 'switch_session': return runtime.switchSession(stringField(command.sessionPath, 'sessionPath'));
      case 'fork': {
        const result = await runtime.fork(stringField(command.entryId, 'entryId'));
        return { text: result.selectedText, cancelled: result.cancelled };
      }
      case 'clone': {
        const leafId = m.getLeafId();
        if (!leafId) throw new Error('Cannot clone session: no current entry selected');
        const result = await runtime.fork(leafId, { position: 'at' });
        return { cancelled: result.cancelled };
      }
      case 'get_fork_messages': return { messages: s.getUserMessagesForForking() };
      case 'get_entries': {
        let entries = m.getEntries();
        if (command.since !== undefined) {
          const since = stringField(command.since, 'since');
          const index = entries.findIndex(entry => entry.id === since);
          if (index < 0) throw new Error('Entry not found: ' + since);
          entries = entries.slice(index + 1);
        }
        return { entries, leafId: m.getLeafId() };
      }
      case 'get_tree': return { tree: m.getTree(), leafId: m.getLeafId() };
      case 'get_last_assistant_text': return { text: s.getLastAssistantText() ?? null };
      case 'set_session_name': s.setSessionName(stringField(command.name, 'name').trim()); return;
      case 'get_commands': return commandList();
      case 'get_context_usage': return { contextUsage: s.getContextUsage() ?? null };
      case 'get_tools': return toolState();
      case 'set_active_tools':
        s.setActiveToolsByName(stringList(command.toolNames, 'toolNames'));
        return hasMethod(s, 'getAllTools') ? toolState() : undefined;
      case 'navigate_tree': {
        const args = {};
        for (const key of ['summarize', 'replaceInstructions']) if (command[key] !== undefined) args[key] = boolField(command[key], key);
        for (const key of ['customInstructions', 'label']) if (command[key] !== undefined) args[key] = stringField(command[key], key, { blank: true });
        return s.navigateTree(stringField(command.targetId, 'targetId'), args);
      }
      case 'reload': await s.reload(); return;
      case 'get_resources': return resourceState();
      case 'import_session': return runtime.importFromJsonl(stringField(command.inputPath, 'inputPath'), stringField(command.cwdOverride, 'cwdOverride', { optional: true }));
      case 'set_session_label': {
        const entryId = stringField(command.entryId, 'entryId');
        if (hasMethod(m, 'getEntry') && !m.getEntry(entryId)) throw new Error('Entry not found: ' + entryId);
        const label = stringField(command.label, 'label', { optional: true, blank: true });
        return { entryId: m.appendLabelChange(entryId, label) };
      }
      case 'export_jsonl': return { path: s.exportToJsonl(stringField(command.outputPath, 'outputPath', { optional: true })) };
      case 'abort_compaction': s.abortCompaction(); return;
      case 'abort_branch_summary': s.abortBranchSummary(); return;
      case 'get_system_prompt': return { systemPrompt: s.systemPrompt };
      case 'get_scoped_models': return { models: s.scopedModels.map(scopedProjection) };
      case 'set_scoped_models': {
        if (!Array.isArray(command.models)) throw new TypeError('models must be an array.');
        const selected = await Promise.all(command.models.map(async item => {
          if (!item || typeof item !== 'object') throw new TypeError('Each scoped model needs provider and modelId.');
          const model = await chooseModel(item.provider, item.modelId);
          const thinkingLevel = item.thinkingLevel === undefined ? undefined
            : enumField(item.thinkingLevel, ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], 'thinkingLevel');
          return { model, thinkingLevel };
        }));
        s.setScopedModels(selected);
        return { models: selected.map(scopedProjection) };
      }
      case 'get_cache_warming': return {
        mode: hasMethod(settings(), 'getCacheWarmingMode') ? settings().getCacheWarmingMode() : undefined,
        status: s?.cacheWarmingStatus
      };
      case 'set_cache_warming': s.setCacheWarmingMode(enumField(command.mode, ['off', 'streaming', 'idle'], 'mode')); return;
      case 'get_settings': {
        const sm = settings();
        return {
          effective: sm.getSettings(),
          global: hasMethod(sm, 'getGlobalSettings') ? sm.getGlobalSettings() : undefined,
          project: hasMethod(sm, 'getProjectSettings') ? sm.getProjectSettings() : undefined
        };
      }
      case 'list_sessions': {
        const all = boolField(command.all, 'all', true) ?? false;
        const sessionDir = stringField(command.sessionDir, 'sessionDir', { optional: true });
        const Class = options.SessionManager;
        if (all) {
          if (!hasMethod(Class, 'listAll')) throw new Error('Listing sessions across projects is not available in this host.');
          return { sessions: await Class.listAll(sessionDir) };
        }
        if (!hasMethod(Class, 'list')) throw new Error('Listing workspace sessions is not available in this host.');
        const cwd = command.cwd ?? (hasMethod(m, 'getCwd') ? m.getCwd() : runtime?.cwd ?? options.cwd);
        return { sessions: await Class.list(stringField(cwd, 'cwd'), sessionDir) };
      }
      default: throw new Error('Unsupported Pi host command: ' + type);
    }
  }

  async function request(command) {
    const type = typeof command?.type === 'string' ? command.type : 'unknown';
    const id = typeof command?.id === 'string' ? command.id : undefined;
    const response = { ...(id === undefined ? {} : { id }), type: 'response', command: type };
    try {
      if (destroyed || destroying) throw new Error('The Pi host adapter is detached.');
      if (!command || typeof command !== 'object' || Array.isArray(command)) throw new TypeError('A command object is required.');
      if (command.id !== undefined && typeof command.id !== 'string') throw new TypeError('id must be a string.');
      refreshSession();
      if (!capabilities().includes(type)) throw new Error('This Pi host does not support ' + type + '.');
      const data = await dispatch(command);
      return { ...response, success: true, ...(data === undefined ? {} : { data: publicValue(data) }) };
    } catch (error) {
      return { ...response, success: false, error: errorMessage(error) };
    } finally {
      if (!destroyed) refreshSession();
    }
  }

  function dialog(method, payload, opts = {}) {
    if (destroyed || destroying || opts.signal?.aborted) return Promise.resolve(method === 'confirm' ? false : undefined);
    const id = prefix + (++nextDialog);
    const timeout = opts.timeout;
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout < 0)) return Promise.reject(new TypeError('Dialog timeout must be a nonnegative number.'));
    const message = { type: 'extension_ui_request', id, method, ...payload, ...(timeout === undefined ? {} : { timeout }) };
    return new Promise(resolve => {
      const record = { method, message, resolve, signal: opts.signal, timer: undefined, onAbort: undefined };
      record.onAbort = () => resolveDialog(id, method === 'confirm' ? false : undefined, 'abort');
      dialogs.set(id, record);
      if (timeout !== undefined) record.timer = setTimeout(() => resolveDialog(id, method === 'confirm' ? false : undefined, 'timeout'), timeout);
      opts.signal?.addEventListener('abort', record.onAbort, { once: true });
      emit(message);
    });
  }

  function notice(method, payload) {
    if (!destroyed && !destroying) emit({ type: 'extension_ui_request', id: prefix + (++nextDialog), method, ...payload });
  }

  const uiContext = {
    select: (title, values, opts) => dialog('select', { title: String(title), options: stringList(values, 'options') }, opts),
    confirm: (title, message, opts) => dialog('confirm', { title: String(title), message: String(message) }, opts),
    input: (title, placeholder, opts) => dialog('input', { title: String(title), placeholder }, opts),
    editor: (title, prefill) => dialog('editor', { title: String(title), prefill }),
    notify: (message, type = 'info') => notice('notify', { message: String(message), notifyType: enumField(type, ['info', 'warning', 'error'], 'notifyType') }),
    setStatus: (key, text) => notice('setStatus', { statusKey: String(key), statusText: text }),
    setWidget: (key, content, widgetOptions = {}) => {
      if (content !== undefined && !Array.isArray(content)) return;
      notice('setWidget', {
        widgetKey: String(key), widgetLines: content === undefined ? undefined : stringList(content, 'widgetLines'),
        widgetPlacement: widgetOptions.placement === undefined ? 'aboveEditor' : enumField(widgetOptions.placement, ['aboveEditor', 'belowEditor'], 'placement')
      });
    },
    setTitle: title => notice('setTitle', { title: String(title) }),
    setEditorText: text => notice('set_editor_text', { text: String(text) }),
    pasteToEditor: text => notice('set_editor_text', { text: String(text) }),
    getEditorText: () => typeof options.getEditorText === 'function' ? String(options.getEditorText()) : '',
    get theme() { return options.theme; },
    // RPC-like primitive UI: TUI component factories and terminal input are not
    // executable browser UI and are deliberately not represented as supported.
    custom: async () => undefined,
    onTerminalInput: () => () => {},
    setWorkingMessage() {}, setWorkingVisible() {}, setWorkingIndicator() {},
    setHiddenThinkingLabel() {}, setFooter() {}, setHeader() {},
    addAutocompleteProvider() {}, setEditorComponent() {}, setToolsExpanded() {},
    getEditorComponent: () => undefined,
    getToolsExpanded: () => false,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: 'Theme switching requires the native host theme adapter.' })
  };

  function send(response) {
    if (destroyed || !response || response.type !== 'extension_ui_response' || typeof response.id !== 'string') return false;
    const record = dialogs.get(response.id);
    if (!record) return false;
    if (response.cancelled === true) return resolveDialog(response.id, record.method === 'confirm' ? false : undefined);
    if (record.method === 'confirm') {
      if (typeof response.confirmed !== 'boolean') return false;
      return resolveDialog(response.id, response.confirmed);
    }
    if (typeof response.value !== 'string') return false;
    if (record.method === 'select' && !record.message.options.includes(response.value)) return false;
    return resolveDialog(response.id, response.value);
  }

  const reportExtensionError = error => emit({
    type: 'extension_error', extensionPath: error?.extensionPath,
    event: error?.event, error: errorMessage(error?.error || error)
  });

  const adapter = {
    mode: 'host',
    inputContract: Object.freeze({ maxMessageCharacters, lengthUnit: 'utf16-code-units' }),
    get supportsFileReferences() { return hasMethod(options.fileService, 'resolveReferences'); },
    get capabilities() { return capabilities(); },
    request,
    send,
    uiContext,
    extensionBindings: { mode: 'rpc', uiContext, onError: reportExtensionError },
    reportExtensionError,
    refreshSession,
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('A listener function is required.');
      if (destroyed) return () => {};
      listeners.add(listener);
      for (const record of dialogs.values()) {
        try { listener(publicValue(record.message)); } catch (error) { options.onListenerError?.(error); }
      }
      return () => listeners.delete(listener);
    },
    destroy() {
      if (destroyed || destroying) return;
      destroying = true;
      cancelDialogs('destroy');
      destroyed = true;
      generation++;
      unsubscribeSession?.();
      unsubscribeSession = undefined;
      unsubscribeChanges?.();
      unsubscribeChanges = undefined;
      if (ownsHook) runtime.setRebindSession(undefined);
      listeners.clear();
    }
  };

  if (hasMethod(options.fileService, 'stageFiles') && hasMethod(options.fileService, 'resolveReferences')) adapter.stageFiles = async (files, context = {}) => {
    if (destroyed || destroying) throw new Error('The Pi host adapter is detached.');
    if (!Array.isArray(files) || !files.length) throw new TypeError('Choose files to store.');
    const token = generation, session = current();
    const result = await options.fileService.stageFiles(files, { ...context, sessionId: session?.sessionId ?? null });
    if (destroyed || token !== generation || session !== current()) throw new Error('The session changed while files were being stored. Nothing was sent.');
    const references = fileReferencesField(result?.fileReferences);
    if (references.length !== files.length || references.some((ref,index) => ref.projectId !== (context.projectId ?? null) || typeof files[index]?.name === 'string' && ref.name !== files[index].name || Number.isSafeInteger(files[index]?.size) && ref.size !== files[index].size)) throw new Error('The file service did not confirm every attachment in this project. Nothing was sent.');
    return { fileReferences: references };
  };

  refreshSession();
  if (typeof options.subscribeSessionChanges === 'function') {
    const cleanup = options.subscribeSessionChanges(() => refreshSession());
    if (typeof cleanup === 'function') unsubscribeChanges = cleanup;
  }
  if (options.ownsRuntimeRebind === true) {
    if (!hasMethod(runtime, 'setRebindSession')) throw new TypeError('ownsRuntimeRebind requires runtime.setRebindSession.');
    runtime.setRebindSession(async session => {
      refreshSession(session);
      if (typeof options.onRebind === 'function') await options.onRebind(session, adapter);
    });
    ownsHook = true;
  }
  return adapter;
}

export default createPiHostAdapter;
