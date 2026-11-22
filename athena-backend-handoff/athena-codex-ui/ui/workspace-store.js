/* Athena workspace: a finite, browser-local workflow demonstration.
 * This module never launches a process, reads project files, calls a model,
 * requests the network, or treats its sample output as a real execution result.
 *
 * Public API: AthenaWorkspaceStore.create({ clock?, tickMs?, parallelLimit? })
 * clock may supply now(), setTimeout(callback, delay), and clearTimeout(handle)
 * for deterministic local verification. Timestamps are epoch milliseconds.
 * elapsedMs counts active demo time; pauses and approval waits do not count.
 */
(() => {
  'use strict';

  const DEFAULT_TICK_MS = 750;
  const EVENT_LIMIT = 150;
  const LOG_LIMIT = 100;
  const APPROVAL_LIMIT = 50;
  const CWD = '/workspace/biosignal-circuits';
  const ANALYSIS_COMMAND = 'python scripts/rc_sweep.py --input data/components.csv --output results/rc_sweep.csv';
  const TERMINAL_TASK_STATES = new Set(['succeeded', 'failed', 'cancelled']);
  const SCENARIOS = new Set(['success', 'analysis-error']);
  let nextInstance = 1;

  const DEFINITIONS = [
    {
      id: 'sources', title: 'Collect sample sources', role: 'researcher', agentName: 'Scout', total: 3,
      dependencies: [], toolId: 'source-lookup', toolName: 'Source lookup · sample',
      sdkToolName: 'grep', args: { pattern: 'RC low-pass', path: 'references/' },
      command: 'sample: source_lookup --topic rc-lowpass', artifactIds: ['research-brief'],
      steps: [
        'Sample source list: authored notes describe the ideal passive RC low-pass filter.',
        'Sample assumption: the ideal component model omits source and load effects.',
        'Prepared the sample source brief. No external lookup was performed.'
      ]
    },
    {
      id: 'inspect', title: 'Inspect sample component data', role: 'analyst', agentName: 'Pip', total: 2,
      dependencies: [], toolId: 'dataset-inspector', toolName: 'Dataset inspector · sample',
      sdkToolName: 'read', args: { path: 'data/components.csv' },
      command: 'sample: inspect data/components.csv', artifactIds: [],
      steps: [
        'Sample input: R = 1,000 Ω and C = 100 nF.',
        'Sample tolerance limits: R ±1% and C ±5%. No input file was read.'
      ]
    },
    {
      id: 'analyze', title: 'Compare sample RC responses', role: 'analyst', agentName: 'Pip', total: 4,
      dependencies: ['sources', 'inspect'], toolId: 'python-analysis', toolName: 'Python analysis · sample',
      sdkToolName: 'bash', args: { command: ANALYSIS_COMMAND },
      command: ANALYSIS_COMMAND, artifactIds: ['response-plot', 'analysis-code'],
      steps: [
        'Simulated command accepted. No Python process was started.',
        'Sample baseline: f_c ≈ 1,591.549 Hz for R = 1 kΩ and C = 100 nF.',
        'Sample sweep: compared ±1% resistor and ±5% capacitor bounds.',
        'Prepared the sample response plot and analysis code. No output file was written.'
      ]
    },
    {
      id: 'review', title: 'Validate sample results', role: 'reviewer', agentName: 'Sage', total: 3,
      dependencies: ['analyze'], toolId: 'validation', toolName: 'Validation · sample',
      sdkToolName: 'read', args: { path: 'results/rc_sweep.csv' },
      command: 'sample: validate results/rc_sweep.csv', artifactIds: ['validation-table'],
      steps: [
        'Sample validation: compared the ideal RC formula with the authored sweep values.',
        'Sample bounds: increasing R or C lowers the ideal cutoff frequency.',
        'Prepared the sample validation table. No measurement was performed.'
      ]
    },
    {
      id: 'write', title: 'Write the sample research note', role: 'writer', agentName: 'Quill', total: 3,
      dependencies: ['review'], toolId: 'report-writer', toolName: 'Report writer · sample',
      sdkToolName: 'write', args: { path: 'reports/research-note.md' },
      command: 'sample: write reports/research-note.md', artifactIds: ['research-note'],
      steps: [
        'Sample draft: connected the source brief, response plot, and validation table.',
        'Sample limitation: ideal RC values are illustrative and are not measured results.',
        'Prepared the final sample research note. No project file was changed.'
      ]
    }
  ];

  const ARTIFACTS = {
    'research-brief': { title: 'Sample source brief', kind: 'document', description: 'Authored reference notes and assumptions for the sample ideal RC filter.' },
    'response-plot': { title: 'Sample frequency response', kind: 'plot', description: 'Illustrative ideal RC response for the baseline and tolerance bounds.' },
    'analysis-code': { title: 'Sample analysis code', kind: 'code', description: 'An inspectable Python example; this local demo does not execute it.' },
    'validation-table': { title: 'Sample validation table', kind: 'table', description: 'Authored comparisons of the ideal RC calculation and tolerance bounds.' },
    'research-note': { title: 'Sample research note', kind: 'document', description: 'A sample final report combining the completed demonstration outputs.' }
  };

  function immutableCopy(value) {
    if (Array.isArray(value)) return Object.freeze(value.map(immutableCopy));
    if (value && typeof value === 'object') {
      const result = {};
      for (const key of Object.keys(value)) result[key] = immutableCopy(value[key]);
      return Object.freeze(result);
    }
    return value;
  }

  function boundedPush(array, value, limit) {
    array.push(value);
    if (array.length > limit) array.splice(0, array.length - limit);
  }

  function validParallelLimit(value) {
    return Number.isInteger(value) && value >= 1 && value <= 4;
  }

  function create(options = {}) {
    const settings = options && typeof options === 'object' ? options : {};
    const suppliedClock = settings.clock && typeof settings.clock === 'object' ? settings.clock : {};
    const readClock = typeof suppliedClock.now === 'function' ? suppliedClock.now.bind(suppliedClock) : Date.now;
    const setTimer = typeof suppliedClock.setTimeout === 'function' ? suppliedClock.setTimeout.bind(suppliedClock) : window.setTimeout.bind(window);
    const clearTimer = typeof suppliedClock.clearTimeout === 'function' ? suppliedClock.clearTimeout.bind(suppliedClock) : window.clearTimeout.bind(window);
    const tickMs = Number.isFinite(settings.tickMs) && settings.tickMs > 0 ? Math.min(60000, settings.tickMs) : DEFAULT_TICK_MS;
    const instanceId = nextInstance++;
    const listeners = new Set();
    const timers = new Map();
    const remainingDelays = new Map();
    const currentApprovalIds = new Map();
    let state;
    let runNumber = 0;
    let eventNumber = 0;
    let logNumber = 0;
    let approvalNumber = 0;
    let started = false;
    let paused = false;
    let cancelled = false;
    let destroyed = false;
    let failureUsed = false;
    let elapsedBase = 0;
    let activeSince = null;
    let emitting = false;
    let emissionPending = false;

    const now = () => {
      const value = Number(readClock());
      return Number.isFinite(value) ? value : Date.now();
    };
    const taskById = id => state.tasks.find(task => task.id === id);
    const definitionById = id => DEFINITIONS.find(definition => definition.id === id);
    const toolFor = task => state.tools.find(tool => tool.id === task.toolIds[0]);
    const agentFor = task => state.agents.find(agent => agent.taskId === task.id);
    const approvalFor = task => state.approvals.find(approval => approval.id === currentApprovalIds.get(task.id));
    const dependenciesSucceeded = task => task.dependencies.every(id => taskById(id)?.status === 'succeeded');
    const activeElapsed = () => elapsedBase + (activeSince === null ? 0 : Math.max(0, now() - activeSince));

    function freshState(scenario, parallelLimit) {
      runNumber += 1;
      eventNumber = 0;
      logNumber = 0;
      approvalNumber = 0;
      return {
        run: { id: 'local-run-' + instanceId + '-' + runNumber, status: 'ready', scenario, startedAt: null, elapsedMs: 0 },
        configuration: { parallelLimit },
        tasks: DEFINITIONS.map(definition => ({
          id: definition.id, title: definition.title, role: definition.role, agentName: definition.agentName,
          status: 'queued', progress: 0, total: definition.total, dependencies: [...definition.dependencies],
          toolIds: [definition.toolId], artifactIds: [...definition.artifactIds]
        })),
        tools: DEFINITIONS.map(definition => ({
          id: definition.toolId, taskId: definition.id, name: definition.toolName, command: definition.command,
          sdkToolName: definition.sdkToolName, args: { ...definition.args },
          cwd: CWD, status: 'queued', logs: [], exitCode: null
        })),
        agents: [], approvals: [], events: [], artifacts: []
      };
    }

    function getState() {
      return immutableCopy({ ...state, run: { ...state.run, elapsedMs: Math.round(activeElapsed()) } });
    }

    function emit() {
      if (destroyed) return;
      if (emitting) {
        emissionPending = true;
        return;
      }
      emitting = true;
      try {
        do {
          emissionPending = false;
          const snapshot = getState();
          for (const listener of [...listeners]) {
            if (destroyed) break;
            if (!listeners.has(listener)) continue;
            try { listener(snapshot); } catch (_) { /* A view cannot interrupt the workflow. */ }
          }
        } while (emissionPending && !destroyed);
      } finally {
        emitting = false;
      }
    }

    function event(type, summary, detail = {}) {
      boundedPush(state.events, {
        id: state.run.id + '-event-' + (++eventNumber), type, at: now(),
        taskId: detail.taskId || null, agentId: detail.agentId || null, toolId: detail.toolId || null,
        level: detail.level || 'info', summary,
        ...(detail.artifactId ? { artifactId: detail.artifactId } : {})
      }, EVENT_LIMIT);
    }

    function log(tool, text, level = 'info') {
      boundedPush(tool.logs, { id: state.run.id + '-log-' + (++logNumber), at: now(), level, text }, LOG_LIMIT);
    }

    function cancelTaskTimer(taskId, preserveDelay = false) {
      const entry = timers.get(taskId);
      if (entry) {
        if (preserveDelay) remainingDelays.set(taskId, Math.max(0, entry.dueAt - now()));
        timers.delete(taskId);
        clearTimer(entry.handle);
      }
      if (!preserveDelay) remainingDelays.delete(taskId);
    }

    function cancelAllTimers() {
      for (const taskId of [...timers.keys()]) cancelTaskTimer(taskId);
      remainingDelays.clear();
    }

    function updateRunStatus() {
      let status = 'ready';
      if (cancelled) status = 'cancelled';
      else if (started && state.tasks.every(task => task.status === 'succeeded')) status = 'succeeded';
      else if (paused) status = 'paused';
      else if (state.tasks.some(task => task.status === 'running')) status = 'running';
      else if (started && state.tasks.some(task => task.status === 'failed')) status = 'failed';
      else if (started && state.tasks.some(task => task.status === 'blocked')) status = 'blocked';
      else if (started) status = 'queued';

      const previous = state.run.status;
      const timestamp = now();
      if (status === 'running' && activeSince === null) activeSince = timestamp;
      if (status !== 'running' && activeSince !== null) {
        elapsedBase += Math.max(0, timestamp - activeSince);
        activeSince = null;
      }
      state.run.status = status;
      state.run.elapsedMs = Math.round(activeElapsed());
      if (status === 'succeeded' && previous !== 'succeeded') {
        event('run.succeeded', 'Local demo completed. All available outputs are authored samples.');
      }
      if (status === 'failed' && previous !== 'failed') {
        event('run.failed', 'Local demo stopped at the simulated analysis error. Retry can continue from completed prerequisites.', { level: 'error' });
      }
    }

    function markDescendantsBlocked(taskId, reason) {
      const blockedIds = new Set([taskId]);
      for (const task of state.tasks) {
        if (task.id === taskId || !task.dependencies.some(id => blockedIds.has(id))) continue;
        blockedIds.add(task.id);
        if (task.status === 'succeeded' || task.status === 'failed' || task.status === 'cancelled') continue;
        cancelTaskTimer(task.id);
        task.status = 'blocked';
        const tool = toolFor(task);
        tool.status = 'blocked';
        const agent = agentFor(task);
        if (agent) agent.status = 'blocked';
        event('task.blocked', task.title + ' is blocked: ' + reason, { taskId: task.id, toolId: tool.id, agentId: agent?.id, level: 'warning' });
      }
    }

    function requestApproval(task) {
      const current = approvalFor(task);
      if (current) return current;
      const tool = toolFor(task);
      const approval = {
        id: state.run.id + '-approval-' + (++approvalNumber), taskId: task.id, toolId: tool.id,
        title: 'Approve sample Python analysis',
        description: 'Allow the local demo to advance through a simulated RC sweep. The command below is a preview and will not execute.',
        command: ANALYSIS_COMMAND, cwd: CWD,
        scope: 'Simulated output: results/rc_sweep.csv within /workspace/biosignal-circuits.',
        impact: 'This preview changes no project files. A future execution adapter would write only the listed analysis output.',
        status: 'pending', createdAt: now(), resolvedAt: null
      };
      boundedPush(state.approvals, approval, APPROVAL_LIMIT);
      currentApprovalIds.set(task.id, approval.id);
      task.status = 'blocked';
      tool.status = 'blocked';
      tool.exitCode = null;
      log(tool, 'Awaiting an explicit simulated approval. No command has been executed.');
      event('approval.requested', 'Sample Python analysis is waiting for approval.', { taskId: task.id, toolId: tool.id });
      return approval;
    }

    function scheduleTask(task, delay = tickMs) {
      if (destroyed || paused || cancelled || task.status !== 'running' || timers.has(task.id)) return;
      const entry = { handle: null, dueAt: now() + Math.max(0, delay) };
      timers.set(task.id, entry);
      entry.handle = setTimer(() => {
        // Entry identity also rejects a callback that was already queued when
        // pause, cancel, retry, reset, or destroy removed its timer.
        if (destroyed || timers.get(task.id) !== entry) return;
        timers.delete(task.id);
        if (paused || cancelled || task.status !== 'running') return;
        advanceTask(task);
      }, Math.max(0, delay));
    }

    function startTask(task) {
      task.status = 'running';
      const tool = toolFor(task);
      tool.status = 'running';
      tool.exitCode = null;
      let agent = agentFor(task);
      if (!agent) {
        agent = {
          id: state.run.id + '-agent-' + task.id, taskId: task.id, name: task.agentName, role: task.role,
          status: 'running', spawnedAt: now(), completedAt: null
        };
        state.agents.push(agent);
        event('agent.spawned', task.agentName + ' joined the local demo to ' + task.title.toLowerCase() + '.', { taskId: task.id, agentId: agent.id, toolId: tool.id });
      } else {
        agent.status = 'running';
        agent.completedAt = null;
        event('agent.restarted', task.agentName + ' restarted this sample task.', { taskId: task.id, agentId: agent.id, toolId: tool.id });
      }
      log(tool, 'Local demo step started. The displayed command is not executed.');
      event('task.started', task.title + ' started in the local demo.', { taskId: task.id, agentId: agent.id, toolId: tool.id });
      scheduleTask(task);
    }

    function dispatch() {
      if (destroyed || !started || paused || cancelled || state.tasks.some(task => task.status === 'failed')) {
        updateRunStatus();
        return;
      }
      let runningCount = state.tasks.filter(task => task.status === 'running').length;
      for (const task of state.tasks) {
        if (task.status !== 'queued' || !dependenciesSucceeded(task)) continue;
        if (task.id === 'analyze') {
          const approval = approvalFor(task) || requestApproval(task);
          if (approval.status !== 'approved') continue;
        }
        if (runningCount >= state.configuration.parallelLimit) continue;
        startTask(task);
        runningCount += 1;
      }
      updateRunStatus();
    }

    function makeArtifactsAvailable(task) {
      for (const id of task.artifactIds) {
        if (state.artifacts.some(artifact => artifact.id === id)) continue;
        const template = ARTIFACTS[id];
        state.artifacts.push({ id, title: template.title, kind: template.kind, taskId: task.id, status: 'available', description: template.description });
        event('artifact.available', template.title + ' is available as a completed sample output.', { taskId: task.id, agentId: agentFor(task)?.id, toolId: toolFor(task).id, artifactId: id });
      }
    }

    function advanceTask(task) {
      const definition = definitionById(task.id);
      const tool = toolFor(task);
      const agent = agentFor(task);
      task.progress = Math.min(task.total, task.progress + 1);

      if (task.id === 'analyze' && state.run.scenario === 'analysis-error' && !failureUsed && task.progress === task.total - 1) {
        failureUsed = true;
        task.status = 'failed';
        tool.status = 'failed';
        tool.exitCode = 1;
        if (agent) {
          agent.status = 'failed';
          agent.completedAt = now();
        }
        log(tool, 'Simulated ValueError: capacitance must be positive. This authored failure scenario ran no process; retry restores valid sample input.', 'error');
        event('task.failed', 'The sample analysis hit its simulated input error at step ' + task.progress + ' of ' + task.total + '.', { taskId: task.id, agentId: agent?.id, toolId: tool.id, level: 'error' });
        markDescendantsBlocked(task.id, 'the sample analysis must succeed first.');
      } else {
        const text = definition.steps[task.progress - 1];
        log(tool, text);
        event('tool.progress', text, { taskId: task.id, agentId: agent?.id, toolId: tool.id });
        if (task.progress === task.total) {
          task.status = 'succeeded';
          tool.status = 'succeeded';
          tool.exitCode = 0;
          if (agent) {
            agent.status = 'succeeded';
            agent.completedAt = now();
          }
          event('task.succeeded', task.title + ' completed in the local demo.', { taskId: task.id, agentId: agent?.id, toolId: tool.id });
          makeArtifactsAvailable(task);
        } else {
          scheduleTask(task);
        }
      }
      dispatch();
      emit();
    }

    function subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('A workspace subscriber must be a function.');
      if (!destroyed) listeners.add(listener);
      try { listener(getState()); } catch (_) { /* Isolate an initial view render as well. */ }
      let subscribed = !destroyed;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        listeners.delete(listener);
      };
    }

    function start() {
      if (destroyed || state.run.status !== 'ready') return getState();
      started = true;
      state.run.startedAt = now();
      event('run.started', 'Local sample workflow started. No external tool, model, or process is running.');
      dispatch();
      emit();
      return getState();
    }

    function pause() {
      if (destroyed || !['running', 'queued', 'blocked'].includes(state.run.status)) return getState();
      paused = true;
      for (const task of state.tasks) {
        if (task.status !== 'running') continue;
        cancelTaskTimer(task.id, true);
        task.status = 'paused';
        const tool = toolFor(task);
        tool.status = 'paused';
        const agent = agentFor(task);
        if (agent) agent.status = 'paused';
        log(tool, 'Local demo paused. Progress and the remaining step delay are preserved.');
      }
      updateRunStatus();
      event('run.paused', 'Local demo paused. Pending approvals still require an explicit decision.');
      emit();
      return getState();
    }

    function resume() {
      if (destroyed || !paused || state.run.status !== 'paused') return getState();
      paused = false;
      for (const task of state.tasks) {
        if (task.status !== 'paused') continue;
        task.status = 'running';
        const tool = toolFor(task);
        tool.status = 'running';
        const agent = agentFor(task);
        if (agent) agent.status = 'running';
        log(tool, 'Local demo resumed from the preserved step.');
        const delay = remainingDelays.has(task.id) ? remainingDelays.get(task.id) : tickMs;
        remainingDelays.delete(task.id);
        scheduleTask(task, delay);
      }
      event('run.resumed', 'Local demo resumed. No pending approval was automatically accepted.');
      dispatch();
      emit();
      return getState();
    }

    function rejectPendingApprovals(summary) {
      for (const approval of state.approvals) {
        if (approval.status !== 'pending') continue;
        approval.status = 'rejected';
        approval.resolvedAt = now();
        event('approval.closed', summary, { taskId: approval.taskId, toolId: approval.toolId, level: 'warning' });
      }
    }

    function cancelInternal() {
      cancelAllTimers();
      cancelled = true;
      paused = false;
      for (const task of state.tasks) {
        if (TERMINAL_TASK_STATES.has(task.status)) continue;
        task.status = 'cancelled';
        const tool = toolFor(task);
        tool.status = 'cancelled';
        tool.exitCode = null;
        log(tool, 'Local demo cancelled. No further steps will advance.');
        const agent = agentFor(task);
        if (agent) {
          agent.status = 'cancelled';
          agent.completedAt = now();
        }
      }
      rejectPendingApprovals('The pending simulated approval was closed because the local demo was cancelled.');
      updateRunStatus();
      event('run.cancelled', 'Local demo cancelled. All scheduled demo callbacks were invalidated.');
    }

    function cancel() {
      if (destroyed || !['running', 'queued', 'blocked', 'paused'].includes(state.run.status)) return getState();
      cancelInternal();
      emit();
      return getState();
    }

    function decideApproval(id, decision) {
      if (destroyed || cancelled || !['approved', 'rejected', 'approve', 'reject'].includes(decision)) return getState();
      const approval = state.approvals.find(item => item.id === id);
      if (!approval || approval.status !== 'pending' || currentApprovalIds.get(approval.taskId) !== id) return getState();
      const status = decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : decision;
      const task = taskById(approval.taskId);
      const tool = toolFor(task);
      approval.status = status;
      approval.resolvedAt = now();
      if (status === 'approved') {
        task.status = 'queued';
        tool.status = 'queued';
        log(tool, 'Simulated approval accepted. The sample analysis may advance when the demo is running.');
        event('approval.approved', 'The sample Python analysis was approved for this local demo attempt.', { taskId: task.id, toolId: tool.id });
      } else {
        task.status = 'blocked';
        tool.status = 'blocked';
        log(tool, 'Simulated approval rejected. Retry this task to request a fresh decision.', 'warning');
        event('approval.rejected', 'The sample Python analysis was rejected. Its dependent tasks are blocked until retry.', { taskId: task.id, toolId: tool.id, level: 'warning' });
        markDescendantsBlocked(task.id, 'the simulated analysis approval was rejected.');
      }
      dispatch();
      emit();
      return getState();
    }

    function retryTask(id) {
      if (destroyed || !started || state.run.status === 'succeeded') return getState();
      const requested = taskById(id);
      if (!requested || !['failed', 'blocked', 'cancelled'].includes(requested.status)) return getState();

      // Retry unresolved prerequisites as needed, preserving every completed
      // task. This also makes a cancelled partial run safe to continue.
      const retryIds = new Set([requested.id]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const task of state.tasks) {
          if (task.status === 'succeeded') continue;
          if (retryIds.has(task.id)) {
            for (const dependencyId of task.dependencies) {
              if (taskById(dependencyId).status !== 'succeeded' && !retryIds.has(dependencyId)) {
                retryIds.add(dependencyId);
                changed = true;
              }
            }
          }
          if (task.dependencies.some(dependencyId => retryIds.has(dependencyId)) && !retryIds.has(task.id)) {
            retryIds.add(task.id);
            changed = true;
          }
        }
      }

      for (const task of state.tasks) {
        if (!retryIds.has(task.id) || task.status === 'succeeded') continue;
        cancelTaskTimer(task.id);
        const currentApproval = approvalFor(task);
        if (currentApproval?.status === 'pending') {
          currentApproval.status = 'rejected';
          currentApproval.resolvedAt = now();
          event('approval.superseded', 'A previous pending simulated approval was replaced by a retry.', { taskId: task.id, toolId: toolFor(task).id, level: 'warning' });
        }
        currentApprovalIds.delete(task.id);
        task.status = 'queued';
        task.progress = 0;
        const tool = toolFor(task);
        tool.status = 'queued';
        tool.exitCode = null;
        const agent = agentFor(task);
        if (agent) {
          agent.status = 'queued';
          agent.completedAt = null;
        }
        state.artifacts = state.artifacts.filter(artifact => artifact.taskId !== task.id);
      }
      cancelled = false;
      log(toolFor(requested), 'Local demo retry requested. Completed prerequisites are preserved; analysis needs a fresh simulated approval.');
      event('task.retry', requested.title + ' was queued for a local demo retry.', { taskId: requested.id, agentId: agentFor(requested)?.id, toolId: toolFor(requested).id });
      const analysis = taskById('analyze');
      if (retryIds.has('analyze') && analysis.status === 'queued' && dependenciesSucceeded(analysis)) requestApproval(analysis);
      dispatch();
      emit();
      return getState();
    }

    function setScenario(scenario) {
      if (destroyed || state.run.status !== 'ready' || !SCENARIOS.has(scenario) || state.run.scenario === scenario) return getState();
      state.run.scenario = scenario;
      event('scenario.changed', scenario === 'analysis-error' ? 'Selected the sample scenario with one recoverable analysis error.' : 'Selected the successful sample scenario.');
      emit();
      return getState();
    }

    function configure(configuration = {}) {
      if (destroyed || !configuration || typeof configuration !== 'object') return getState();
      const limit = configuration.parallelLimit;
      if (!validParallelLimit(limit) || limit === state.configuration.parallelLimit) return getState();
      state.configuration.parallelLimit = limit;
      event('configuration.changed', 'Local demo concurrency is now limited to ' + limit + ' active ' + (limit === 1 ? 'task' : 'tasks') + '.');
      // Lowering the limit never interrupts a task that has already started.
      if (started && !['succeeded', 'failed', 'cancelled'].includes(state.run.status)) dispatch();
      emit();
      return getState();
    }

    function reset() {
      if (destroyed) return getState();
      cancelAllTimers();
      const scenario = state.run.scenario;
      const parallelLimit = state.configuration.parallelLimit;
      currentApprovalIds.clear();
      started = false;
      paused = false;
      cancelled = false;
      failureUsed = false;
      elapsedBase = 0;
      activeSince = null;
      state = freshState(scenario, parallelLimit);
      emit();
      return getState();
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      if (['running', 'queued', 'blocked', 'paused'].includes(state.run.status)) cancelInternal();
      else cancelAllTimers();
      listeners.clear();
      emissionPending = false;
    }

    state = freshState(SCENARIOS.has(settings.scenario) ? settings.scenario : 'success', validParallelLimit(settings.parallelLimit) ? settings.parallelLimit : 2);

    return Object.freeze({ getState, subscribe, start, pause, resume, cancel, retryTask, decideApproval, setScenario, configure, reset, destroy });
  }

  window.AthenaWorkspaceStore = Object.freeze({ create });
})();
