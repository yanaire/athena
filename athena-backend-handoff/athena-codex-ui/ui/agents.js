/* Athena's local agent-team preview. No model, process, or network is called.
   A demo advances only after Run demo, and every run has a finite step count. */
(() => {
  'use strict';

  const instances = new WeakMap();
  const STEP_MS = 1000;
  const TASK_LIMIT = 280;
  const ROLES = Object.freeze({
    researcher: { name: 'Scout', label: 'Researcher', color: 'mint', description: 'Find sources and gather evidence', placeholder: 'Find the key references and summarize what they support.', output: { title: 'Research brief', description: 'Open the sample research note.', tab: 'manuscript', artifact: null }, steps: ['Outlined the sample research question.', 'Reviewed the sample reference list.', 'Collected the supporting notes.', 'Prepared the sample research brief.'] },
    analyst: { name: 'Pip', label: 'Analyst', color: 'peach', description: 'Explore data and compare results', placeholder: 'Analyze the data and compare the results with the baseline.', output: { title: 'Frequency response', description: 'Open the sample baseline response.', tab: 'results', artifact: 'response' }, steps: ['Read the sample circuit.', 'Prepared the demo inputs.', 'Checked the example component values.', 'Set up the sample comparison.', 'Reviewed the first example condition.', 'Reviewed the second example condition.', 'Collected the sample response values.', 'Compared the example cutoff values.', 'Reviewed the remaining example conditions.', 'Organized the sample response data.', 'Checked the demo summary.', 'Prepared the sample response output.'] },
    reviewer: { name: 'Sage', label: 'Reviewer', color: 'lavender', description: 'Check claims, assumptions, and evidence', placeholder: 'Review the findings and flag any unsupported conclusions.', output: { title: 'Validation results', description: 'Open the sample validation table.', tab: 'results', artifact: 'table' }, steps: ['Read the sample findings.', 'Compared the example with its stated criteria.', 'Reviewed the sample assumptions.', 'Prepared the sample validation summary.'] },
    writer: { name: 'Quill', label: 'Writer', color: 'blue', description: 'Turn findings into a clear draft', placeholder: 'Write a concise research note from the validated results.', output: { title: 'Research note', description: 'Open the sample manuscript.', tab: 'manuscript', artifact: null }, steps: ['Outlined the sample research note.', 'Organized the example methods.', 'Drafted the sample results section.', 'Added the example limitations.', 'Prepared the sample manuscript.'] }
  });
  const STATUS_LABELS = Object.freeze({ queued: 'Queued', working: 'Working', waiting: 'Waiting', paused: 'Paused', done: 'Done', stopped: 'Stopped' });
  const esc = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const icon = name => '<i data-lucide="' + name + '" aria-hidden="true"></i>';

  function mount(host, options = {}) {
    if (!host) throw new TypeError('AthenaAgents.mount requires a host element.');
    instances.get(host)?.destroy();
    const controller = new AbortController();
    const { signal } = controller;
    const listen = (target, type, callback) => target.addEventListener(type, callback, { signal });
    const timers = new Map();
    const generations = new Map();
    let nextAgent = 1;
    let nextEvent = 1;
    let destroyed = false;
    let createOpener = null;
    const state = { selectedId: 'pip', creating: false, detailTab: 'activity', draft: { role: 'writer', task: '' } };
    const agents = [
      { id: 'scout', name: 'Scout', role: 'researcher', task: 'Review the RC filter setup and gather the supporting notes.', status: 'done', progress: 4, total: 4, dependsOn: null, isSample: true, demoRunning: false, hasRun: false, createdAt: null, activity: [
        { id: 'seed-scout-1', text: 'Reviewed the sample circuit setup.', step: 1, kind: 'sample' },
        { id: 'seed-scout-2', text: 'Collected the supporting research notes.', step: 3, kind: 'sample' },
        { id: 'seed-scout-3', text: 'Sample brief ready to open.', step: 4, kind: 'sample' }
      ], output: { ...ROLES.researcher.output } },
      { id: 'pip', name: 'Pip', role: 'analyst', task: 'Compare the baseline RC response across 12 component conditions.', status: 'working', progress: 8, total: 12, dependsOn: null, isSample: true, demoRunning: false, hasRun: false, createdAt: null, activity: [
        { id: 'seed-pip-1', text: 'Prepared the sample circuit and comparison criteria.', step: 1, kind: 'sample' },
        { id: 'seed-pip-2', text: 'Collected response values from the example.', step: 6, kind: 'sample' },
        { id: 'seed-pip-3', text: 'Sample progress is 8 of 12 steps.', step: 8, kind: 'sample' }
      ], output: null },
      { id: 'sage', name: 'Sage', role: 'reviewer', task: 'Check the response against theory after Pip finishes.', status: 'waiting', progress: 0, total: 4, dependsOn: 'pip', isSample: true, demoRunning: false, hasRun: false, createdAt: null, activity: [
        { id: 'seed-sage-1', text: 'Waiting for Pip to finish the local demo.', step: 0, kind: 'sample' }
      ], output: null }
    ];
    const q = selector => host.querySelector(selector);
    const qa = selector => Array.from(host.querySelectorAll(selector));
    const findAgent = id => agents.find(agent => agent.id === id);
    const selected = () => findAgent(state.selectedId) || agents[0];
    const refreshIcons = () => options.icons ? options.icons() : window.lucide?.createIcons({ attrs: { 'aria-hidden': 'true' } });
    const statusLabel = agent => agent.status === 'working' && agent.isSample && !agent.demoRunning ? 'Sample run' : STATUS_LABELS[agent.status];
    const avatar = (role, status, size) => window.AthenaAvatars?.html({ role, status, size }) || '<span class="aga-fallback-avatar" aria-hidden="true">' + esc(ROLES[role].name.charAt(0)) + '</span>';
    host.classList.add('aga-host');

    function agentSnapshot(agent) {
      return {
        ...agent,
        roleLabel: ROLES[agent.role].label,
        color: ROLES[agent.role].color,
        statusLabel: statusLabel(agent),
        activity: agent.activity.map(event => ({ ...event })),
        output: agent.output ? { ...agent.output } : null
      };
    }

    function getState() {
      const runningIds = agents.filter(agent => agent.status === 'working' && agent.demoRunning).map(agent => agent.id);
      return {
        agents: agents.map(agentSnapshot),
        selectedId: state.selectedId,
        creating: state.creating,
        detailTab: state.detailTab,
        draft: { ...state.draft },
        runningIds,
        runningCount: runningIds.length,
        totalCount: agents.length
      };
    }

    function getSummary() {
      const summary = { total: agents.length, working: 0, queued: 0, done: 0, waiting: 0, paused: 0, stopped: 0, running: 0, selectedId: state.selectedId, agents: [] };
      for (const agent of agents) {
        summary[agent.status]++;
        if (agent.status === 'working' && agent.demoRunning) summary.running++;
        summary.agents.push({ id: agent.id, name: agent.name, role: agent.role, roleLabel: ROLES[agent.role].label, color: ROLES[agent.role].color, status: agent.status, statusLabel: statusLabel(agent), task: agent.task, progress: agent.progress, total: agent.total, isSample: agent.isSample, demoRunning: agent.demoRunning });
      }
      return summary;
    }

    function emit(message = '') {
      if (destroyed) return;
      if (message) {
        const live = q('[data-aga-live]');
        if (live) live.textContent = message;
      }
      options.onChange?.(getState());
    }

    function log(agent, text, kind = 'demo') {
      agent.activity.push({ id: agent.id + '-event-' + nextEvent++, text, step: agent.progress, kind });
      if (agent.activity.length > 20) agent.activity.splice(0, agent.activity.length - 20);
    }

    function dependency(agent) {
      const required = agent.dependsOn ? findAgent(agent.dependsOn) : null;
      return required && required.status !== 'done' ? required : null;
    }

    function updateDependencies() {
      for (const agent of agents) {
        if (!agent.dependsOn || !['waiting', 'queued'].includes(agent.status) || agent.progress !== 0) continue;
        const blocked = dependency(agent);
        const next = blocked ? 'waiting' : 'queued';
        if (agent.status === next) continue;
        agent.status = next;
        agent.isSample = false;
        log(agent, blocked ? 'Waiting for ' + blocked.name + ' to finish.' : 'Pip is done. Ready to run the review demo.', 'state');
      }
    }

    function cancelTimer(agent) {
      if (timers.has(agent.id)) window.clearTimeout(timers.get(agent.id));
      timers.delete(agent.id);
      generations.set(agent.id, (generations.get(agent.id) || 0) + 1);
    }

    function schedule(agent) {
      if (destroyed || agent.status !== 'working' || !agent.demoRunning) return;
      const generation = generations.get(agent.id) || 0;
      const timer = window.setTimeout(() => {
        if (destroyed || generation !== (generations.get(agent.id) || 0) || agent.status !== 'working' || !agent.demoRunning) return;
        timers.delete(agent.id);
        agent.progress = Math.min(agent.total, agent.progress + 1);
        const steps = ROLES[agent.role].steps;
        log(agent, steps[Math.min(steps.length - 1, agent.progress - 1)]);
        let message = '';
        if (agent.progress >= agent.total) {
          agent.status = 'done';
          agent.demoRunning = false;
          agent.output = { ...ROLES[agent.role].output };
          message = agent.name + ' finished the demo. Sample output is ready.';
          updateDependencies();
        } else schedule(agent);
        render();
        emit(message);
      }, STEP_MS);
      timers.set(agent.id, timer);
    }

    function run(agent) {
      if (!agent || destroyed || dependency(agent) || agent.demoRunning) return;
      cancelTimer(agent);
      const continueSample = agent.isSample && agent.status === 'working';
      if (!continueSample) agent.progress = 0;
      agent.status = 'working';
      agent.demoRunning = true;
      agent.isSample = false;
      agent.hasRun = true;
      agent.output = null;
      log(agent, continueSample ? 'Local demo started from the sample progress.' : 'Local demo started. No external tools are running.', 'state');
      updateDependencies();
      schedule(agent);
      render();
      emit(agent.name + ' started the local demo.');
    }

    function pause(agent) {
      if (!agent || agent.status !== 'working' || !agent.demoRunning) return;
      cancelTimer(agent);
      agent.status = 'paused';
      agent.demoRunning = false;
      log(agent, 'Demo paused. Progress is preserved.', 'state');
      render();
      emit(agent.name + ' paused.');
    }

    function resume(agent) {
      if (!agent || agent.status !== 'paused' || destroyed) return;
      cancelTimer(agent);
      agent.status = 'working';
      agent.demoRunning = true;
      log(agent, 'Demo resumed from the saved step.', 'state');
      schedule(agent);
      render();
      emit(agent.name + ' resumed.');
    }

    function stop(agent) {
      if (!agent || !['working', 'paused'].includes(agent.status)) return;
      cancelTimer(agent);
      agent.status = 'stopped';
      agent.demoRunning = false;
      agent.isSample = false;
      log(agent, 'Demo stopped. No further steps will run.', 'state');
      render();
      emit(agent.name + ' stopped.');
    }

    function captureFocus() {
      const element = document.activeElement;
      if (!element || !host.contains(element)) return null;
      for (const attribute of ['id', 'data-aga-select', 'data-aga-action', 'data-aga-role', 'data-aga-tab']) {
        const value = element.getAttribute(attribute);
        if (value !== null) return { attribute, value, start: element.selectionStart, end: element.selectionEnd, direction: element.selectionDirection, scrollTop: element.scrollTop };
      }
      return null;
    }

    function restoreFocus(saved) {
      if (!saved) return;
      const matches = qa('[' + saved.attribute + ']');
      const element = matches.find(item => item.getAttribute(saved.attribute) === saved.value && !item.disabled && !item.closest('[hidden]'))
        || (saved.attribute === 'data-aga-action' && ['run', 'pause', 'resume', 'stop'].includes(saved.value) ? q('.aga-actions .aga-button:not([disabled])') : null)
        || q('[data-aga-select="' + state.selectedId + '"]');
      if (!element) return;
      element.focus({ preventScroll: true });
      if (typeof saved.start === 'number' && element.setSelectionRange) {
        element.setSelectionRange(saved.start, saved.end, saved.direction || 'none');
        element.scrollTop = saved.scrollTop || 0;
      }
    }

    function statusHTML(agent) {
      return '<span class="aga-status" data-status="' + agent.status + '"><span class="aga-status-dot" aria-hidden="true"></span>' + esc(statusLabel(agent)) + '</span>';
    }

    function rosterHTML() {
      return '<div class="aga-roster" role="list" aria-label="Research team">' + agents.map(agent => '<div class="aga-roster-item" role="listitem"><button type="button" class="aga-agent-row cursor-interaction' + (agent.id === state.selectedId ? ' is-selected' : '') + '" data-aga-select="' + agent.id + '" aria-pressed="' + (agent.id === state.selectedId) + '" aria-label="' + esc(agent.name + ', ' + ROLES[agent.role].label + ', ' + statusLabel(agent)) + '"><span class="aga-row-avatar">' + avatar(agent.role, agent.status, 40) + '</span><span class="aga-row-copy"><span class="aga-row-heading"><strong>' + esc(agent.name) + '</strong><small>' + ROLES[agent.role].label + '</small></span><span class="aga-row-task">' + esc(agent.task) + '</span></span>' + statusHTML(agent) + '</button></div>').join('') + '</div>';
    }

    function actionHTML(agent) {
      const blocked = dependency(agent);
      if (agent.status === 'working' && agent.demoRunning) return '<button type="button" class="aga-button aga-button-primary cursor-interaction" data-aga-action="pause">' + icon('pause') + 'Pause</button><button type="button" class="aga-button cursor-interaction" data-aga-action="stop">' + icon('square') + 'Stop</button>';
      if (agent.status === 'paused') return '<button type="button" class="aga-button aga-button-primary cursor-interaction" data-aga-action="resume">' + icon('play') + 'Resume</button><button type="button" class="aga-button cursor-interaction" data-aga-action="stop">' + icon('square') + 'Stop</button>';
      return '<button type="button" class="aga-button aga-button-primary cursor-interaction" data-aga-action="run"' + (blocked ? ' disabled aria-describedby="aga-run-note"' : '') + '>' + icon(agent.hasRun ? 'rotate-ccw' : 'play') + (agent.hasRun ? 'Run again' : 'Run demo') + '</button>';
    }

    function detailHTML(agent) {
      const blocked = dependency(agent);
      const note = blocked ? 'Waiting for ' + blocked.name + ' to finish the demo.'
        : agent.isSample && agent.status === 'working' ? 'This example advances only when you press Run demo.'
        : agent.demoRunning ? 'Local demo in progress. It will stop after the final step.'
        : agent.status === 'paused' ? 'Paused at this step. Resume when you are ready.'
        : agent.status === 'stopped' ? 'Stopped. Run again to restart the demo from the beginning.'
        : agent.status === 'done' ? 'Sample output is ready. No external task was executed.'
        : 'Queued locally. Start the demo when you are ready.';
      return '<section class="aga-detail" aria-label="Selected agent details"><div class="aga-detail-header">' + avatar(agent.role, agent.status, 48) + '<div class="aga-detail-title"><h3>' + esc(agent.name) + '</h3><span>' + ROLES[agent.role].label + '</span></div>' + statusHTML(agent) + '</div><p class="aga-task-copy">' + esc(agent.task) + '</p><div class="aga-progress-caption"><span>' + (agent.isSample ? 'Sample progress' : 'Demo progress') + '</span><strong>' + agent.progress + ' / ' + agent.total + ' steps</strong></div><div class="aga-progress-track" role="progressbar" aria-label="' + esc(agent.name) + ' demo progress" aria-valuemin="0" aria-valuemax="' + agent.total + '" aria-valuenow="' + agent.progress + '" aria-valuetext="' + agent.progress + ' of ' + agent.total + ' demo steps"><span style="width:' + (agent.progress / agent.total * 100).toFixed(2) + '%"></span></div><p class="aga-sample-note" id="aga-run-note">' + esc(note) + '</p><div class="aga-actions">' + actionHTML(agent) + '</div><div class="aga-tabs" role="tablist" aria-label="Agent details"><button type="button" class="cursor-interaction' + (state.detailTab === 'activity' ? ' is-active' : '') + '" id="aga-tab-activity" data-aga-tab="activity" role="tab" aria-controls="aga-panel-activity" aria-selected="' + (state.detailTab === 'activity') + '" tabindex="' + (state.detailTab === 'activity' ? '0' : '-1') + '">Activity</button><button type="button" class="cursor-interaction' + (state.detailTab === 'output' ? ' is-active' : '') + '" id="aga-tab-output" data-aga-tab="output" role="tab" aria-controls="aga-panel-output" aria-selected="' + (state.detailTab === 'output') + '" tabindex="' + (state.detailTab === 'output' ? '0' : '-1') + '">Output' + (agent.output ? '<span class="aga-tab-count">1</span>' : '') + '</button></div><div class="aga-tab-panel" id="aga-panel-activity" role="tabpanel" aria-labelledby="aga-tab-activity" tabindex="0"' + (state.detailTab !== 'activity' ? ' hidden' : '') + '><ol class="aga-activity">' + [...agent.activity].reverse().map(entry => '<li><span class="aga-activity-dot" data-kind="' + entry.kind + '" aria-hidden="true"></span><div><strong>' + esc(entry.text) + '</strong><small>' + (entry.kind === 'sample' ? 'Sample event' : entry.kind === 'state' ? 'Local demo' : 'Demo step ' + entry.step) + '</small></div></li>').join('') + '</ol></div><div class="aga-tab-panel" id="aga-panel-output" role="tabpanel" aria-labelledby="aga-tab-output" tabindex="0"' + (state.detailTab !== 'output' ? ' hidden' : '') + '>' + (agent.output ? '<div class="aga-output"><button type="button" class="aga-output-button cursor-interaction" data-aga-action="open-output"><span class="aga-output-icon">' + icon(agent.output.tab === 'manuscript' ? 'file-pen-line' : 'chart-no-axes-combined') + '</span><span><strong>' + esc(agent.output.title) + '</strong><small>' + esc(agent.output.description) + '</small></span>' + icon('arrow-up-right') + '</button><p>Demo output · opens an existing sample artifact.</p></div>' : '<div class="aga-output-empty">' + icon('files') + '<strong>No output yet</strong><p>Complete the local demo to reveal a sample result.</p></div>') + '</div></section>';
    }

    function nextName(role) {
      const number = agents.filter(agent => agent.role === role).length + 1;
      return ROLES[role].name + (number > 1 ? ' ' + number : '');
    }

    function createHTML() {
      const role = state.draft.role;
      return '<form class="aga-create-form" data-aga-create-form><h3>Give your new agent a task</h3><p>Choose a role and describe one task. The agent stays queued until you run the demo.</p><div class="aga-role-grid" role="radiogroup" aria-label="Agent role">' + Object.entries(ROLES).map(([id, definition]) => '<button type="button" class="aga-role-card cursor-interaction" data-aga-role="' + id + '" role="radio" aria-checked="' + (role === id) + '" tabindex="' + (role === id ? '0' : '-1') + '" aria-label="' + definition.name + ', ' + definition.label + '">' + avatar(id, role === id ? 'working' : 'waiting', 40) + '<strong>' + definition.name + '</strong><small>' + definition.label + '</small></button>').join('') + '</div><p class="aga-role-description">' + esc(ROLES[role].description) + '</p><label class="aga-field-label" for="aga-agent-task">Task</label><textarea id="aga-agent-task" class="aga-task-input" data-aga-task rows="4" maxlength="' + TASK_LIMIT + '" required placeholder="' + esc(ROLES[role].placeholder) + '" aria-describedby="aga-task-help">' + esc(state.draft.task) + '</textarea><div class="aga-field-meta"><span id="aga-task-help">A clear, specific request works best.</span><span data-aga-task-count>' + state.draft.task.length + ' / ' + TASK_LIMIT + '</span></div><div class="aga-create-summary">' + avatar(role, 'waiting', 28) + '<span><strong>' + esc(nextName(role)) + '</strong> will join as a ' + ROLES[role].label.toLowerCase() + '.</span></div><div class="aga-actions"><button type="button" class="aga-button cursor-interaction" data-aga-action="cancel-create">Cancel</button><button type="submit" class="aga-button aga-button-primary cursor-interaction" data-aga-action="add-agent"' + (!state.draft.task.trim() ? ' disabled' : '') + '>' + icon('plus') + 'Add agent</button></div></form>';
    }

    function render({ force = false, resetScroll = false } = {}) {
      if (destroyed || state.creating && !force) return;
      const focused = captureFocus();
      const scrollTop = q('.aga-scroll')?.scrollTop || 0;
      const rosterScroll = q('.aga-roster')?.scrollTop || 0;
      host.innerHTML = '<div class="aga-panel"><header class="aga-team-header">' + (options.onBack ? '<button type="button" class="aga-back cursor-interaction" data-aga-action="back" aria-label="Back to surfaces">' + icon('arrow-left') + '</button>' : '') + '<div class="aga-team-heading"><h2>' + (state.creating ? 'Add an agent' : 'Your team') + '</h2><span class="aga-team-count">' + agents.length + ' agents</span></div>' + (!state.creating ? '<button type="button" class="aga-add-button cursor-interaction" data-aga-action="create" aria-label="Add an agent">' + icon('plus') + '<span>Add</span></button>' : '<span class="aga-preview-badge">Preview</span>') + '</header><div class="aga-scroll">' + (state.creating ? createHTML() : '<p class="aga-preview-note">' + icon('sparkles') + '<span>Preview team · local demos only</span></p>' + rosterHTML() + detailHTML(selected())) + '</div><span class="ac-sr-only" data-aga-live role="status" aria-live="polite"></span></div>';
      refreshIcons();
      q('.aga-scroll').scrollTop = resetScroll ? 0 : scrollTop;
      if (q('.aga-roster')) q('.aga-roster').scrollTop = rosterScroll;
      restoreFocus(focused);
    }

    function select(id) {
      if (destroyed || !findAgent(id)) return false;
      if (state.selectedId !== id) state.detailTab = 'activity';
      state.selectedId = id;
      state.creating = false;
      render({ force: true });
      emit();
      return true;
    }

    function focus() {
      if (destroyed || host.closest('[hidden]')) return;
      const target = state.creating ? q('[data-aga-task]') : q('[data-aga-select="' + state.selectedId + '"]') || q('[data-aga-action="create"]');
      target?.focus({ preventScroll: true });
    }

    function openCreate() {
      if (destroyed) return;
      if (!state.creating) createOpener = document.activeElement;
      state.creating = true;
      render({ force: true, resetScroll: true });
      q('[data-aga-task]')?.focus({ preventScroll: true });
      emit('Choose a role and enter a task for your new agent.');
    }

    function cancelCreate() {
      if (!state.creating) return;
      state.creating = false;
      state.draft = { role: 'writer', task: '' };
      render({ force: true, resetScroll: true });
      const target = createOpener?.isConnected && !createOpener.closest('[hidden]') ? createOpener : q('[data-aga-action="create"]');
      target?.focus({ preventScroll: true });
      emit('Agent creation cancelled.');
    }

    function addAgent() {
      if (!state.creating || destroyed) return;
      const role = Object.hasOwn(ROLES, state.draft.role) ? state.draft.role : 'writer';
      const task = state.draft.task.trim().slice(0, TASK_LIMIT);
      if (!task) { q('[data-aga-task]').setAttribute('aria-invalid', 'true'); q('[data-aga-task]').focus(); return; }
      const agent = { id: 'agent-' + nextAgent++, name: nextName(role), role, task, status: 'queued', progress: 0, total: ROLES[role].steps.length, dependsOn: null, isSample: false, demoRunning: false, hasRun: false, createdAt: Date.now(), activity: [], output: null };
      log(agent, 'Queued locally. Run the demo when you are ready.', 'state');
      agents.push(agent);
      state.selectedId = agent.id;
      state.creating = false;
      state.detailTab = 'activity';
      state.draft = { role: 'writer', task: '' };
      render({ force: true, resetScroll: true });
      q('[data-aga-select="' + agent.id + '"]')?.focus({ preventScroll: true });
      options.toast?.(agent.name + ' added to the preview team.');
      emit(agent.name + ' added. The task is queued.');
    }

    listen(host, 'click', event => {
      const button = event.target.closest('button');
      if (!button || !host.contains(button) || button.disabled || destroyed) return;
      if (button.dataset.agaSelect) { select(button.dataset.agaSelect); q('[data-aga-select="' + state.selectedId + '"]')?.focus({ preventScroll: true }); return; }
      if (button.dataset.agaRole && Object.hasOwn(ROLES, button.dataset.agaRole)) { state.draft.role = button.dataset.agaRole; render({ force: true }); return; }
      if (button.dataset.agaTab) { state.detailTab = button.dataset.agaTab === 'output' ? 'output' : 'activity'; render(); return; }
      const action = button.dataset.agaAction;
      if (action === 'create') openCreate();
      else if (action === 'cancel-create') cancelCreate();
      else if (action === 'back') { if (state.creating) cancelCreate(); else options.onBack?.(); }
      else if (action === 'run') run(selected());
      else if (action === 'pause') pause(selected());
      else if (action === 'resume') resume(selected());
      else if (action === 'stop') stop(selected());
      else if (action === 'open-output') {
        const output = selected().output;
        if (output) options.onOpenArtifact?.({ tab: output.tab, artifact: output.artifact });
      }
    });

    listen(host, 'submit', event => {
      if (!event.target.matches('[data-aga-create-form]')) return;
      event.preventDefault();
      addAgent();
    });

    listen(host, 'input', event => {
      if (!event.target.matches('[data-aga-task]')) return;
      state.draft.task = event.target.value.slice(0, TASK_LIMIT);
      event.target.removeAttribute('aria-invalid');
      q('[data-aga-task-count]').textContent = state.draft.task.length + ' / ' + TASK_LIMIT;
      q('[data-aga-action="add-agent"]').disabled = !state.draft.task.trim();
    });

    listen(host, 'keydown', event => {
      if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === 'Escape' && state.creating) { event.preventDefault(); event.stopPropagation(); cancelCreate(); return; }
      const role = event.target.closest('[data-aga-role]');
      if (role && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        const roles = Object.keys(ROLES), index = roles.indexOf(state.draft.role);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? roles.length - 1 : (index + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1) + roles.length) % roles.length;
        state.draft.role = roles[next];
        render({ force: true });
        q('[data-aga-role="' + state.draft.role + '"]')?.focus({ preventScroll: true });
        return;
      }
      const tab = event.target.closest('[data-aga-tab]');
      if (tab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        state.detailTab = event.key === 'Home' ? 'activity' : event.key === 'End' ? 'output' : state.detailTab === 'activity' ? 'output' : 'activity';
        render();
        q('[data-aga-tab="' + state.detailTab + '"]')?.focus({ preventScroll: true });
      }
    });

    const api = {
      select, focus, getState, getSummary, openCreate,
      destroy() {
        if (destroyed) return;
        destroyed = true;
        for (const agent of agents) cancelTimer(agent);
        controller.abort();
        host.replaceChildren();
        host.classList.remove('aga-host');
        if (instances.get(host) === api) instances.delete(host);
      }
    };
    instances.set(host, api);
    render();
    emit();
    return api;
  }

  window.AthenaAgents = Object.freeze({ mount });
})();
