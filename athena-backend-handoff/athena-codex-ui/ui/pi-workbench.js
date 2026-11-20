/* Pi runtime controls. This view renders a supplied capability catalog and
 * observed session state; it does not open a transport or run a local demo. */
(() => {
  'use strict';

  const MOUNTS = new WeakMap();
  const GROUPS = [
    ['session', 'Session', 'messages-square', 'Manage conversations and follow their branches.'],
    ['model', 'Model', 'cpu', 'Choose an available model and its thinking level.'],
    ['queue', 'Queue', 'list-ordered', 'Steer the current run or leave the next instruction.'],
    ['context', 'Context', 'archive', 'Manage context, compaction, and recovery.'],
    ['tools', 'Tools', 'wrench', 'Inspect active tools and run explicit commands.'],
    ['resources', 'Resources', 'library', 'Find commands, skills, prompts, and loaded resources.'],
    ['usage', 'Usage', 'chart-no-axes-combined', 'Inspect usage reported by this session.'],
    ['extensions', 'Extensions', 'plug', 'Respond to extension prompts and inspect their updates.']
  ];
  let mountNumber = 0;
  const array = value => Array.isArray(value) ? value : [];
  const plain = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const text = value => value === undefined || value === null ? '' : String(value);
  const display = value => value === undefined || value === null || value === '' ? 'Not reported' : typeof value === 'boolean' ? value ? 'On' : 'Off' : text(value);
  const safeIcon = value => /^[a-z][a-z0-9-]{0,48}$/.test(text(value)) ? value : 'circle';
  function node(tag, className, parent, content) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (content !== undefined) element.textContent = text(content);
    parent?.appendChild(element);
    return element;
  }
  function icon(name, parent) {
    const element = node('i', '', parent);
    element.dataset.lucide = safeIcon(name);
    element.setAttribute('aria-hidden', 'true');
    return element;
  }
  function button(label, glyph, parent, className = '') {
    const element = node('button', 'apw-button cursor-interaction ' + className, parent);
    element.type = 'button';
    if (glyph) icon(glyph, element);
    node('span', '', element, label);
    return element;
  }
  function printable(value, limit = 32000) {
    try {
      const serialized = typeof value === 'string' ? value : JSON.stringify(value, (key, entry) => {
        if (entry && typeof entry === 'object' && entry.type === 'thinking') return { type: 'thinking', hidden: true };
        if (key === 'thinkingSignature' || key === 'redactedThinking') return undefined;
        return entry;
      }, 2);
      const result = text(serialized);
      return result.length > limit ? result.slice(0, limit) + '\n… Display truncated.' : result;
    } catch (_) { return 'This result cannot be displayed as JSON.'; }
  }
  function messageText(message) {
    if (typeof message === 'string') return message;
    const item = plain(message?.message || message);
    if (typeof item.text === 'string') return item.text;
    if (typeof item.content === 'string') return item.content;
    return array(item.content).filter(block => block?.type === 'text').map(block => text(block.text)).join('\n');
  }
  function isFocusable(element) {
    if (!element?.isConnected || element.disabled || element.closest('[hidden]')) return false;
    for (let parent = element; parent; parent = parent.parentElement) {
      if (parent.inert) return false;
      if (parent.matches?.('details:not([open])') && !parent.querySelector('summary')?.contains(element)) return false;
    }
    return true;
  }

  function mount(host, options = {}) {
    if (!host || host.nodeType !== 1) throw new TypeError('AthenaPiWorkbench.mount needs a host element.');
    const runtime = options.runtime;
    if (!runtime?.getState || !runtime?.subscribe || !runtime?.getCatalog || !runtime?.execute) throw new TypeError('A Pi runtime controller is required.');
    MOUNTS.get(host)?.destroy();
    const prefix = 'apw-' + (++mountNumber) + '-';
    const appRoot = host.closest('#athena-codex') || host;
    const controller = new AbortController();
    const listen = (target, type, handler, settings = {}) => target.addEventListener(type, handler, { ...settings, signal: controller.signal });
    const forms = new Map();
    const panels = new Map();
    const tabs = new Map();
    let state = runtime.getState();
    let selected = 'session';
    let destroyed = false;
    let requestId = null;
    let dialogOpener = null;
    let dialogPending = false;
    let dialogVersion = 0;
    let catalog = [];
    let unsubscribe = null;
    let previousResult = '';
    let notificationsInitialized = false;
    let requestPage = 0;
    const requestKey = request => request?.requestKey || request?.id;
    const seenNotifications = new Set();
    const seenExpiredRequests = new Set();
    const respondedRequests = new Set();

    const root = node('div', 'apw-root');
    root.dataset.piWorkbench = '';
    host.replaceChildren(root);
    const heading = node('header', 'apw-heading', root);
    const headingCopy = node('div', '', heading);
    node('span', 'apw-eyebrow', headingCopy, 'CONNECTED WORKSPACE');
    node('h2', '', headingCopy, 'AI & tools');
    const refresh = button('Refresh', 'refresh-cw', heading, 'apw-refresh');
    refresh.dataset.apwRefresh = '';
    const connection = node('div', 'apw-connection', root);
    const connectionMark = node('span', 'apw-connection-mark', connection);
    connectionMark.setAttribute('aria-hidden', 'true');
    const connectionCopy = node('div', '', connection);
    const connectionLabel = node('strong', '', connectionCopy);
    const connectionDetail = node('p', '', connectionCopy);
    const error = node('p', 'apw-error', root);
    error.setAttribute('role', 'alert');
    error.hidden = true;
    const live = node('p', 'apw-sr-only', root);
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    const nav = node('div', 'apw-tabs', root);
    nav.setAttribute('role', 'tablist');
    nav.setAttribute('aria-label', 'AI and tool settings');

    for (const [id, title, glyph, description] of GROUPS) {
      const tab = button(title, glyph, nav, 'apw-tab');
      tab.id = prefix + 'tab-' + id;
      tab.dataset.apwTab = id;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', prefix + 'panel-' + id);
      tabs.set(id, tab);
      const panel = node('section', 'apw-panel', root);
      panel.id = prefix + 'panel-' + id;
      panel.dataset.apwPanel = id;
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', tab.id);
      node('p', 'apw-section-intro', panel, description);
      const overview = node('div', 'apw-overview', panel);
      overview.dataset.apwOverview = id;
      const actions = node('div', 'apw-actions', panel);
      actions.dataset.apwActions = id;
      panels.set(id, { panel, overview, actions, signature: null });
    }

    const result = node('details', 'apw-result', root);
    result.hidden = true;
    const resultSummary = node('summary', 'cursor-interaction', result);
    icon('braces', resultSummary);
    const resultLabel = node('span', '', resultSummary, 'Latest result');
    icon('chevron-down', resultSummary);
    const resultMessage = node('p', 'apw-help', result);
    const resultCode = node('pre', 'apw-code', result);
    resultCode.dataset.apwResult = '';

    const overlay = node('div', 'apw-dialog-backdrop', appRoot);
    overlay.dataset.apwDialogBackdrop = '';
    overlay.hidden = true;
    const dialog = node('section', 'apw-dialog', overlay);
    dialog.tabIndex = -1;
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', prefix + 'request-title');
    dialog.setAttribute('aria-describedby', prefix + 'request-message');
    const dialogHead = node('header', 'apw-dialog-heading', dialog);
    const dialogHeadingCopy = node('div', '', dialogHead);
    node('span', 'apw-eyebrow', dialogHeadingCopy, 'EXTENSION REQUEST');
    const dialogTitle = node('h2', '', dialogHeadingCopy);
    dialogTitle.id = prefix + 'request-title';
    const dismiss = button('Dismiss', 'x', dialogHead, 'apw-dialog-close');
    dismiss.setAttribute('aria-label', 'Dismiss extension request');
    const dialogMessage = node('p', 'apw-dialog-message', dialog);
    dialogMessage.id = prefix + 'request-message';
    const dialogMeta = node('p', 'apw-help', dialog);
    const dialogForm = node('form', 'apw-request-form', dialog);
    dialogForm.noValidate = true;
    const dialogFields = node('div', 'apw-request-fields', dialogForm);
    const dialogError = node('p', 'apw-error', dialogForm);
    dialogError.setAttribute('role', 'alert');
    dialogError.hidden = true;
    const dialogActions = node('div', 'apw-form-actions', dialogForm);
    const cancel = button('Cancel', null, dialogActions);
    const confirm = button('Send response', 'arrow-up', dialogActions, 'apw-primary');
    confirm.type = 'submit';
    let requestControl = null;

    function refreshIcons() { options.icons?.(); }
    function capability(action) {
      const item = plain(state.capabilities?.[action.id]);
      return {
        available: typeof action.available === 'boolean' ? action.available : typeof item.available === 'boolean' ? item.available : Boolean(state.connected),
        reason: text(action.reason || item.reason || (!state.connected ? 'Connect a Pi session to use this action.' : 'This connection does not expose this action.'))
      };
    }
    function changeSection(id, moveFocus = false, notify = true) {
      if (!panels.has(id)) id = 'session';
      selected = id;
      for (const [key, tab] of tabs) {
        tab.setAttribute('aria-selected', String(key === id));
        tab.tabIndex = key === id ? 0 : -1;
        panels.get(key).panel.hidden = key !== id;
      }
      renderOverview(id);
      if (notify) options.onSectionChange?.(id);
      if (moveFocus) tabs.get(id).focus({ preventScroll: true });
    }
    function overviewData(id) {
      switch (id) {
        case 'session': return [state.session, state.sessions, state.entries, state.tree, state.forkMessages, state.messages];
        case 'model': return [state.model, state.thinkingLevel, state.models, state.thinkingLevels, state.scopedModels];
        case 'queue': return [state.queues, state.clearedQueue];
        case 'context': return [state.context, state.config, state.session?.isCompacting, state.session?.isRetrying, state.retry, state.compaction, state.cacheWarming, state.systemPrompt];
        case 'tools': return [state.tools, state.activeTools];
        case 'resources': return state.resources;
        case 'usage': return [state.stats, state.context];
        default: return [state.ui, state.settings, requestPage];
      }
    }
    function facts(parent, entries) {
      const list = node('dl', 'apw-facts', parent);
      for (const [name, value] of entries) {
        const row = node('div', '', list);
        node('dt', '', row, name);
        node('dd', '', row, display(value));
      }
      return list;
    }
    function empty(parent, message) { node('p', 'apw-empty', parent, message); }
    function structuredBlock(parent, label, content) {
      if (content === undefined || content === null || content === '') return;
      const block = node('details', 'apw-list-block', parent);
      const summary = node('summary', 'cursor-interaction', block);
      node('span', '', summary, label);
      icon('chevron-down', summary);
      node('pre', 'apw-code', block, printable(content));
    }
    function listBlock(parent, label, items, render, emptyText) {
      const block = node('details', 'apw-list-block', parent);
      const summary = node('summary', 'cursor-interaction', block);
      node('span', '', summary, label);
      node('span', 'apw-count', summary, items.length);
      icon('chevron-down', summary);
      if (!items.length) { empty(block, emptyText || 'Nothing has been reported yet.'); return; }
      const list = node('ul', 'apw-list', block);
      items.slice(0, 80).forEach((item, index) => render(node('li', '', list), item, index));
      if (items.length > 80) node('p', 'apw-help', block, 'Showing the first 80 of ' + items.length + ' entries.');
    }
    function resourceRow(parent, item) {
      if (typeof item === 'string') { node('strong', '', parent, item); return; }
      const entry = plain(item);
      node('strong', '', parent, entry.name || entry.label || entry.id || entry.filePath || entry.path || 'Resource');
      if (entry.description || entry.message) node('p', 'apw-help', parent, entry.description || entry.message);
      if (entry.source || entry.origin || entry.path || entry.filePath) node('small', 'apw-path', parent, [entry.source || entry.origin, entry.path || entry.filePath].filter(Boolean).join(' · '));
      if (entry.command && options.onDraft) {
        const use = button('Use in composer', 'corner-down-left', parent, 'apw-inline-button');
        use.dataset.apwDraft = text(entry.command);
      }
    }
    function flattenTree(entries, output = [], depth = 0) {
      for (const item of array(entries)) {
        const entry = plain(item.entry || item);
        output.push({ ...entry, _depth: depth });
        if (output.length >= 200) break;
        if (Array.isArray(item.children)) flattenTree(item.children, output, Math.min(depth + 1, 8));
      }
      return output;
    }
    function renderOverview(id) {
      const section = panels.get(id);
      const signature = printable(overviewData(id), 150000);
      if (signature === section.signature) return;
      section.signature = signature;
      const expanded = new Set(Array.from(section.overview.querySelectorAll('details[open]')).map(el => el.querySelector('summary')?.textContent));
      const focus = document.activeElement?.dataset?.apwDraft;
      const target = section.overview;
      target.replaceChildren();
      const session = plain(state.session), resources = plain(state.resources), ui = plain(state.ui), queues = plain(state.queues);
      if (id === 'session') {
        facts(target, [
          ['Conversation', session.name || session.sessionName || (state.connected ? 'Untitled session' : null)],
          ['Status', !state.connected ? 'Disconnected' : session.isStreaming ? 'Responding' : session.isCompacting ? 'Compacting' : 'Ready'],
          ['Working directory', session.cwd], ['Session file', session.file || session.sessionFile], ['Session ID', session.id || session.sessionId]
        ]);
        listBlock(target, 'Saved sessions', array(state.sessions), (row, item) => {
          resourceRow(row, { name: item.name || item.sessionName || item.id || item.path || 'Untitled session', description: item.firstMessage || item.summary, path: item.path || item.sessionFile });
          const path = item.path || item.sessionFile || item.file;
          if (path) { const use = button('Choose session', 'arrow-up-right', row, 'apw-inline-button'); use.dataset.apwFillAction = 'switch_session'; use.dataset.apwFillField = 'sessionPath'; use.dataset.apwFillValue = path; }
        }, 'Available sessions appear when the connected host provides a session list.');
        const tree = array(state.tree).length ? flattenTree(state.tree) : array(state.entries);
        listBlock(target, 'Conversation tree', tree, (row, entry) => {
          const role = entry.message?.role || entry.role || entry.type || 'Entry';
          row.style.setProperty('--apw-depth', String(Math.min(Number(entry._depth) || 0, 8)));
          row.classList.add('apw-tree-entry');
          node('strong', '', row, entry.label || role);
          const content = messageText(entry);
          if (content) node('p', 'apw-message-copy', row, content.slice(0, 500));
          node('small', 'apw-path', row, entry.id || '');
          if (entry.id) { const use = button('Choose branch', 'git-branch', row, 'apw-inline-button'); use.dataset.apwFillAction = 'navigate_tree'; use.dataset.apwFillField = 'targetId'; use.dataset.apwFillValue = entry.id; }
        }, 'Load the conversation tree to inspect branches and entry IDs.');
        listBlock(target, 'Fork points', array(state.forkMessages), (row, entry) => {
          node('p', 'apw-message-copy', row, messageText(entry) || entry.text || 'User message');
          if (entry.entryId || entry.id) { const use = button('Choose fork point', 'git-fork', row, 'apw-inline-button'); use.dataset.apwFillAction = 'fork'; use.dataset.apwFillField = 'entryId'; use.dataset.apwFillValue = entry.entryId || entry.id; }
        }, 'Load user messages to choose where a new branch starts.');
        listBlock(target, 'Messages', array(state.messages), (row, entry) => {
          node('strong', '', row, entry.role || entry.message?.role || 'Message');
          node('p', 'apw-message-copy', row, messageText(entry).slice(0, 2400) || 'No visible text in this message.');
        }, 'Load messages to inspect the current session.');
      } else if (id === 'model') {
        const model = plain(state.model || session.model);
        facts(target, [['Model', model.name || model.id], ['Provider', model.provider], ['Thinking level', state.thinkingLevel], ['Available models', array(state.models).length || null], ['Context window', model.contextWindow]]);
        listBlock(target, 'Available models', array(state.models), (row, entry) => {
          node('strong', '', row, entry.name || entry.id);
          node('small', 'apw-path', row, [entry.provider, entry.id].filter(Boolean).join(' / '));
          if (entry.contextWindow) node('p', 'apw-help', row, Number(entry.contextWindow).toLocaleString() + ' context tokens' + (entry.reasoning ? ' · Supports thinking' : ''));
        }, 'Models are loaded from the connected runtime.');
        if (array(state.scopedModels).length) listBlock(target, 'Model rotation', state.scopedModels, (row, entry) => {
          const current = plain(entry.model || entry);
          node('strong', '', row, current.name || current.modelId || current.id || 'Model');
          node('small', 'apw-path', row, [current.provider, entry.thinkingLevel].filter(Boolean).join(' · '));
        });
      } else if (id === 'queue') {
        facts(target, [['Steering delivery', queues.steeringMode], ['Follow-up delivery', queues.followUpMode]]);
        listBlock(target, 'Steering messages', array(queues.steering), (row, item) => node('p', 'apw-message-copy', row, messageText(item)), 'No steering messages are waiting.');
        listBlock(target, 'Follow-up messages', array(queues.followUp), (row, item) => node('p', 'apw-message-copy', row, messageText(item)), 'No follow-up messages are waiting.');
        const cleared = plain(state.clearedQueue);
        const recovered = [...array(cleared.steering), ...array(cleared.followUp)];
        if (recovered.length) listBlock(target, 'Recently cleared messages', recovered, (row, item) => {
          const content = messageText(item);
          node('p', 'apw-message-copy', row, content);
          if (content && options.onDraft) { const restore = button('Recover to composer', 'undo-2', row, 'apw-inline-button'); restore.dataset.apwDraft = content; }
        });
      } else if (id === 'context') {
        const context = plain(state.context), config = plain(state.config);
        facts(target, [['Context tokens', context.tokens], ['Context window', context.contextWindow], ['Usage', typeof context.percent === 'number' ? context.percent.toFixed(1) + '%' : null], ['Automatic compaction', config.autoCompaction], ['Automatic retry', config.autoRetry], ['Cache warming', state.cacheWarming]]);
        if (session.isCompacting) node('p', 'apw-inline-status', target, 'Compaction is running.');
        if (session.isRetrying) node('p', 'apw-inline-status', target, 'The session is retrying a request.');
        if (state.retry) structuredBlock(target, 'Latest recovery event', state.retry);
        if (state.compaction) structuredBlock(target, 'Latest compaction', state.compaction);
        if (state.systemPrompt) structuredBlock(target, 'Effective instructions', state.systemPrompt);
      } else if (id === 'tools') {
        const active = array(state.activeTools);
        listBlock(target, 'Available tools', array(state.tools), (row, tool) => {
          const name = typeof tool === 'string' ? tool : tool.name;
          const heading = node('div', 'apw-tool-title', row);
          node('strong', '', heading, name || 'Tool');
          node('span', 'apw-badge', heading, active.includes(name) ? 'Active' : 'Available');
          if (tool.description) node('p', 'apw-help', row, tool.description);
        }, 'The connected host can report its built-in and extension tools.');
        if (!array(state.tools).length && active.length) facts(target, [['Active tools', active.join(', ')]]);
      } else if (id === 'resources') {
        const groups = [['commands', 'Commands'], ['skills', 'Skills'], ['prompts', 'Prompt templates'], ['extensions', 'Extensions'], ['themes', 'Themes'], ['contextFiles', 'Context files'], ['diagnostics', 'Diagnostics']];
        groups.forEach(([key, title]) => listBlock(target, title, array(resources[key]), resourceRow, state.connected ? 'No ' + title.toLowerCase() + ' have been reported by this connection.' : 'Connect a session to load ' + title.toLowerCase() + '.'));
      } else if (id === 'usage') {
        const stats = plain(state.stats), tokens = plain(stats.tokens), context = plain(state.context);
        facts(target, [['User messages', stats.userMessages], ['Assistant messages', stats.assistantMessages], ['Tool calls', stats.toolCalls], ['Input tokens', tokens.input ?? stats.inputTokens], ['Output tokens', tokens.output ?? stats.outputTokens], ['Cached input tokens', tokens.cacheRead ?? stats.cacheReadTokens], ['Cache write tokens', tokens.cacheWrite ?? stats.cacheWriteTokens], ['Total tokens', tokens.total ?? stats.totalTokens], ['Reported cost', typeof stats.cost === 'number' ? '$' + stats.cost.toFixed(4) : typeof stats.totalCost === 'number' ? '$' + stats.totalCost.toFixed(4) : null], ['Context usage', typeof context.percent === 'number' ? context.percent.toFixed(1) + '%' : null]]);
        node('p', 'apw-help', target, 'Usage is reported by the runtime and may vary by provider.');
      } else {
        const requests = array(ui.requests).filter(request => !request.resolved);
        requestPage = Math.max(0, Math.min(requestPage, Math.max(0, Math.ceil(requests.length / 20) - 1)));
        const requestStart = requestPage * 20;
        const pending = node('section', 'apw-pending-requests', target);
        node('h3', '', pending, 'Pending extension requests');
        node('p', 'apw-help', pending, requests.length ? 'Showing ' + (requestStart + 1) + '–' + Math.min(requestStart + 20, requests.length) + ' of ' + requests.length + '. All unanswered requests remain pending.' : 'No unanswered extension requests.');
        for (const request of requests.slice(requestStart, requestStart + 20)) {
          const row = node('div', 'apw-pending-row', pending);
          row.dataset.apwPendingRequest = text(requestKey(request));
          node('strong', '', row, request.title || request.method || 'Extension request');
          node('small', 'apw-help', row, [request.id, request.detached ? 'Previous connection · cancellation required' : request.method, request.responseError].filter(Boolean).join(' · '));
        }
        if (requests.length > 20) {
          const pages = node('div', 'apw-form-actions', pending);
          const previous = button('Previous requests', 'chevron-left', pages); previous.dataset.apwRequestPage = '-1'; previous.disabled = requestPage === 0;
          const next = button('Next requests', 'chevron-right', pages); next.dataset.apwRequestPage = '1'; next.disabled = requestStart + 20 >= requests.length;
        }
        if (ui.title) facts(target, [['Window title', ui.title]]);
        listBlock(target, 'Status messages', array(ui.statuses), (row, entry) => {
          node('strong', '', row, entry.key || entry.id || 'Status');
          node('p', 'apw-message-copy', row, entry.text || entry.status || entry.value || '');
        }, 'Extension status updates appear here.');
        listBlock(target, 'Notifications', array(ui.notifications), (row, entry) => {
          node('strong', '', row, entry.level || entry.notifyType || entry.type || 'Notification');
          node('p', 'apw-message-copy', row, entry.message || entry.text || '');
        }, 'No extension notifications.');
        listBlock(target, 'Widgets', array(ui.widgets), (row, entry) => {
          node('strong', '', row, entry.key || entry.id || 'Widget');
          const lines = entry.lines || entry.content || entry.text || entry.value;
          node('pre', 'apw-widget-copy', row, Array.isArray(lines) ? lines.join('\n') : printable(lines));
        }, 'Text widgets from extensions appear here.');
        if (ui.editorText !== undefined && ui.editorText !== null && ui.editorText !== '') {
          const draft = node('section', 'apw-editor-offer', target);
          node('h3', '', draft, 'Suggested editor text');
          node('p', 'apw-message-copy', draft, ui.editorText);
          if (options.onDraft) { const use = button('Use in composer', 'corner-down-left', draft); use.dataset.apwDraft = text(ui.editorText); }
        }
        node('p', 'apw-help', target, 'Selection, confirmation, input, and editor requests open when an extension asks for a response.');
        if (Object.keys(plain(state.settings)).length) structuredBlock(target, 'Host configuration', state.settings);
      }
      for (const details of target.querySelectorAll('details')) if (expanded.has(details.querySelector('summary')?.textContent)) details.open = true;
      if (focus) Array.from(target.querySelectorAll('[data-apw-draft]')).find(item => item.dataset.apwDraft === focus)?.focus({ preventScroll: true });
      refreshIcons();
    }

    function createAction(action) {
      const group = panels.get(action.group) || panels.get('session');
      const root = node('details', 'apw-action', group.actions);
      root.dataset.apwAction = action.id;
      const summary = node('summary', 'cursor-interaction', root);
      icon(action.icon || 'circle', summary);
      const summaryCopy = node('span', 'apw-action-heading', summary);
      const title = node('strong', '', summaryCopy, action.title);
      const description = node('small', '', summaryCopy, action.description);
      const badge = node('span', 'apw-action-state', summary);
      icon('chevron-down', summary);
      const form = node('form', 'apw-action-form', root);
      form.noValidate = true;
      form.dataset.apwForm = action.id;
      const fields = node('div', 'apw-fields', form);
      const reason = node('p', 'apw-help apw-availability', form);
      const actions = node('div', 'apw-form-actions', form);
      const response = node('p', 'apw-form-result', actions);
      response.setAttribute('role', 'status');
      const submit = button(action.submitLabel || action.title || 'Run', 'arrow-up-right', actions, 'apw-primary');
      submit.type = 'submit';
      submit.dataset.apwRun = action.id;
      const record = { root, form, fields, title, description, badge, reason, submit, response, controls: new Map(), pending: false, action };
      forms.set(action.id, record);
      return record;
    }
    function createField(record, field) {
      const wrapper = node('div', 'apw-field', record.fields);
      wrapper.dataset.apwField = field.name;
      const label = node('label', '', wrapper, field.label || field.name);
      const type = ['textarea', 'number', 'checkbox', 'select'].includes(field.type) ? field.type : 'text';
      const input = node(type === 'textarea' ? 'textarea' : type === 'select' ? 'select' : 'input', 'apw-input', wrapper);
      if (type !== 'textarea' && type !== 'select') input.type = type;
      input.id = prefix + 'field-' + record.action.id + '-' + field.name;
      input.name = field.name;
      input.dataset.apwInput = field.name;
      label.htmlFor = input.id;
      const hint = node('p', 'apw-help', wrapper);
      hint.id = input.id + '-hint';
      const fieldError = node('p', 'apw-error', wrapper);
      fieldError.id = input.id + '-error';
      fieldError.hidden = true;
      input.setAttribute('aria-describedby', hint.id + ' ' + fieldError.id);
      if (type === 'checkbox') { wrapper.classList.add('apw-checkbox-field'); input.className = 'apw-checkbox cursor-interaction'; wrapper.insertBefore(input, label); }
      if (type === 'textarea') input.rows = 3;
      const control = { wrapper, label, input, hint, error: fieldError, dirty: false, type, field, optionSignature: null };
      record.controls.set(field.name, control);
      return control;
    }
    function syncAction(action) {
      const record = forms.get(action.id) || createAction(action);
      record.action = action;
      record.title.textContent = action.title || action.id;
      record.description.textContent = action.description || '';
      const cap = capability(action);
      const busy = record.pending || array(state.busy).includes(action.id);
      const dirty = Array.from(record.controls.values()).some(control => control.dirty);
      record.badge.textContent = busy ? 'Working' : !cap.available ? state.connected ? 'Unavailable' : 'Offline' : dirty ? 'Draft' : '';
      record.badge.hidden = !record.badge.textContent;
      record.reason.textContent = cap.available ? action.hint || '' : cap.reason;
      record.reason.hidden = !record.reason.textContent;
      record.submit.disabled = !cap.available || busy;
      record.submit.querySelector('span').textContent = busy ? 'Working…' : action.submitLabel || action.title || 'Run';
      record.root.dataset.available = String(cap.available);
      record.root.dataset.dirty = String(dirty);
      record.form.setAttribute('aria-busy', String(busy));
      const seen = new Set();
      for (const field of array(action.fields)) {
        if (!field?.name) continue;
        seen.add(field.name);
        let control = record.controls.get(field.name);
        if (control && control.type !== (['textarea', 'number', 'checkbox', 'select'].includes(field.type) ? field.type : 'text')) { control.wrapper.remove(); record.controls.delete(field.name); control = null; }
        control ||= createField(record, field);
        control.field = field;
        control.label.textContent = field.label || field.name;
        control.hint.textContent = field.hint || '';
        control.hint.hidden = !control.hint.textContent;
        control.input.required = Boolean(field.required);
        control.input.disabled = busy;
        if (field.placeholder !== undefined) control.input.placeholder = text(field.placeholder);
        if (field.min !== undefined) control.input.min = text(field.min);
        if (field.max !== undefined) control.input.max = text(field.max);
        if (field.step !== undefined) control.input.step = text(field.step);
        if (field.maxLength !== undefined) control.input.maxLength = Number(field.maxLength);
        if (control.type === 'select') {
          const choices = array(field.options).map(item => typeof item === 'string' ? { value: item, label: item } : item);
          const signature = printable(choices);
          const desired = control.dirty ? control.input.value : text(field.value);
          if (signature !== control.optionSignature) {
            control.optionSignature = signature;
            control.input.replaceChildren();
            if (!choices.some(choice => text(choice.value) === '')) { const placeholder = node('option', '', control.input, 'Choose an option'); placeholder.value = ''; placeholder.disabled = Boolean(field.required); }
            for (const choice of choices) { const option = node('option', '', control.input, choice.label ?? choice.value); option.value = text(choice.value); option.disabled = Boolean(choice.disabled); }
            if (!choices.some(choice => text(choice.value) === desired) && desired) { const stale = node('option', '', control.input, desired + ' (not currently available)'); stale.value = desired; stale.disabled = true; }
            control.input.value = desired;
          }
        }
        if (!control.dirty) {
          if (control.type === 'checkbox') control.input.checked = Boolean(field.value);
          else if (control.input.value !== text(field.value)) control.input.value = text(field.value);
        }
      }
      for (const [name, control] of record.controls) if (!seen.has(name)) { control.wrapper.remove(); record.controls.delete(name); }
      return record;
    }
    function readParameters(record) {
      const params = {};
      let firstError = null;
      for (const [name, control] of record.controls) {
        const value = control.type === 'checkbox' ? control.input.checked : control.input.value;
        let message = '';
        if (control.field.required && (value === '' || value === undefined || value === null)) message = 'Enter ' + text(control.field.label || name).toLowerCase() + '.';
        if (!message && control.type === 'number' && value !== '') {
          const number = Number(value);
          if (!Number.isFinite(number)) message = 'Enter a valid number.';
          else if (control.field.min !== undefined && number < Number(control.field.min)) message = 'Use a value of at least ' + control.field.min + '.';
          else if (control.field.max !== undefined && number > Number(control.field.max)) message = 'Use a value no greater than ' + control.field.max + '.';
        }
        if (!message && control.type === 'select' && value && control.input.selectedOptions?.[0]?.disabled) message = 'Choose an available option.';
        control.error.textContent = message;
        control.error.hidden = !message;
        control.input.setAttribute('aria-invalid', String(Boolean(message)));
        if (message && !firstError) firstError = control.input;
        if (control.type === 'number') { if (value !== '') params[name] = Number(value); }
        else if (value !== '' || control.field.required || control.type === 'checkbox') params[name] = value;
      }
      if (firstError) { firstError.focus(); return null; }
      return params;
    }
    async function run(record) {
      if (destroyed || record.pending || !capability(record.action).available) return;
      const params = readParameters(record);
      if (!params) return;
      const submittedBoundFields = new Map(Array.from(record.controls).filter(([, control]) => Object.hasOwn(control.field, 'value')).map(([name, control]) => [name, control.type === 'checkbox' ? control.input.checked : control.input.value]));
      record.pending = true;
      record.response.textContent = '';
      record.response.dataset.tone = '';
      syncAction(record.action);
      try {
        const data = await runtime.execute(record.action.id, params);
        if (destroyed) return;
        const failed = data?.success === false;
        const cancelled = data?.cancelled === true || data?.canceled === true;
        if (!failed && !cancelled) {
          // A saved setting is no longer an unsaved draft. Only release the
          // exact submitted value; a newer edit or a free-text message stays.
          for (const [name, submitted] of submittedBoundFields) {
            const control = record.controls.get(name);
            if (!control) continue;
            const current = control.type === 'checkbox' ? control.input.checked : control.input.value;
            if (current === submitted) control.dirty = false;
          }
        }
        const message = failed ? text(data.error || 'The action failed.') : cancelled ? 'The action was cancelled.' : text(data?.message || 'Action completed.');
        record.response.textContent = message;
        record.response.dataset.tone = failed ? 'error' : cancelled ? '' : 'success';
        live.textContent = (record.action.title || record.action.id) + ': ' + message;
      } catch (failure) {
        if (destroyed) return;
        const message = text(failure?.message || failure || 'The action failed.');
        record.response.textContent = message;
        record.response.dataset.tone = 'error';
        live.textContent = message;
      } finally {
        record.pending = false;
        if (!destroyed) syncAction(record.action);
      }
    }

    function update(next) {
      if (destroyed) return;
      state = next || runtime.getState();
      root.dataset.connected = String(Boolean(state.connected));
      connectionLabel.textContent = state.connectionLabel || (state.connected ? 'Pi session connected' : 'No Pi session connected');
      connectionDetail.textContent = state.connected ? (state.mode === 'rpc' ? 'RPC connection · available controls follow this host.' : 'Session connection · controls use the attached runtime.') : 'Session controls become available when Athena is connected to Pi.';
      refresh.disabled = !state.connected || array(state.busy).includes('refresh');
      error.textContent = text(state.error);
      error.hidden = !state.error;
      catalog = array(runtime.getCatalog());
      const ids = new Set();
      for (const action of catalog) if (action?.id) { ids.add(action.id); syncAction(action); }
      for (const [id, record] of forms) if (!ids.has(id)) { record.root.remove(); forms.delete(id); }
      renderOverview(selected);
      const latest = state.lastResult;
      if (latest) {
        const signature = printable(latest, 64000);
        if (signature !== previousResult) {
          previousResult = signature;
          result.hidden = false;
          const action = catalog.find(item => item.id === latest.action);
          resultLabel.textContent = 'Latest result · ' + (action?.title || latest.action || 'Runtime');
          resultMessage.textContent = text(latest.message);
          resultMessage.hidden = !resultMessage.textContent;
          resultCode.textContent = printable(latest.data === undefined ? latest : latest.data);
        }
      } else { result.hidden = true; previousResult = ''; }
      for (const notification of array(state.ui?.notifications)) {
        const key = text(notification.id || notification.key || notification.at || '') + ':' + printable(notification, 8000);
        if (!seenNotifications.has(key)) {
          seenNotifications.add(key);
          if (notificationsInitialized) options.toast?.(text(notification.message || notification.text || 'Extension notification'));
        }
      }
      notificationsInitialized = true;
      if (seenNotifications.size > 200) {
        const retained = Array.from(seenNotifications).slice(-100);
        seenNotifications.clear(); retained.forEach(key => seenNotifications.add(key));
      }
      updateDialog();
      refreshIcons();
    }

    function pendingRequest() {
      return array(state.ui?.requests).find(request => request && ['select', 'confirm', 'input', 'editor'].includes(request.method) && !request.resolved && !respondedRequests.has(requestKey(request))) || null;
    }
    function closeDialog(restore = true) {
      const wasOpen = !overlay.hidden;
      overlay.hidden = true;
      requestId = null;
      dialogPending = false;
      dialogVersion++;
      requestControl = null;
      if (wasOpen) options.onModalChange?.(false);
      if (restore && isFocusable(dialogOpener)) dialogOpener.focus({ preventScroll: true });
      if (restore) dialogOpener = null;
    }
    function updateDialog() {
      const request = pendingRequest();
      if (!request) { if (!overlay.hidden) closeDialog(); return; }
      if (request.expired && !seenExpiredRequests.has(requestKey(request))) {
        seenExpiredRequests.add(requestKey(request));
        if (seenExpiredRequests.size > 100) seenExpiredRequests.delete(seenExpiredRequests.values().next().value);
        options.toast?.('An extension request expired. It remains pending until cancellation is delivered.');
      }
      const pendingCount = array(state.ui?.requests).filter(item => !item.resolved).length;
      const requestNotice = request.detached ? 'The original connection is no longer active. Retry cancellation to deliver the result to that connection.'
        : request.expired ? 'This request expired. Retry cancellation to deliver its result to the runtime.'
        : request.timeout ? 'This request has a ' + Math.ceil(Number(request.timeout) / 1000) + '-second timeout.' : '';
      dialogMeta.textContent = [requestNotice, pendingCount > 1 ? pendingCount + ' requests are waiting. They will not be discarded.' : ''].filter(Boolean).join(' ');
      dialogMeta.hidden = !dialogMeta.textContent;
      if (requestId === requestKey(request) && !overlay.hidden) {
        if (request.responseError) { dialogError.textContent = text(request.responseError); dialogError.hidden = false; }
        confirm.disabled = Boolean(request.responding || dialogPending || request.detached || request.expired);
        cancel.disabled = dismiss.disabled = Boolean(request.responding || dialogPending);
        if (requestControl) requestControl.disabled = confirm.disabled;
        if (request.detached || request.expired) cancel.querySelector('span').textContent = 'Retry cancellation';
        if (dialog.contains(document.activeElement) && document.activeElement.disabled) (cancel.disabled ? dialog : cancel).focus({ preventScroll: true });
        return;
      }
      if (overlay.hidden) dialogOpener = document.activeElement;
      requestId = requestKey(request);
      dialogVersion++;
      dialogPending = false;
      dialog.dataset.apwRequest = text(request.id);
      dialog.dataset.apwRequestKey = text(requestId);
      dialog.dataset.apwRequestMethod = request.method;
      dialogTitle.textContent = request.title || ({ select: 'Choose an option', confirm: 'Confirm action', input: 'Enter a response', editor: 'Edit text' }[request.method]);
      dialogMessage.textContent = request.message || '';
      dialogMessage.hidden = !dialogMessage.textContent;
      dialogError.hidden = !request.responseError;
      dialogError.textContent = text(request.responseError);
      dialogFields.replaceChildren();
      requestControl = null;
      if (request.method !== 'confirm') {
        const label = node('label', 'apw-request-label', dialogFields, request.method === 'select' ? 'Option' : request.method === 'editor' ? 'Text' : 'Response');
        requestControl = node(request.method === 'select' ? 'select' : request.method === 'editor' ? 'textarea' : 'input', 'apw-input', dialogFields);
        requestControl.id = prefix + 'request-value';
        requestControl.name = 'value';
        label.htmlFor = requestControl.id;
        if (request.method === 'select') {
          const placeholder = node('option', '', requestControl, 'Choose an option');
          placeholder.value = ''; placeholder.disabled = true; placeholder.selected = true;
          array(request.options).forEach(option => { const item = node('option', '', requestControl, typeof option === 'string' ? option : option.label || option.value); item.value = text(typeof option === 'string' ? option : option.value ?? option.label); });
          requestControl.required = true;
          requestControl.value = '';
        } else {
          if (request.method === 'input') requestControl.type = 'text';
          else requestControl.rows = 8;
          requestControl.value = text(request.prefill ?? request.defaultValue ?? request.value ?? '');
          requestControl.placeholder = text(request.placeholder);
          requestControl.autocomplete = 'off';
          requestControl.spellcheck = false;
        }
      }
      confirm.querySelector('span').textContent = request.method === 'confirm' ? 'Confirm' : request.method === 'editor' ? 'Save response' : 'Send response';
      cancel.querySelector('span').textContent = request.method === 'confirm' ? 'Decline' : 'Cancel';
      confirm.disabled = Boolean(request.detached || request.expired || request.responding);
      if (requestControl) requestControl.disabled = confirm.disabled;
      if (request.detached || request.expired) cancel.querySelector('span').textContent = 'Retry cancellation';
      cancel.disabled = Boolean(request.responding);
      dismiss.disabled = Boolean(request.responding);
      overlay.hidden = false;
      options.onModalChange?.(true);
      (requestControl && !requestControl.disabled ? requestControl : !cancel.disabled ? cancel : dialog).focus({ preventScroll: true });
      refreshIcons();
    }
    async function sendResponse(response) {
      const request = pendingRequest();
      if (destroyed || !request || requestKey(request) !== requestId || dialogPending || !runtime.respondUI) return;
      const id = requestId;
      const version = dialogVersion;
      dialogPending = true;
      confirm.disabled = cancel.disabled = dismiss.disabled = true;
      if (requestControl) requestControl.disabled = true;
      dialogError.hidden = true;
      try {
        const result = await runtime.respondUI(id, response);
        if (destroyed || version !== dialogVersion || id !== requestId) return;
        if (result === false || result?.success === false) throw new Error(result?.error || 'The response could not be sent.');
        respondedRequests.add(id);
        if (respondedRequests.size > 100) respondedRequests.delete(respondedRequests.values().next().value);
        // The controller owns request lifetime. A successful reply must remove
        // it; closing here avoids a duplicate response while that event settles.
        closeDialog();
        updateDialog();
      } catch (failure) {
        if (destroyed || version !== dialogVersion || id !== requestId) return;
        dialogError.textContent = text(failure?.message || failure);
        dialogError.hidden = false;
        confirm.disabled = Boolean(request.detached || request.expired); cancel.disabled = dismiss.disabled = false;
        if (requestControl) requestControl.disabled = confirm.disabled;
      } finally { if (version === dialogVersion) dialogPending = false; }
    }
    function fillAction(actionId, fieldName, value) {
      let record = forms.get(actionId);
      if (!record && actionId === 'navigate_tree') record = forms.get('fork');
      if (!record) return;
      const control = record.controls.get(fieldName) || (fieldName === 'sessionPath' ? record.controls.get('path') : null) || (fieldName === 'targetId' ? record.controls.get('entryId') : null);
      if (!control) return;
      changeSection(record.action.group);
      record.root.open = true;
      control.input.value = value;
      control.dirty = true;
      control.input.focus({ preventScroll: true });
      control.input.scrollIntoView?.({ block: 'nearest', behavior: 'instant' });
    }

    listen(nav, 'click', event => { const tab = event.target.closest('[data-apw-tab]'); if (tab) changeSection(tab.dataset.apwTab); });
    listen(nav, 'keydown', event => {
      const current = event.target.closest('[data-apw-tab]');
      if (!current || !['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const keys = Array.from(tabs.keys()), index = keys.indexOf(current.dataset.apwTab);
      changeSection(event.key === 'Home' ? keys[0] : event.key === 'End' ? keys[keys.length - 1] : keys[(index + (event.key === 'ArrowRight' ? 1 : -1) + keys.length) % keys.length], true);
    });
    listen(root, 'input', event => {
      const form = event.target.closest('[data-apw-form]');
      const record = forms.get(form?.dataset.apwForm);
      const control = record?.controls.get(event.target.name);
      if (control) { control.dirty = true; control.error.hidden = true; control.input.removeAttribute('aria-invalid'); syncAction(record.action); }
    });
    listen(root, 'change', event => {
      const record = forms.get(event.target.closest('[data-apw-form]')?.dataset.apwForm);
      const control = record?.controls.get(event.target.name);
      if (control) { control.dirty = true; syncAction(record.action); }
    });
    listen(root, 'submit', event => {
      const form = event.target.closest('[data-apw-form]');
      if (!form) return;
      event.preventDefault();
      const record = forms.get(form.dataset.apwForm);
      if (record) run(record);
    });
    listen(root, 'click', event => {
      const page = event.target.closest('[data-apw-request-page]');
      if (page && !page.disabled) { requestPage += Number(page.dataset.apwRequestPage); renderOverview('extensions'); return; }
      const draft = event.target.closest('[data-apw-draft]');
      if (draft) { options.onDraft?.(draft.dataset.apwDraft); return; }
      const fill = event.target.closest('[data-apw-fill-action]');
      if (fill) fillAction(fill.dataset.apwFillAction, fill.dataset.apwFillField, fill.dataset.apwFillValue);
    });
    listen(refresh, 'click', async () => {
      if (refresh.disabled || !runtime.refresh) return;
      refresh.disabled = true;
      try { await runtime.refresh(); if (!destroyed) live.textContent = 'Runtime information refreshed.'; }
      catch (failure) { if (!destroyed) { error.textContent = text(failure?.message || failure); error.hidden = false; } }
      finally { if (!destroyed) refresh.disabled = !state.connected; }
    });
    listen(dialogForm, 'submit', event => {
      event.preventDefault();
      const request = pendingRequest();
      if (!request || dialogPending || request.detached || request.expired) return;
      if (request.method === 'select' && !requestControl?.value) { dialogError.textContent = 'Choose an option before sending your response.'; dialogError.hidden = false; requestControl?.focus(); return; }
      sendResponse(request.method === 'confirm' ? { confirmed: true } : { value: text(requestControl?.value) });
    });
    listen(cancel, 'click', () => { const request = pendingRequest(); sendResponse(request?.method === 'confirm' && !request.detached && !request.expired ? { confirmed: false } : { cancelled: true }); });
    listen(dismiss, 'click', () => sendResponse({ cancelled: true }));
    listen(overlay, 'keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!dialogPending) sendResponse({ cancelled: true }); return; }
      if (event.key !== 'Tab') return;
      event.stopPropagation();
      const controls = Array.from(dialog.querySelectorAll('button,input,select,textarea,a[href]')).filter(isFocusable);
      if (!controls.length) { event.preventDefault(); return; }
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    });

    changeSection('session', false, false);
    unsubscribe = runtime.subscribe(update);
    // Controllers should publish immediately, but a passive subscription is
    // still supported without relying on any application-side timing.
    update(runtime.getState());
    const api = {
      open(section = 'session') { if (!destroyed) changeSection(section); },
      focus() { if (!destroyed) tabs.get(selected)?.focus({ preventScroll: true }); },
      isDialogOpen() { return !destroyed && !overlay.hidden; },
      getState() { return { section: selected, connected: Boolean(state.connected), requestId: requestId ? pendingRequest()?.id || null : null, requestKey: requestId, pendingRequestCount: array(state.ui?.requests).length, actions: Array.from(forms.keys()) }; },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        unsubscribe?.();
        controller.abort();
        closeDialog(false);
        root.remove(); overlay.remove(); forms.clear(); panels.clear(); tabs.clear();
        MOUNTS.delete(host);
      }
    };
    MOUNTS.set(host, api);
    return api;
  }
  window.AthenaPiWorkbench = Object.freeze({ mount });
})();
