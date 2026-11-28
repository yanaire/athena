/* Athena research workspace views. Runtime projections and separate authored examples; never a process runner.
 * Store subscriptions update individual regions; mounted filters survive clock ticks.
 * Public API: AthenaWorkspaceViews.mount(host, { store, icons, toast, onNavigate,
 * onApproval, records, onExport }) -> { open(view, selection), focus(), getState(), destroy() }.
 */
(() => {
  'use strict';

  const PDF_URL = 'assets/sample-research-note.pdf';
  const VIEWS = {
    workflow: ['Workflow', 'Follow the tasks and the dependencies between them.', 'git-branch'],
    artifacts: ['Artifacts', 'Inspect the authored examples and local demo outputs.', 'files'],
    timeline: ['Timeline', 'Task, agent, and tool events in chronological order.', 'history']
  };
  const STATUS = { ready: 'Ready', queued: 'Queued', running: 'Running', cancelling: 'Cancelling', paused: 'Paused', blocked: 'Waiting', succeeded: 'Complete', failed: 'Failed', cancelled: 'Cancelled', timed_out: 'Timed out', interrupted: 'Interrupted' };
  const ARTIFACTS = [
    { id: 'response-plot', title: 'Frequency response', kind: 'plot', taskId: 'analyze', icon: 'chart-no-axes-combined', filename: 'sample-response.csv', description: 'Calculated response and component tolerance envelope.' },
    { id: 'validation-table', title: 'Evidence & validation', kind: 'evidence', taskId: 'review', icon: 'table-2', filename: 'sample-validation.csv', description: 'Claims connected to inspectable, local supporting material.' },
    { id: 'analysis-code', title: 'Analysis code', kind: 'code', taskId: 'analyze', icon: 'file-code-2', filename: 'sample-rc-analysis.py', description: 'Reproducible analytic calculation, with a readable change view.' },
    { id: 'research-brief', title: 'Source reference note', kind: 'reference', taskId: 'sources', icon: 'notebook-text', filename: 'sample-reference-note.md', description: 'Authored circuit assumptions and formula reference.' },
    { id: 'research-note', documentId: 'research-note', title: 'Research note', kind: 'document', taskId: 'write', icon: 'file-text', filename: 'research-note.md', description: 'The current document revision, with its preserved evidence and review state.' }
  ];
  const R = 1000, C = 100e-9;
  const cutoff = (r, c) => 1 / (2 * Math.PI * r * c);
  const gain = (f, r = R, c = C) => -10 * Math.log10(1 + Math.pow(2 * Math.PI * f * r * c, 2));
  const FC = cutoff(R, C), LOW = cutoff(R * 1.01, C * 1.05), HIGH = cutoff(R * .99, C * .95);
  const FREQUENCIES = [10, 100, 500, 1000, FC, 2000, 5000, 10000, 100000];
  const DATA = FREQUENCIES.map(f => ({ frequency: f, baseline: gain(f), low: gain(f, R * 1.01, C * 1.05), high: gain(f, R * .99, C * .95) }));
  const CODE = `"""Authored local example. Analytic RC response; no simulator required."""
import csv
import math

R_OHM = 1000.0
C_FARAD = 100e-9
R_TOL = 0.01
C_TOL = 0.05

def cutoff(r, c):
    return 1.0 / (2.0 * math.pi * r * c)

def gain_db(f, r, c):
    return -10.0 * math.log10(1.0 + (2.0 * math.pi * f * r * c) ** 2)

fc = cutoff(R_OHM, C_FARAD)
frequencies = [10, 100, 500, 1000, fc, 2000, 5000, 10000, 100000]
corners = [
    (R_OHM * (1 + R_TOL), C_FARAD * (1 + C_TOL)),
    (R_OHM * (1 - R_TOL), C_FARAD * (1 - C_TOL)),
]
with open("sample-response.csv", "w", newline="") as handle:
    writer = csv.writer(handle)
    writer.writerow(["frequency_hz", "baseline_db", "low_db", "high_db"])
    for f in frequencies:
        writer.writerow([f, gain_db(f, R_OHM, C_FARAD),
                         gain_db(f, *corners[0]), gain_db(f, *corners[1])])

print(f"Nominal cutoff: {fc:.3f} Hz")
print(f"Tolerance interval: {cutoff(*corners[0]):.3f} to {cutoff(*corners[1]):.3f} Hz")
assert abs(gain_db(fc, R_OHM, C_FARAD) + 3.01029995664) < 1e-9
`;
  const DIFF = [
    ['context', ' R_OHM = 1000.0'], ['context', ' C_FARAD = 100e-9'],
    ['added', '+R_TOL = 0.01'], ['added', '+C_TOL = 0.05'],
    ['context', ' '], ['removed', '-# Calculate only the nominal component values.'],
    ['added', '+# Add the two monotonic tolerance corners.'],
    ['added', '+corners = ['], ['added', '+    (R_OHM * (1 + R_TOL), C_FARAD * (1 + C_TOL)),'],
    ['added', '+    (R_OHM * (1 - R_TOL), C_FARAD * (1 - C_TOL)),'], ['added', '+]'],
    ['context', ' '], ['removed', '-writer.writerow([f, gain_db(f, R_OHM, C_FARAD)])'],
    ['added', '+writer.writerow([f, gain_db(f, R_OHM, C_FARAD),'],
    ['added', '+                 gain_db(f, *corners[0]), gain_db(f, *corners[1])])']
  ];
  const PAGES = [
    { eyebrow: '01 / Model & assumptions', title: 'RC low-pass verification', paragraphs: [
      { text: 'Authored sample research note. This document illustrates the Athena workspace using synthetic analytic data. It is not an external paper, an experimental record, or a clinical result.' },
      { heading: 'Circuit model', text: 'The circuit is an ideal first-order RC low-pass filter. A 1,000-ohm resistor and a 100-nanofarad capacitor define the nominal model. The output is measured across the capacitor, and the load impedance is assumed infinite.', cite: 'reference' },
      { heading: 'Transfer function', text: 'H(jω) = 1 / (1 + jωRC). The magnitude in decibels is −10 log₁₀[1 + (2πfRC)²]. The cutoff frequency is f₍c₎ = 1 / (2πRC).', cite: 'formula' },
      { heading: 'Scope', text: 'The sample excludes source impedance, capacitor parasitics, temperature dependence, instrument noise, and loading. Those conditions must be added before comparing with a physical measurement.' }
    ] },
    { eyebrow: '02 / Calculated results', title: 'Response & tolerances', paragraphs: [
      { heading: 'Nominal cutoff', text: 'Using the stated component values, the calculated cutoff is ' + FC.toFixed(3) + ' Hz. At that frequency, the analytic gain is −3.0103 dB relative to the low-frequency gain.', cite: 'cutoff' },
      { heading: 'Component bounds', text: 'The sample assumes a resistor tolerance of ±1% and a capacitor tolerance of ±5%. Increasing both values gives the lowest cutoff; decreasing both gives the highest cutoff. The interval is ' + LOW.toFixed(3) + '–' + HIGH.toFixed(3) + ' Hz.', cite: 'tolerance' },
      { heading: 'Response table', text: 'Nine frequencies from 10 Hz to 100 kHz are computed from the same formula. The workspace plot and downloadable CSV use those exact values; the drawn curves use additional log-spaced points for a smooth analytic view.', cite: 'response' },
      { heading: 'Interpretation', text: 'This interval is a deterministic bound for the stated component limits. It is not a confidence interval, a probability distribution, or evidence of measured performance.' }
    ] },
    { eyebrow: '03 / Verification & provenance', title: 'Traceable local evidence', paragraphs: [
      { heading: 'Calculation checks', text: 'The nominal cutoff is substituted back into the response formula. The result agrees with −10 log₁₀(2) to numerical precision. The tolerance corners are checked against the inverse relationship between cutoff and the product RC.', cite: 'validation' },
      { heading: 'Reproduction', text: 'The included Python example uses only the standard library. It calculates the nominal and tolerance responses, writes a CSV, and checks the cutoff identity. The demo interface does not launch Python or any other process.', cite: 'code' },
      { heading: 'Local references', text: '[1] Source reference note: authored assumptions and transfer function. [2] Analysis code and frequency-response CSV: formula-derived sample values. [3] Evidence & validation: claim-to-source checks. Each is available in the Example library.' },
      { heading: 'Next research step', text: 'For a real experiment, record component measurements, source and load impedances, the instrument setup, and repeated sweeps. Keep measured data separate from this authored sample.' }
    ] }
  ];
  const EVIDENCE = [
    { claim: 'Nominal cutoff is ' + FC.toFixed(3) + ' Hz.', source: 'Reference · model', target: 'research-brief', cite: 'formula', support: 'Direct substitution', detail: '1 / (2π × 1000 × 100 × 10⁻⁹).' },
    { claim: 'Cutoff gain is −3.0103 dB.', source: 'Analysis code', target: 'analysis-code', cite: 'cutoff', support: 'Identity checked', detail: 'At f = f₍c₎, magnitude² = 1/2.' },
    { claim: 'Tolerance interval is ' + LOW.toFixed(3) + '–' + HIGH.toFixed(3) + ' Hz.', source: 'Response · tolerance', target: 'response-plot', cite: 'tolerance', support: 'Bounds checked', detail: 'R ±1%, C ±5%; no probability claim.' },
    { claim: 'Results describe an ideal circuit.', source: 'Reference · scope', target: 'research-brief', cite: 'reference', support: 'Scope explicit', detail: 'No physical measurements or external papers.' }
  ];
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const icon = name => '<i data-lucide="' + esc(name) + '" aria-hidden="true"></i>';
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const label = value => STATUS[value] || String(value || 'Queued');
  const badge = value => '<span class="awv-status awv-status-' + esc(value || 'queued') + '"><span></span>' + esc(label(value)) + '</span>';
  const time = value => value ? new Date(value).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
  const csvCell = value => '"' + String(value).replace(/"/g, '""') + '"';
  const responseCSV = () => 'frequency_hz,baseline_db,tolerance_low_db,tolerance_high_db\n' + DATA.map(row => [row.frequency, row.baseline, row.low, row.high].map(v => v.toFixed(6)).join(',')).join('\n') + '\n';
  const evidenceCSV = () => 'claim,source,support,detail\n' + EVIDENCE.map(row => [row.claim, row.source, row.support, row.detail].map(csvCell).join(',')).join('\n') + '\n';
  const referenceText = () => '# Source reference note\n\nAuthored sample, not an external paper.\n\n' + PAGES[0].paragraphs.map(p => (p.heading ? '## ' + p.heading + '\n\n' : '') + p.text).join('\n\n') + '\n';
  const noteText = () => PAGES.map(page => '# ' + page.title + '\n\n' + page.paragraphs.map(p => (p.heading ? '## ' + p.heading + '\n\n' : '') + p.text).join('\n\n')).join('\n\n---\n\n') + '\n';

  function mount(host, options = {}) {
    if (!host || !options.store?.getState || !options.store?.subscribe) throw new Error('Workspace views require a host and a workspace store.');
    const store = options.store;
    const abort = new AbortController();
    const urls = new Set(), timers = new Set(), diagnosticState = new Map();
    const state = { view: 'workflow', taskId: 'sources', workflowMode: 'graph', workflowRunId: null, workflowFollowLatest: true, graphZoom: 100, graphFit: false, artifactId: 'response-plot', artifactVersion: null, documentVersion: null, referenceOpen: false, codeTab: 'source', baseline: true, tolerance: true, table: false, noteMode: 'text', notePage: 1, noteZoom: 100, highlights: true, citation: null, agentSessionId: '', timelineTask: 'all', timelineType: 'all' };
    let snapshot = store.getState(), destroyed = false, unsubscribe = null, recordUnsubscribe = null, resizeObserver = null;
    let history = { key: '', messages: [], status: '', error: '' };
    let researchService = options.researchService || null, researchBoard = null, graphModel = null;
    const q = selector => host.querySelector(selector);
    const qa = selector => Array.from(host.querySelectorAll(selector));
    const notify = message => options.toast?.(message);
    const refreshIcons = () => options.icons ? options.icons() : window.lucide?.createIcons({ attrs: { 'aria-hidden': 'true' } });
    const tasks = () => snapshot.tasks || [];
    const task = id => tasks().find(item => item.id === id);
    const workflowRuns = () => {
      const runs = new Map();
      for (const item of tasks()) if (item.runId && !runs.has(item.runId)) runs.set(item.runId, { id: item.runId, firstTask: item });
      if (snapshot.run?.id && !runs.has(snapshot.run.id)) runs.set(snapshot.run.id, { id: snapshot.run.id, firstTask: null });
      return [...runs.values()];
    };
    const workflowRunId = () => state.workflowFollowLatest ? snapshot.run?.id || workflowRuns().at(-1)?.id || null : state.workflowRunId;
    const workflowTasks = () => { const runId = workflowRunId(); return tasks().filter(item => !runId || !item.runId || item.runId === runId); };
    const historicalWorkflow = () => live() && state.view === 'workflow' && workflowRunId() && workflowRunId() !== snapshot.run?.id;

    const labels = window.AthenaActivityLabels;
    const taskTitle = (item, fallback) => labels.task(item, tasks(), fallback);
    const agentTitle = agent => labels.agent(agent, tasks());
    const attemptTitle = (id, item) => labels.attempt(id, { ...item, attempts: (snapshot.attempts || []).filter(attempt => attempt.taskId === item?.id) });
    const taskMessage = (value, fallback) => labels.text(value, fallback, [snapshot.sessionId, snapshot.run?.id, ...['tasks', 'agents', 'attempts', 'tools', 'processes'].flatMap(key => (snapshot[key] || []).flatMap(item => [item.id, item.taskId, item.parentTaskId, item.attemptId, item.agentSessionId, item.processId, item.toolId])), ...Object.values(snapshot.retryOperations || {}).map(item => item.requestId)]);
    const artifactTitle = item => labels.text(item.title || item.filename || item.file?.name, 'Result file', [item.id, item.taskId, item.runId, item.agentSessionId, item.attemptId]);
    const live = () => snapshot.mode === 'runtime';
    const artifactList = () => live() ? (snapshot.artifacts || []) : ARTIFACTS;
    const artifactVersion = item => item?.version == null ? '' : String(item.version);
    const artifactKey = item => item.id + '\u241f' + artifactVersion(item);
    const artifact = () => artifactList().find(item => item.id === state.artifactId && (state.artifactVersion == null || artifactVersion(item) === String(state.artifactVersion))) || null;
    const artifactProcess = item => (snapshot.processes || []).find(process => process.id === item?.processId);
    const artifactDownload = item => window.AthenaResultFiles?.href(snapshot.sessionId, item, artifactProcess(item));
    const isAvailable = id => (snapshot.artifacts || []).some(item => item.id === id && (!live() || state.artifactVersion == null || artifactVersion(item) === String(state.artifactVersion)) && (live() ? item.status !== 'unavailable' : item.status === 'available'));
    const can = capability => !live() || snapshot.capabilities?.[capability] === true;
    const scopeKey = value => [value.mode, value.projectId, value.sessionId].join('\u241f');
    let lastScope = scopeKey(snapshot);
    if (live()) { state.artifactId = artifactList()[0]?.id || null; state.artifactVersion = artifactList()[0] ? artifactVersion(artifactList()[0]) : null; }
    function canonicalDocument(item = artifact()) {
      if (!options.records || !item?.documentId && item?.id !== 'research-note') return null;
      if (live() && (!snapshot.projectId || options.records.getState().projectId !== snapshot.projectId)) return null;
      const doc = options.records.getDocument(item.documentId || 'research-note'); if (!doc) return null;
      const versionId = item.documentVersion != null ? String(item.documentVersion) : !live() ? state.documentVersion || doc.currentVersion : null;
      const version = doc.versions.find(entry => entry.version === versionId);
      return version && (!live() || version.persistence === 'host') ? { doc, version } : null;
    }
    function safeLocation(item) {
      const uri = typeof item?.location === 'string' ? item.location : item?.location?.uri;
      if (typeof uri !== 'string') return null;
      try { const url = new URL(uri); return ['https:', 'http:', 'blob:'].includes(url.protocol) && !url.username && !url.password ? uri : null; } catch (_) { return null; }
    }
    const setText = (selector, value) => { const el = q(selector); if (el && el.textContent !== String(value)) el.textContent = String(value); };
    const rememberDiagnostics = el => el.querySelectorAll('[data-aw-diagnostics]').forEach(detail => diagnosticState.set(detail.dataset.awDiagnostics, detail.open));
    const restoreDiagnostics = el => el.querySelectorAll('[data-aw-diagnostics]').forEach(detail => { detail.open = diagnosticState.get(detail.dataset.awDiagnostics) === true; });
    const setHTML = (selector, html) => {
      const el = typeof selector === 'string' ? q(selector) : selector;
      if (!el || el._awvHTML === html) return false;
      const active = document.activeElement;
      const key = el.contains(active) ? active?.dataset?.awvFocus : null;
      const diagnosticKey = el.contains(active) && active?.matches?.('summary') ? active.parentElement?.dataset.awDiagnostics : null;
      const scroll = el.scrollTop;
      rememberDiagnostics(el);
      el.innerHTML = html;
      el._awvHTML = html;
      restoreDiagnostics(el);
      el.scrollTop = scroll;
      if (key) Array.from(el.querySelectorAll('[data-awv-focus]')).find(item => item.dataset.awvFocus === key)?.focus({ preventScroll: true });
      else if (diagnosticKey) Array.from(el.querySelectorAll('[data-aw-diagnostics]')).find(item => item.dataset.awDiagnostics === diagnosticKey)?.querySelector('summary')?.focus({ preventScroll: true });
      return true;
    };
    const press = (selector, selected) => qa(selector).forEach(el => el.setAttribute('aria-pressed', String(el.dataset.awvValue === selected)));
    const ava = (item, agentId = null) => {
      const agent = (snapshot.agents || []).find(entry => agentId ? entry.id === agentId : item && entry.taskId === item.id);
      if (!agent) return '<span class="awv-unassigned-mark" aria-hidden="true">' + icon('circle') + '</span>';
      return window.AthenaAvatars?.html({ agentId: agent.id, role: agent.role || item?.role || 'researcher', status: agent.status === 'succeeded' ? 'done' : ['cancelled', 'failed'].includes(agent.status) ? 'stopped' : agent.status === 'blocked' ? 'waiting' : agent.status, size: 30 }) || icon('circle');
    };

    host.classList.add('awv-host');

    function headerHTML() {
      const view = VIEWS[state.view];
      return '<header class="awv-heading"><div class="awv-heading-top"><h2 tabindex="-1" data-awv-heading>' + icon(view[2]) + esc(view[0]) + '</h2><span class="awv-run-status" data-awv-run-status></span></div><p data-awv-view-description>' + view[1] + '</p><div class="awv-heading-meta"><span data-awv-mode-label>UI preview</span><span data-awv-run-time>Not started</span></div><div data-awv-context-details></div></header>';
    }

    function segmented(name, values) {
      return '<div class="awv-segmented" role="group" aria-label="' + esc(name) + '">' + values.map(([value, text, action]) => '<button type="button" data-awv-action="' + action + '" data-awv-value="' + value + '" data-awv-focus="' + action + '-' + value + '" aria-pressed="false">' + text + '</button>').join('') + '</div>';
    }

    function workflowShell() {
      return '<div class="awv-scroll"><label class="awv-artifact-selector" data-awv-run-selector hidden><span>Conversation request</span><select data-awv-run-select aria-label="Select conversation request"></select></label><div class="awv-toolbar">' + segmented('Workflow layout', [['graph', 'Graph', 'workflow-mode'], ['list', 'List', 'workflow-mode']]) + '<span class="awv-caption" data-awv-task-count></span></div><div data-awv-workflow-map></div><section class="awv-task-detail" data-awv-task-detail></section><div data-awv-measurements></div><div data-awv-research-board></div></div>';
    }

    function artifactShell() {
      return '<div class="awv-scroll"><label class="awv-artifact-selector"><span>Artifact</span><select data-awv-artifact-select aria-label="Select artifact">' + artifactList().map(item => '<option value="' + esc(live() ? artifactKey(item) : item.id) + '">' + esc(artifactTitle(item)) + (live() ? ' · ' + esc(artifactVersion(item) || 'Version not reported') : '') + '</option>').join('') + '</select></label><div class="awv-artifact-provenance" data-awv-provenance></div><div data-awv-artifact-view></div></div>';
    }

    function timelineShell() {
      return '<div class="awv-scroll"><section class="awv-task-detail" aria-label="Agent history" data-awv-agent-history hidden><label class="awv-artifact-selector"><span>Agent conversation</span><select data-awv-agent-select></select></label><p class="awv-caption awv-record-identity" data-awv-agent-status role="status"></p><div data-awv-agent-work></div><ul class="awv-events" data-awv-agent-messages></ul></section><div class="awv-fields"><label><span>Task</span><select data-awv-timeline-task aria-label="Filter timeline by task"></select></label><label><span>Event type</span><select data-awv-timeline-type aria-label="Filter timeline by event type"><option value="all">All events</option><option value="run">Run</option><option value="task">Task</option><option value="agent">Agent</option><option value="tool">Tool</option><option value="approval">Approval</option><option value="artifact">Artifact</option></select></label></div><div class="awv-toolbar awv-timeline-toolbar"><span class="awv-caption" data-awv-event-count></span><div class="awv-toolbar-actions"><button class="awv-text-button" type="button" data-awv-action="latest-event" title="Scroll to the latest visible event">Latest' + icon('arrow-down') + '</button><button class="awv-icon-button" type="button" data-awv-action="download-events" title="Download filtered events as JSON" aria-label="Download filtered events as JSON">' + icon('download') + '</button></div></div><ol class="awv-timeline" data-awv-events aria-label="Chronological activity"></ol></div>';
    }

    function shell() {
      researchBoard?.destroy(); researchBoard = null;
      rememberDiagnostics(host);
      host.dataset.workspaceView = state.view;
      host.innerHTML = headerHTML() + ({ workflow: workflowShell, artifacts: artifactShell, timeline: timelineShell }[state.view])();
      if (state.view === 'workflow' && window.AthenaResearchBoard) researchBoard = window.AthenaResearchBoard.mount(q('[data-awv-research-board]'), { service: researchService, getWorkspace: () => snapshot, icons: refreshIcons, onNavigate: navigate });
      update(true);
    }

    function updateHeading() {
      const run = snapshot.run || {};
      setText('[data-awv-mode-label]', historicalWorkflow() ? 'Earlier conversation request' : live() ? 'Current conversation' : snapshot.mode === 'demo' ? 'Local demo' : 'UI preview');
      setHTML('[data-awv-context-details]', live() ? labels.diagnostics([['Session ID', snapshot.sessionId], ['Run ID', historicalWorkflow() ? workflowRunId() : run.id]], 'view-context') : '');
      setText('[data-awv-view-description]', live() && state.view === 'artifacts' ? 'Artifacts reported for this session, with exact source versions.' : VIEWS[state.view][1]);
      setHTML('[data-awv-run-status]', historicalWorkflow() ? '<span class="awv-caption">Saved task records</span>' : badge(run.status || 'ready'));
      const elapsed = Math.floor((run.elapsedMs || 0) / 1000);
      setText('[data-awv-run-time]', historicalWorkflow() ? 'Select a task to inspect its recorded outcome' : run.startedAt ? String(Math.floor(elapsed / 60)).padStart(2, '0') + ':' + String(elapsed % 60).padStart(2, '0') + ' elapsed' : live() && run.id ? 'Start time not reported' : 'Not started');
    }

    function syncSelect(selector, items, value) {
      const el = q(selector);
      if (!el) return;
      const signature = items.map(item => item[0] + ':' + item[1]).join('|');
      if (el.dataset.awvOptions !== signature) {
        el.innerHTML = items.map(([id, title]) => '<option value="' + esc(id) + '">' + esc(title) + '</option>').join('');
        el.dataset.awvOptions = signature;
      }
      if (el.value !== value) el.value = value;
      el.title = items.find(item => item[0] === value)?.[1] || '';
    }

    function taskActions(item) {
      if (!item) return '';
      const pending = (snapshot.approvals || []).find(a => a.taskId === item.id && a.status === 'pending');
      const retry = snapshot.retryOperations?.[item.id];
      let result = pending && can('decideApproval') ? '<button type="button" class="awv-button awv-button-accent" data-awv-approval="' + esc(pending.id) + '" data-awv-focus="approval-' + esc(pending.id) + '">' + icon('shield-check') + 'Review approval</button>' : '';
      if (can('retryTask') && (live() ? item.parentTaskId && item.retryable === true || retry?.pending || retry?.accepted : ['failed', 'cancelled'].includes(item.status) || item.status === 'blocked' && !pending)) result += '<button type="button" class="awv-button" data-awv-retry="' + esc(item.id) + '" data-awv-focus="retry-' + esc(item.id) + '"' + (retry?.pending || retry?.accepted ? ' disabled aria-busy="' + Boolean(retry.pending) + '"' : '') + '>' + icon('rotate-ccw') + (retry?.pending ? 'Retrying…' : retry?.accepted ? 'Retry queued' : 'Retry task') + '</button>';
      if (live() && can('cancelTask') && ['queued', 'running', 'blocked'].includes(item.status)) result += '<button type="button" class="awv-button" data-awv-cancel-task="' + esc(item.id) + '" data-awv-focus="cancel-' + esc(item.id) + '"' + (retry?.pending ? ' disabled' : '') + '>' + icon('square') + 'Cancel task</button>';
      if (can('cancelRun') && (!live() || !item.runId || item.runId === snapshot.run?.id) && (live() ? ['queued', 'running', 'blocked'] : ['queued', 'running', 'paused', 'blocked']).includes(snapshot.run?.status)) result += '<button type="button" class="awv-button" data-awv-action="cancel-run" data-awv-focus="cancel-run" title="' + (live() ? 'Request cancellation from TaskManager' : 'Cancel the entire local demo run') + '">' + icon('square') + 'Cancel run</button>';
      return result;
    }

    function taskRecovery(item) {
      if (!live()) return '';
      const retry = snapshot.retryOperations?.[item.id];
      const attempt = (snapshot.attempts || []).find(attempt => attempt.id === item.attemptId);
      const stopped = ['failed', 'paused', 'cancelled'].includes(item.status);
      const fallback = item.status === 'paused' ? 'This task was interrupted before it finished.' : item.status === 'cancelled' ? 'This task was cancelled before it finished.' : 'The agent could not complete this task.';
      return (stopped ? '<p class="awv-caption" data-awv-failure-reason><strong>Why it stopped:</strong> ' + esc(taskMessage(attempt?.error, fallback)) + '</p>' : '')
        + (retry?.error ? '<p class="awv-caption" role="alert" data-awv-retry-error>Retry was not confirmed. ' + esc(taskMessage(retry.error, 'Check the connection and try again.')) + '</p>' : '')
        + (retry?.accepted ? '<p class="awv-caption" role="status">Retry accepted. Waiting for the task update.</p>' : '')
        + (stopped && item.parentTaskId && item.retryable === false && item.retryUnavailableReason && !retry?.pending ? '<p class="awv-caption">' + esc(taskMessage(item.retryUnavailableReason, 'This task cannot be retried yet.')) + '</p>' : '');
    }

    function taskProgress(item) {
      if (item.total == null || item.progress == null) return null;
      const total = Number(item.total), progress = Number(item.progress);
      return Number.isFinite(total) && total > 0 && Number.isFinite(progress) && progress >= 0 ? { total, progress: clamp(progress, 0, total) } : null;
    }

    function taskOwner(item) {
      const agent = (snapshot.agents || []).find(a => a.taskId === item.id && (!item.agentSessionId || item.agentSessionId === a.agentSessionId));
      return labels.text(item.agentName, '', [item.id, item.agentSessionId, agent?.id]) || (agent ? agentTitle(agent) : labels.text(item.role, live() ? 'Agent not reported' : 'Agent not assigned', [item.id, item.agentSessionId]));
    }
    function taskNode(item, graph = false) {
      const counts = taskProgress(item), title = taskTitle(item);
      const dependencies = (item.dependencies || []).map(id => taskTitle(id, 'Related task'));
      const progress = counts ? '<span class="awv-progress" role="progressbar" aria-label="' + esc(title) + ' progress" aria-valuemin="0" aria-valuemax="' + counts.total + '" aria-valuenow="' + counts.progress + '"><span style="width:' + (counts.progress / counts.total * 100).toFixed(2) + '%"></span></span>' : '<span class="awv-task-dependencies">Progress not reported</span>';
      return '<button type="button" class="awv-task-node' + (state.taskId === item.id ? ' awv-selected' : '') + (graph ? ' awv-graph-node' : '') + '" data-awv-task="' + esc(item.id) + '" data-awv-focus="task-' + esc(item.id) + '" aria-pressed="' + (state.taskId === item.id) + '"><span class="awv-task-avatar">' + ava(item) + '</span><span class="awv-task-copy"><strong>' + esc(title) + '</strong><span class="awv-task-meta">' + esc(taskOwner(item)) + ' · ' + esc(label(item.status)) + '</span>' + (!graph ? '<span class="awv-task-dependencies">' + (dependencies.length ? 'After ' + esc(dependencies.join(' + ')) : 'No dependencies') + '</span>' : '') + progress + '</span>' + (!graph && counts ? '<span class="awv-task-counter">' + counts.progress + '/' + counts.total + '</span>' : '') + '</button>';
    }

    function workflowMap() {
      if (state.workflowMode === 'list' || !window.AthenaWorkflowGraph) {
        graphModel = null;
        return '<div class="awv-task-list">' + workflowTasks().map(item => taskNode(item)).join('') + '</div>';
      }
      graphModel = window.AthenaWorkflowGraph.project({ ...snapshot, run: { ...snapshot.run, id: workflowRunId() }, tasks: workflowTasks() });
      return window.AthenaWorkflowGraph.render(graphModel, { selectedTaskId: state.taskId, taskTitle, taskOwner, avatar: ava });
    }

    function updateGraphViewport() {
      const viewport = q('[data-awg-viewport]'), canvas = q('[data-awg-canvas]'), plane = q('[data-awg-plane]');
      if (!graphModel || !viewport || !canvas || !plane) return;
      if (state.graphFit) state.graphZoom = clamp(Math.floor(((viewport.clientWidth || host.clientWidth || 360) - 4) / graphModel.width * 100), 35, 100);
      const scale = state.graphZoom / 100;
      canvas.style.transform = 'scale(' + scale + ')';
      plane.style.width = Math.ceil(graphModel.width * scale) + 'px';
      plane.style.height = Math.ceil(graphModel.height * scale) + 'px';
      setText('[data-awg-zoom]', state.graphZoom + '%');
      const out = q('[data-awv-action="graph-zoom-out"]'), inside = q('[data-awv-action="graph-zoom-in"]');
      if (out) out.disabled = state.graphZoom <= 35;
      if (inside) inside.disabled = state.graphZoom >= 150;
    }

    function processButton(process) {
      const job = process.job || process;
      const ids = [process.id, process.processId, process.taskId, process.attemptId, process.agentSessionId];
      const registered = window.AthenaResultFiles?.mcp(job.mcp);
      const phase = window.AthenaResultFiles?.mcpPhase(job.mcp);
      const description = job.codeMode ? 'Research comparison' : job.mcp ? [registered?.name || 'Engineering calculation', ['queued', 'running'].includes(process.status) && phase].filter(Boolean).join(' · ')
        : labels.text(job.program, 'Background process', ids);
      return '<button type="button" class="awv-link-row" data-awv-open-process="' + esc(process.id) + '" data-awv-focus="process-' + esc(process.id) + '">' + icon('square-terminal') + '<span>' + esc(description) + '</span><small>' + esc(label(process.status)) + '</small>' + icon('arrow-up-right') + '</button>';
    }

    function orchestrationDetails(item) {
      if (!live()) return '';
      const row = (title, body) => '<div><dt>' + title + '</dt><dd class="awv-record-identity">' + body + '</dd></div>';
      const attempts = (snapshot.attempts || []).filter(attempt => attempt.taskId === item.id);
      const processes = (snapshot.processes || []).filter(process => process.taskId === item.id);
      const agentSessionId = item.agentSessionId || (snapshot.agents || []).find(agent => agent.taskId === item.id && (!item.attemptId || agent.attemptId === item.attemptId))?.agentSessionId;
      const assigned = (snapshot.agents || []).find(agent => agent.agentSessionId === agentSessionId);
      return (item.parentTaskId ? row('Parent task', task(item.parentTaskId) ? '<button type="button" class="awv-link-chip" data-awv-task="' + esc(item.parentTaskId) + '" data-awv-focus="parent-' + esc(item.parentTaskId) + '">' + esc(taskTitle(item.parentTaskId)) + '</button>' : 'Related task') : '')
        + (item.attemptId ? row('Current attempt', esc(attemptTitle(item.attemptId, item))) : '')
        + (agentSessionId ? row('Agent conversation', can('agentHistory') ? '<button type="button" class="awv-link-chip" data-awv-open-agent="' + esc(agentSessionId) + '">' + esc(assigned ? agentTitle(assigned) : 'View agent conversation') + '</button>' : esc(assigned ? agentTitle(assigned) : 'Agent conversation')) : '')
        + (attempts.length ? row('Attempts', attempts.map(attempt => '<p>' + esc(attemptTitle(attempt.id, item)) + ' · ' + esc(label(attempt.status)) + (attempt.kind === 'reconciliation' ? ' · Result update' : '') + (attempt.retryOfAttemptId ? ' · Retry of ' + esc(attemptTitle(attempt.retryOfAttemptId, item)) : '') + (attempt.error ? ' — ' + esc(taskMessage(attempt.error, 'This attempt stopped before completion.')) : '') + (attempt.agentSessionId && attempt.agentSessionId !== agentSessionId && can('agentHistory') ? ' <button type="button" class="awv-link-chip" data-awv-open-agent="' + esc(attempt.agentSessionId) + '">Agent history</button>' : '') + '</p>').join('')) : '')
        + (processes.length ? row('Processes', processes.map(processButton).join('')) : '')
        + row('Identifiers', labels.diagnostics([['Task ID', item.id], ['Parent task ID', item.parentTaskId], ['Dependency IDs', (item.dependencies || []).join(', ')], ['Current attempt ID', item.attemptId], ['Agent session ID', agentSessionId], ...attempts.flatMap(attempt => [[attemptTitle(attempt.id, item) + ' ID', attempt.id], [attemptTitle(attempt.id, item) + ' error', attempt.error]]), ['Retry request ID', snapshot.retryOperations?.[item.id]?.requestId], ['Retry error', snapshot.retryOperations?.[item.id]?.error]], 'task-' + item.id));
    }

    function updateWorkflow() {
      const runs = workflowRuns();
      if (!state.workflowFollowLatest && !runs.some(run => run.id === state.workflowRunId)) state.workflowFollowLatest = true;
      state.workflowRunId = workflowRunId();
      const visibleTasks = workflowTasks();
      if (!visibleTasks.some(item => item.id === state.taskId)) state.taskId = visibleTasks[0]?.id || null;
      const runSelector = q('[data-awv-run-selector]');
      if (runSelector) runSelector.hidden = !live() || runs.length < 2;
      syncSelect('[data-awv-run-select]', runs.map((run, index) => {
        const root = tasks().find(item => item.runId === run.id && !item.parentTaskId) || run.firstTask;
        return [run.id, (run.id === snapshot.run?.id ? 'Current · ' : 'Request ' + (index + 1) + ' · ') + (root ? taskTitle(root) : 'Waiting for tasks')];
      }).reverse(), state.workflowRunId || '');
      press('[data-awv-action="workflow-mode"]', state.workflowMode);
      setText('[data-awv-task-count]', visibleTasks.filter(t => t.status === 'succeeded').length + ' / ' + visibleTasks.length + ' complete');
      const viewport = q('[data-awg-viewport]'), scrollLeft = viewport?.scrollLeft || 0, scrollTop = viewport?.scrollTop || 0;
      setHTML('[data-awv-workflow-map]', workflowMap());
      updateGraphViewport();
      const nextViewport = q('[data-awg-viewport]');
      if (nextViewport) { nextViewport.scrollLeft = scrollLeft; nextViewport.scrollTop = scrollTop; }
      const calculations = live() ? (snapshot.processes || []).filter(p => p.runId === state.workflowRunId && p.job?.mcp) : [];
      setHTML('[data-awv-measurements]', calculations.map(p => {
        const file = p.status === 'succeeded' && artifactList().find(f => f.processId === p.id && f.id === p.job.artifact?.id);
        const registered = window.AthenaResultFiles?.mcp(p.job.mcp);
        const cancellation = window.AthenaResultFiles?.mcpCancellation(p);
        return '<section class="awv-task-detail"><h3>' + esc(taskTitle(p.taskId)) + '</h3>'
          + processButton(p) + (cancellation ? '<p class="awv-caption">' + esc(cancellation) + '</p>' : '') + (p.job.error ? '<p>' + esc(labels.text(p.job.error, 'The calculation needs attention.', [p.id, p.taskId, p.runId, p.attemptId, p.agentSessionId])) + '</p>' : '')
          + (file && artifactDownload(file) ? '<button type="button" class="awv-link-row" data-awv-open-artifact="' + esc(file.id)
            + '" data-awv-version="' + esc(artifactVersion(file)) + '">' + icon('table-2') + esc(registered?.action || 'View saved result') + '</button>' : '') + '</section>';
      }).join(''));
      const item = task(state.taskId);
      if (!item) { setHTML('[data-awv-task-detail]', '<div class="awv-empty"><h3>' + (live() && !snapshot.taskManagerConnected ? 'TaskManager not connected' : 'No tasks in this run') + '</h3><p>' + (live() && !snapshot.taskManagerConnected ? 'The Pi session can report messages and tool activity. Task scheduling, agent assignments, and output links need the Athena TaskManager connection.' : live() ? 'Tasks will appear when the connected TaskManager reports them.' : 'Choose a development scenario to inspect sample tasks.') + '</p></div>'); return; }
      const deps = (item.dependencies || []).map(id => '<button type="button" class="awv-link-chip" data-awv-task="' + esc(id) + '" data-awv-focus="dependency-' + esc(id) + '">' + esc(taskTitle(id, 'Related task')) + '</button>').join('');
      const tools = (snapshot.tools || []).filter(tool => tool.taskId === item.id);
      const outputs = artifactList().filter(a => a.taskId === item.id);
      const counts = taskProgress(item);
      const progressLabel = counts ? counts.progress + ' of ' + counts.total + ' steps' : 'Progress not reported';
      setHTML('[data-awv-task-detail]', '<div class="awv-section-line"><span class="awv-kicker">Selected task</span>' + badge(item.status) + '</div><h3 tabindex="-1" data-awv-detail-heading>' + esc(taskTitle(item)) + '</h3><p class="awv-caption">' + esc(taskOwner(item)) + ' · ' + progressLabel + '</p>' + taskRecovery(item) + '<dl class="awv-detail-list"><div><dt>Depends on</dt><dd>' + (deps || '<span class="awv-caption">No dependencies</span>') + '</dd></div>' + orchestrationDetails(item) + '<div><dt>Tools</dt><dd>' + (tools.map(tool => '<button type="button" class="awv-link-row" data-awv-open-tool="' + esc(tool.id) + '" data-awv-focus="tool-' + esc(tool.id) + '" title="View tool activity in conversation" aria-label="View ' + esc(labels.text(tool.name, 'Tool', [tool.id, tool.taskId])) + ' activity in conversation">' + window.AthenaPiActivity.iconHTML(window.AthenaPiActivity.toolPresentation(tool.sdkToolName || tool.name, tool.args || {}, tool.status).icon) + '<span>' + esc(labels.text(tool.name, 'Tool', [tool.id, tool.taskId])) + '</span><small>' + esc(label(tool.status)) + '</small>' + icon('arrow-up-right') + '</button>').join('') || '<span class="awv-caption">No tool assigned</span>') + '</dd></div><div><dt>Artifacts</dt><dd>' + (outputs.map(a => '<button type="button" class="awv-link-row" data-awv-open-artifact="' + esc(a.id) + '" data-awv-version="' + esc(artifactVersion(a)) + '" data-awv-focus="artifact-' + esc(artifactKey(a)) + '">' + icon(a.icon || 'file-text') + '<span>' + esc(artifactTitle(a)) + '</span><small>' + (live() ? esc(artifactVersion(a) || 'Version not reported') : isAvailable(a.id) ? 'Available' : 'Example') + '</small>' + icon('arrow-up-right') + '</button>').join('') || '<span class="awv-caption">No file output</span>') + '</dd></div></dl><div class="awv-action-row">' + taskActions(item) + '</div>');
    }

    function plotWidth() {
      const chart = q('[data-awv-chart]');
      const measured = chart?.getBoundingClientRect?.().width || chart?.clientWidth || host.clientWidth - 34;
      return Math.max(220, Math.round(measured > 0 ? measured : 360));
    }

    function redrawPlot() {
      if (live() || state.view !== 'artifacts' || state.artifactId !== 'response-plot') return;
      setHTML('[data-awv-chart]', plotSVG());
    }

    function plotSVG() {
      // Match the viewBox to the rendered width, preserving 11px labels at 300px panels.
      const width = plotWidth(), height = width < 320 ? 234 : 250;
      const left = 40, right = width - 25, top = 26, bottom = height - 43;
      const middle = (left + right) / 2;
      const x = f => left + (Math.log10(f) - 1) / 4 * (right - left);
      const y = value => top + (-value / 40) * (bottom - top);
      const points = Array.from({ length: 101 }, (_, i) => Math.pow(10, 1 + i * .04));
      const curve = (r, c) => points.map((f, i) => (i ? 'L' : 'M') + x(f).toFixed(2) + ',' + y(gain(f, r, c)).toFixed(2)).join(' ');
      const upper = points.map((f, i) => (i ? 'L' : 'M') + x(f).toFixed(2) + ',' + y(gain(f, R * .99, C * .95)).toFixed(2)).join(' ');
      const lower = points.slice().reverse().map(f => 'L' + x(f).toFixed(2) + ',' + y(gain(f, R * 1.01, C * 1.05)).toFixed(2)).join(' ');
      const ticks = width < 320 ? [[10, '10'], [1000, '1k'], [100000, '100k']] : [[10, '10'], [100, '100'], [1000, '1k'], [10000, '10k'], [100000, '100k']];
      return '<svg viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="Calculated RC frequency response. Logarithmic frequency from 10 hertz to 100 kilohertz; gain from zero to minus forty decibels."><title>Ideal RC low-pass response</title>' + [0, -10, -20, -30, -40].map(v => '<line x1="' + left + '" x2="' + right + '" y1="' + y(v) + '" y2="' + y(v) + '" class="awv-chart-grid"/><text x="' + (left - 9) + '" y="' + (y(v) + 4) + '" text-anchor="end">' + v + '</text>').join('') + ticks.map(([f, text]) => '<text class="awv-chart-x-tick" x="' + x(f) + '" y="' + (bottom + 18) + '" text-anchor="middle">' + text + '</text>').join('') + '<text x="40" y="12">Gain (dB)</text><text x="' + middle + '" y="' + (height - 4) + '" text-anchor="middle">Frequency (Hz, log scale)</text>' + (state.tolerance ? '<path d="' + upper + ' ' + lower + ' Z" class="awv-tolerance-band"/><path d="' + curve(R * .99, C * .95) + '" class="awv-tolerance-line"/><path d="' + curve(R * 1.01, C * 1.05) + '" class="awv-tolerance-line"/>' : '') + (state.baseline ? '<path d="' + curve(R, C) + '" class="awv-baseline-line"/><line x1="' + x(FC) + '" x2="' + x(FC) + '" y1="' + y(-3.0103) + '" y2="' + bottom + '" class="awv-cutoff-line"/><circle cx="' + x(FC) + '" cy="' + y(-3.0103) + '" r="3.5" class="awv-cutoff-dot"/>' : '') + (!state.baseline && !state.tolerance ? '<text x="' + middle + '" y="' + ((top + bottom) / 2) + '" text-anchor="middle">Select a series above</text>' : '') + '</svg>';
    }

    function plotHTML() {
      return '<section class="awv-artifact-content"><div class="awv-section-line"><h3>Frequency response</h3><button type="button" class="awv-icon-button" data-awv-action="download-artifact" title="Download calculated data as CSV" aria-label="Download calculated data as CSV">' + icon('download') + '</button></div><p class="awv-caption">Ideal RC model · R = 1 kΩ · C = 100 nF</p><div class="awv-series-controls" role="group" aria-label="Visible plot series"><label><input type="checkbox" data-awv-series="baseline"' + (state.baseline ? ' checked' : '') + '><span class="awv-swatch awv-swatch-baseline"></span>Baseline</label><label><input type="checkbox" data-awv-series="tolerance"' + (state.tolerance ? ' checked' : '') + '><span class="awv-swatch awv-swatch-tolerance"></span>Tolerance envelope</label></div><div class="awv-chart" data-awv-chart>' + plotSVG() + '</div><dl class="awv-metrics"><div><dt>Nominal cutoff</dt><dd>' + (FC / 1000).toFixed(4) + '<small> kHz</small></dd></div><div><dt>Tolerance interval</dt><dd class="awv-metric-small">' + (LOW / 1000).toFixed(4) + '–' + (HIGH / 1000).toFixed(4) + '<small> kHz</small></dd></div></dl><p class="awv-footnote">Envelope uses R ±1% and C ±5%. Values are calculated from the ideal transfer function, without a physical measurement.</p><div class="awv-action-row"><button type="button" class="awv-button" data-awv-action="toggle-data" aria-expanded="' + state.table + '">' + icon('table-2') + (state.table ? 'Hide data table' : 'Show data table') + '</button><button type="button" class="awv-text-button" data-awv-open-artifact="validation-table">View evidence' + icon('arrow-up-right') + '</button></div><div data-awv-data-table' + (state.table ? '' : ' hidden') + '>' + responseTable() + '</div></section>';
    }

    function responseTable() {
      return '<div class="awv-table-scroll" tabindex="0" aria-label="Calculated response data"><table class="awv-table"><caption>Formula-derived values. All gains are in decibels.</caption><thead><tr><th scope="col">Frequency<br>Hz</th><th scope="col">Baseline<br>dB</th><th scope="col">Low<br>dB</th><th scope="col">High<br>dB</th></tr></thead><tbody>' + DATA.map(row => '<tr><th scope="row">' + row.frequency.toLocaleString('en-US', { maximumFractionDigits: 2 }) + '</th><td>' + row.baseline.toFixed(3) + '</td><td>' + row.low.toFixed(3) + '</td><td>' + row.high.toFixed(3) + '</td></tr>').join('') + '</tbody></table></div>';
    }

    function codeHTML() {
      return '<section class="awv-artifact-content"><div class="awv-section-line"><h3>sample-rc-analysis.py</h3><span class="awv-file-type">Python</span></div><p class="awv-caption">Standard library only · authored example</p><div class="awv-toolbar">' + segmented('Code view', [['source', 'Source', 'code-tab'], ['diff', 'Diff', 'code-tab']]) + '<div class="awv-toolbar-actions"><button type="button" class="awv-icon-button" data-awv-action="copy-artifact" title="Copy displayed code" aria-label="Copy displayed code">' + icon('copy') + '</button><button type="button" class="awv-icon-button" data-awv-action="download-artifact" title="Download displayed code" aria-label="Download displayed code">' + icon('download') + '</button></div></div><div data-awv-code-content></div><p class="awv-footnote">The diff compares the nominal-only example with the tolerance calculation. No project file is changed by switching views.</p></section>';
    }

    function updateCode() {
      press('[data-awv-action="code-tab"]', state.codeTab);
      setHTML('[data-awv-code-content]', state.codeTab === 'source' ? '<pre class="awv-code" tabindex="0" aria-label="Python source code">' + esc(CODE) + '</pre>' : '<div class="awv-diff" tabindex="0" aria-label="Changes from nominal-only to tolerance calculation">' + DIFF.map(([kind, text]) => '<div class="awv-diff-' + kind + '"><span class="awv-sr-only">' + (kind === 'added' ? 'Added: ' : kind === 'removed' ? 'Removed: ' : '') + '</span><code>' + esc(text) + '</code></div>').join('') + '</div>');
    }

    function evidenceHTML() {
      return '<section class="awv-artifact-content"><div class="awv-section-line"><h3>Evidence & validation</h3><button type="button" class="awv-icon-button" data-awv-action="download-artifact" title="Download evidence table as CSV" aria-label="Download evidence table as CSV">' + icon('download') + '</button></div><p class="awv-caption">Four checkable claims · local sources</p><div class="awv-table-scroll" tabindex="0" aria-label="Claim support table"><table class="awv-table awv-evidence-table"><caption>Authored sample evidence; no external citations.</caption><thead><tr><th scope="col">Claim</th><th scope="col">Source</th><th scope="col">Support</th></tr></thead><tbody>' + EVIDENCE.map(row => '<tr><th scope="row">' + esc(row.claim) + '</th><td><button type="button" class="awv-text-button" data-awv-citation="' + row.cite + '" data-awv-target="' + row.target + '">' + esc(row.source) + icon('arrow-up-right') + '</button></td><td><strong>' + row.support + '</strong><span>' + esc(row.detail) + '</span></td></tr>').join('') + '</tbody></table></div><div class="awv-note-callout">' + icon('notebook-text') + '<p>The support labels describe analytic checks in this sample. They do not indicate an independent study or a measured result.</p></div><button type="button" class="awv-text-button" data-awv-open-artifact="research-note">Read the research note' + icon('arrow-up-right') + '</button></section>';
    }

    function referenceHTML() {
      return '<section class="awv-artifact-content"><div class="awv-section-line"><h3>Source reference note</h3><div class="awv-toolbar-actions"><button type="button" class="awv-icon-button" data-awv-action="copy-artifact" title="Copy reference note" aria-label="Copy reference note">' + icon('copy') + '</button><button type="button" class="awv-icon-button" data-awv-action="download-artifact" title="Download reference note" aria-label="Download reference note">' + icon('download') + '</button></div></div><p class="awv-caption">Reference [1] · authored project sample</p><article class="awv-paper awv-reference">' + PAGES[0].paragraphs.map((p, index) => '<section class="' + (state.citation && (p.cite === state.citation || state.citation === 'formula' && index === 2) ? 'awv-highlight' : '') + '" data-awv-reference="' + (p.cite || index) + '">' + (p.heading ? '<h4>' + p.heading + '</h4>' : '') + '<p>' + esc(p.text) + '</p></section>').join('') + '</article><button type="button" class="awv-text-button" data-awv-open-artifact="validation-table">Open linked evidence' + icon('arrow-up-right') + '</button></section>';
    }

    function originalNoteHTML() {
      return '<section class="awv-artifact-content"><div class="awv-section-line"><h3>Original sample PDF/reference</h3><div class="awv-toolbar-actions"><button type="button" class="awv-icon-button" data-awv-action="copy-original-reference" title="Copy original reference text" aria-label="Copy original reference text">' + icon('copy') + '</button><button type="button" class="awv-icon-button" data-awv-action="download-original-pdf" title="Download the authored sample PDF" aria-label="Download the authored sample PDF">' + icon('download') + '</button></div></div><p class="awv-caption">Immutable authored reference · 3 pages · separate from the current document revision</p><div class="awv-toolbar">' + segmented('Document view', [['text', 'Readable text', 'note-mode'], ['pdf', 'Native PDF', 'note-mode']]) + '</div><div class="awv-document-controls" data-awv-document-controls><div class="awv-page-controls"><button type="button" class="awv-icon-button" data-awv-action="previous-page" title="Previous page" aria-label="Previous page">' + icon('chevron-left') + '</button><label>Page <select data-awv-page-select aria-label="Document page"><option value="1">1 of 3</option><option value="2">2 of 3</option><option value="3">3 of 3</option></select></label><button type="button" class="awv-icon-button" data-awv-action="next-page" title="Next page" aria-label="Next page">' + icon('chevron-right') + '</button></div><div class="awv-zoom-controls"><button type="button" class="awv-icon-button" data-awv-action="zoom-out" title="Decrease text size" aria-label="Decrease text size">' + icon('minus') + '</button><button type="button" class="awv-zoom-reset" data-awv-action="reset-zoom" title="Reset text size to 100 percent" data-awv-zoom-value>100%</button><button type="button" class="awv-icon-button" data-awv-action="zoom-in" title="Increase text size" aria-label="Increase text size">' + icon('plus') + '</button></div><label class="awv-highlight-control"><input type="checkbox" data-awv-highlights' + (state.highlights ? ' checked' : '') + '>Highlight evidence</label></div><div data-awv-document-page></div><p class="awv-footnote" data-awv-pdf-help hidden>The native viewer depends on PDF support in your browser. Readable text above provides the full document, page navigation, zoom, and local evidence links.</p></section>';
    }

    function citeTarget(cite) {
      if (['formula', 'reference'].includes(cite)) return 'research-brief';
      if (['cutoff', 'tolerance', 'response'].includes(cite)) return 'response-plot';
      if (cite === 'code') return 'analysis-code';
      return 'validation-table';
    }

    function updateDocument() {
      if (!q('[data-awv-document-controls]')) return;
      press('[data-awv-action="note-mode"]', state.noteMode);
      const pdf = state.noteMode === 'pdf';
      q('[data-awv-document-controls]').hidden = pdf;
      q('[data-awv-pdf-help]').hidden = !pdf;
      if (pdf) {
        setHTML('[data-awv-document-page]', '<object class="awv-pdf" type="application/pdf" data="' + esc(PDF_URL) + '#page=' + state.notePage + '" aria-label="Authored sample research note PDF"><div class="awv-pdf-fallback"><p>Your browser cannot display this PDF here.</p><button type="button" class="awv-button" data-awv-value="text" data-awv-action="note-mode">Read the full document</button><a class="awv-button" href="' + esc(PDF_URL) + '" download="sample-research-note.pdf">Download PDF</a></div></object>');
        return;
      }
      const page = PAGES[state.notePage - 1];
      const select = q('[data-awv-page-select]'); if (select) select.value = String(state.notePage);
      q('[data-awv-action="previous-page"]').disabled = state.notePage === 1;
      q('[data-awv-action="next-page"]').disabled = state.notePage === PAGES.length;
      q('[data-awv-action="zoom-out"]').disabled = state.noteZoom <= 80;
      q('[data-awv-action="zoom-in"]').disabled = state.noteZoom >= 150;
      setText('[data-awv-zoom-value]', state.noteZoom + '%');
      setHTML('[data-awv-document-page]', '<article class="awv-paper" style="--awv-doc-scale:' + state.noteZoom / 100 + '" aria-label="Research note page ' + state.notePage + '"><span class="awv-paper-eyebrow">' + page.eyebrow + '</span><h4>' + page.title + '</h4>' + page.paragraphs.map(p => '<section class="' + (state.highlights && p.cite ? 'awv-highlight' : '') + '">' + (p.heading ? '<h5>' + p.heading + '</h5>' : '') + '<p>' + esc(p.text) + (p.cite ? ' <button type="button" class="awv-citation" data-awv-citation="' + p.cite + '" data-awv-target="' + citeTarget(p.cite) + '" title="Inspect the local evidence for this paragraph" aria-label="Inspect evidence for ' + esc(p.heading) + '">[' + (['formula', 'reference'].includes(p.cite) ? '1' : p.cite === 'validation' ? '3' : '2') + ']</button>' : '') + '</p></section>').join('') + '<footer>Authored sample · ' + state.notePage + ' / ' + PAGES.length + '</footer></article>');
    }

    function currentArtifactText() {
      const item = artifact(); if (!item) return null;
      const canonical = canonicalDocument(item); if (canonical) return canonical.version.text;
      if (live()) return typeof item.text === 'string' ? item.text : null;
      if (item.kind === 'code') return state.codeTab === 'diff' ? DIFF.map(row => row[1]).join('\n') : CODE;
      if (item.kind === 'reference') return referenceText();
      if (item.kind === 'document') return null;
      return item.kind === 'plot' ? responseCSV() : item.kind === 'evidence' ? evidenceCSV() : null;
    }

    function originalReferenceHTML() {
      if (live()) return '';
      return '<div class="awv-original-reference"><button type="button" class="awv-text-button" data-awv-action="original-reference" data-awv-focus="original-reference" aria-expanded="' + state.referenceOpen + '">' + icon('book-open') + 'Original sample PDF/reference' + icon(state.referenceOpen ? 'chevron-up' : 'chevron-down') + '</button><p class="awv-footnote">The bundled PDF and its evidence describe the original authored sample. They are preserved separately from this document.</p><div data-awv-original-reference' + (state.referenceOpen ? '' : ' hidden') + '>' + (state.referenceOpen ? originalNoteHTML() : '') + '</div></div>';
    }

    function exportReceiptHTML(result) {
      if (!result) return '';
      const location = safeLocation(result);
      return '<p class="awv-footnote">The document service exported ' + esc(result.documentId) + ' · v' + esc(result.version) + '.</p>' + (location ? '<a class="awv-button" href="' + esc(location) + '" target="_blank" rel="noopener noreferrer">Open exported PDF' + icon('arrow-up-right') + '</a>' : '<p class="awv-caption">' + esc(result.location?.uri) + ' · A host file opener is required for this location.</p>');
    }

    function noteHTML() {
      const canonical = canonicalDocument();
      if (!canonical) return '<section class="awv-artifact-content"><h3>Document revision unavailable</h3><p class="awv-caption">The document service has not provided this exact document version.</p>' + originalReferenceHTML() + '</section>';
      const { doc, version } = canonical, selected = version.version;
      const recordState = options.records.getState();
      const pending = recordState.pending.some(key => key.startsWith(doc.documentId + '\u241f'));
      const canExport = recordState.capabilities.exportPDF && !pending && !(doc.draft.dirty && selected === doc.currentVersion);
      const exportResult = (doc.exports || []).findLast(result => result.version === selected);
      const versionSelect = '<label class="awv-record-version"><span>Revision</span><select data-awv-document-version data-awv-focus="document-version" aria-label="Research note revision"' + (live() ? ' disabled title="This artifact references a fixed document version"' : '') + '>' + doc.versions.map(entry => '<option value="' + esc(entry.version) + '"' + (entry.version === selected ? ' selected' : '') + '>v' + esc(entry.version) + (entry.version === doc.currentVersion ? ' · Latest' : '') + '</option>').join('') + '</select></label>';
      const evidence = version.evidence.length ? '<section class="awv-record-evidence"><h4>Evidence versions</h4>' + version.evidence.map(ref => '<p>' + esc(ref.sourceId) + ' · v' + esc(ref.version) + '</p>').join('') + '</section>' : '';
      return '<section class="awv-artifact-content awv-current-document"><div class="awv-section-line"><h3>' + esc(version.title) + '</h3><div class="awv-toolbar-actions"><button type="button" class="awv-icon-button" data-awv-action="copy-artifact" aria-label="Copy this document revision" title="Copy this document revision">' + icon('copy') + '</button><button type="button" class="awv-icon-button" data-awv-action="download-artifact" aria-label="Download this revision as Markdown" title="Download this revision as Markdown">' + icon('download') + '</button></div></div>' +
        '<p class="awv-caption awv-record-identity">' + esc(doc.documentId) + ' · v' + esc(selected) + ' · ' + esc(doc.projectId) + '</p><div class="awv-toolbar">' + versionSelect + '<span class="awv-record-review">' + esc(version.review.status.replaceAll('_', ' ')) + ' · v' + esc(version.review.version) + '</span></div>' +
        (doc.draft.dirty ? '<p class="awv-note-callout">Manuscript has uncommitted edits. This view shows the last kept revision; the edited draft needs its own review.</p>' : '') +
        '<pre class="awv-record-text" tabindex="0" aria-label="Document text for version ' + esc(selected) + '">' + esc(version.text) + '</pre><div class="awv-action-row"><button type="button" class="awv-button" data-awv-action="open-manuscript">' + icon('file-pen-line') + 'Open in Manuscript</button><button type="button" class="awv-button" data-awv-action="export-record-pdf" data-awv-focus="export-record-pdf"' + (canExport ? '' : ' disabled') + ' title="' + (pending ? 'A document service request is in progress' : canExport ? 'Export this exact document version' : 'Connect a document PDF service and keep draft edits as a revision first') + '">' + icon('file-down') + (pending ? 'Working…' : 'Export PDF') + '</button></div>' +
        '<p class="awv-footnote">' + (version.persistence === 'host' ? 'The connected document service confirmed storage of this revision.' : 'This revision is kept in this session. Project document storage has not confirmed a save.') + '</p><div data-awv-export-result>' + exportReceiptHTML(exportResult) + '</div>' + evidence + originalReferenceHTML() + '</section>';
    }

    function liveArtifactHTML(item) {
      const body = typeof item.text === 'string' ? item.text : null;
      const location = artifactProcess(item)?.job?.mcp || item.file?.mcpAlias !== undefined ? null : safeLocation(item);
      const download = artifactDownload(item);
      const file = item.file || item;
      const field = (name, value) => value == null ? '' : '<div><dt>' + name + '</dt><dd>' + esc(value) + '</dd></div>';
      const provenance = field('Filename', file.name) + field('Media type', file.mimeType) + field('Bytes', file.bytes);
      const sourceTask = task(item.taskId);
      const diagnostics = labels.diagnostics([
        ['Artifact ID', item.id], ['Task ID', item.taskId], ['Project ID', item.projectId], ['Run ID', item.runId],
        ['Agent session ID', item.agentSessionId], ['Attempt ID', item.attemptId], ['Tool ID', item.toolId], ['Process ID', item.processId],
        ['Document ID', item.documentId], ['File version ID', file.versionId], ['SHA-256', file.sha256],
        ['Original location', typeof item.location === 'string' ? item.location : item.location?.uri]
      ], 'artifact-' + artifactKey(item));
      const reviewedVersion = item.documentVersion ?? item.version;
      const review = item.review && String(item.review.version) === String(reviewedVersion) ? item.review.status || 'unreviewed' : 'unreviewed';
      const evidence = Array.isArray(item.evidence) ? item.evidence : [];
      return '<section class="awv-artifact-content"><div class="awv-section-line"><h3>' + esc(artifactTitle(item)) + '</h3>'
        + (body != null ? '<div class="awv-toolbar-actions"><button type="button" class="awv-icon-button" data-awv-action="copy-artifact" aria-label="Copy artifact text">' + icon('copy') + '</button>' + (download ? '' : '<button type="button" class="awv-icon-button" data-awv-action="download-artifact" aria-label="Download artifact text">' + icon('download') + '</button>') + '</div>' : '')
        + '</div><dl class="awv-detail-list">' + field('Version', artifactVersion(item) || 'Not reported') + field('Task', item.taskId ? taskTitle(sourceTask || item.taskId) : 'Not reported')
        + (item.attemptId ? field('Attempt', attemptTitle(item.attemptId, sourceTask)) : '') + provenance
        + (item.documentId ? field('Document revision', 'v' + (item.documentVersion ?? 'Not reported')) : '')
        + field('Review', String(review).replaceAll('_', ' ')) + '</dl>' + diagnostics
        + (body != null ? '<pre class="awv-record-text" tabindex="0" aria-label="Reported artifact text">' + esc(body) + '</pre>' : download ? '' : '<p class="awv-empty">This artifact has no text preview. A file reader or renderer for ' + esc(item.kind || 'this type') + ' is not connected.</p>')
        + (download ? '<a class="awv-button" href="' + esc(download) + '" download>Download result file' + icon('download') + '</a>' : '')
        + (location && !download ? '<a class="awv-button" href="' + esc(location) + '" target="_blank" rel="noopener noreferrer">Open original' + icon('arrow-up-right') + '</a>' : '')
        + (item.documentId && item.documentVersion != null ? '<button type="button" class="awv-button" data-awv-action="open-manuscript">Open this document version' + icon('file-pen-line') + '</button>' : '')
        + (evidence.length ? '<section class="awv-record-evidence"><h4>Evidence versions</h4>' + evidence.map(ref => '<p>' + esc(ref.sourceId || ref.artifactId || ref.id || 'Source ID not reported') + ' · v' + esc(ref.version ?? 'Version not reported') + '</p>').join('') + '</section>' : '') + '</section>';
    }

    function mcpResultHTML(kind, data) {
      const record = value => value && typeof value === 'object' && !Array.isArray(value);
      const finite = value => typeof value === 'number' && Number.isFinite(value);
      const count = value => Number.isSafeInteger(value) && value >= 0;
      if (!record(data) || data.schemaVersion !== 1) return null;
      if (kind === 'mcp-result') {
        if (data.kind !== 'external-mcp-result' || !record(data.server) || typeof data.server.name !== 'string'
          || typeof data.tool !== 'string' || !record(data.result) || data.result.isError !== false
          || !Array.isArray(data.result.content) || !data.result.content.every(block => record(block) && block.type === 'text' && typeof block.text === 'string')
          || data.result.structuredContent !== undefined && !record(data.result.structuredContent)) return null;
        const text = data.result.content.map(block => block.text).join('\n\n');
        return '<section data-awv-external-result><h4>Saved MCP result</h4><p class="awv-caption">' + esc(data.server.name) + ' · ' + esc(data.tool) + '</p>'
          + '<p class="awv-caption">This is the saved server response. Links and instructions in the response are shown as text.</p>'
          + (text ? '<pre class="awv-record-text" tabindex="0" aria-label="Saved MCP text">' + esc(text) + '</pre>' : '')
          + (data.result.structuredContent !== undefined ? '<h5>Structured output</h5><pre class="awv-record-text" tabindex="0" aria-label="Saved MCP structured output">' + esc(JSON.stringify(data.result.structuredContent, null, 2)) + '</pre>' : '')
          + (!text && data.result.structuredContent === undefined ? '<p class="awv-caption">The server returned no text or structured output.</p>' : '') + '</section>';
      }
      if (kind === 'rc-step-response') {
        if (!finite(data.timeConstantSeconds) || data.timeConstantSeconds <= 0 || !finite(data.cutoffHz) || data.cutoffHz <= 0
          || !Array.isArray(data.samples) || !data.samples.length || data.samples.length > 512
          || !data.samples.every(sample => record(sample) && finite(sample.timeSeconds) && sample.timeSeconds >= 0 && finite(sample.outputVolt))) return null;
        return '<section data-awv-rc-response><h4>RC step response</h4><dl class="awv-metrics">'
          + '<div><dt>Time constant</dt><dd>' + esc(data.timeConstantSeconds) + '<small> s</small></dd></div>'
          + '<div><dt>Cutoff frequency</dt><dd>' + esc(data.cutoffHz) + '<small> Hz</small></dd></div></dl>'
          + '<p class="awv-caption">Ideal first-order RC low-pass · initial capacitor voltage 0 V · input step at 0 s.</p>'
          + '<p class="awv-caption">Input units: resistance Ω · capacitance F · step voltage V · sample time s.</p>'
          + '<table class="awv-table"><caption>Saved response · ' + data.samples.length + ' samples</caption><thead><tr><th scope="col">Time (s)</th><th scope="col">Output (V)</th></tr></thead><tbody>'
          + data.samples.map(sample => '<tr><td>' + esc(sample.timeSeconds) + '</td><td>' + esc(sample.outputVolt) + '</td></tr>').join('') + '</tbody></table></section>';
      }
      if (kind !== 'csv-statistics' || !count(data.rowCount) || !Array.isArray(data.columns) || !data.columns.every(column => typeof column === 'string')
        || !Array.isArray(data.statistics) || !data.statistics.length || !data.statistics.every(stat => record(stat) && typeof stat.column === 'string' && data.columns.includes(stat.column)
          && count(stat.count) && count(stat.missing) && count(stat.nonNumeric) && stat.count + stat.missing + stat.nonNumeric === data.rowCount
          && [stat.min, stat.mean, stat.max].every(value => stat.count === 0 ? value === null : finite(value)))) return null;
      const fields = ['column', 'count', 'missing', 'nonNumeric', 'min', 'mean', 'max'];
      const headings = ['Column', 'Numeric', 'Missing', 'Nonnumeric', 'Min', 'Mean', 'Max'];
      return '<table class="awv-table"><caption>Measurement statistics · ' + esc(data.rowCount)
        + ' rows</caption><thead><tr>' + headings.map(h => '<th scope="col">' + h + '</th>').join('')
        + '</tr></thead><tbody>' + data.statistics.map(stat => '<tr>' + fields.map((key, index) =>
          index === 0 ? '<th scope="row">' + esc(stat[key]) + '</th>' : '<td>' + esc(stat[key] ?? '—') + '</td>'
        ).join('') + '</tr>').join('') + '</tbody></table>';
    }

    async function renderMcpResult(section, url, resultKind) {
      try {
        const response = await window.fetch(url, { credentials: 'same-origin' });
        if (!response.ok) throw new Error();
        const data = await response.json();
        const html = mcpResultHTML(resultKind, data);
        if (html === null) { section.textContent = 'The saved result format is not supported.'; return; }
        section.innerHTML = html;
      } catch {
        section.textContent = 'Could not load the saved result file.';
      }
    }

    function updateArtifacts(force = false) {
      const items = artifactList();
      if (!state.artifactId && items.length) { state.artifactId = items[0].id; state.artifactVersion = live() ? artifactVersion(items[0]) : null; }
      const item = artifact();
      const values = items.map(entry => [live() ? artifactKey(entry) : entry.id, artifactTitle(entry) + (live() ? ' · ' + (artifactVersion(entry) || 'Version not reported') : '')]);
      if (!item) values.unshift(['', state.artifactId ? 'Requested version unavailable' : 'No artifacts reported']);
      syncSelect('[data-awv-artifact-select]', values, item ? live() ? artifactKey(item) : item.id : '');
      const select = q('[data-awv-artifact-select]'); if (select) select.disabled = !items.length;
      const holder = q('[data-awv-artifact-view]');
      // Empty and populated views invalidate each other's render cache.
      if (!item) delete holder.dataset.awvArtifact;
      if (!item) { setHTML('[data-awv-provenance]', '<span class="awv-provenance-label">' + icon('files') + 'Runtime artifacts</span><p>No example output is substituted for a missing runtime artifact.</p>'); setHTML('[data-awv-artifact-view]', '<div class="awv-empty"><h3>' + (state.artifactId ? 'Artifact version unavailable' : 'No artifacts reported') + '</h3><p>' + (state.artifactId ? 'The requested artifact version is not available in this conversation.' : snapshot.taskManagerConnected ? 'Outputs will appear when tasks produce results.' : 'Connect TaskManager to link output artifacts to tasks.') + '</p>' + (state.artifactId ? labels.diagnostics([['Artifact ID', state.artifactId], ['Version', state.artifactVersion]], 'unavailable-artifact') : '') + '</div>'); return; }
      const available = isAvailable(item.id);
      const canonical = canonicalDocument(item);
      setHTML('[data-awv-provenance]', live() ? '<span class="awv-provenance-label">' + icon('file-text') + 'Runtime artifact</span><p>' + esc(artifactTitle(item)) + ' · v' + esc(artifactVersion(item) || 'not reported') + '</p>' : canonical ? '<span class="awv-provenance-label">' + icon('file-text') + 'Document revision</span><p>' + esc(canonical.doc.documentId) + ' · v' + esc(canonical.version.version) + ' · ' + (canonical.version.persistence === 'host' ? 'Project storage confirmed' : 'Session revision') + '</p>' : '<span class="awv-provenance-label">' + icon(available ? 'circle-check' : 'book-open') + (available ? 'Local demo output' : 'Example library') + '</span><p>' + (available ? 'The matching demo task completed. This remains an authored, synthetic example.' : 'Preview available before the run. This is authored sample material, not a completed run output.') + '</p>');
      const process = live() && artifactProcess(item);
      const registered = process && window.AthenaResultFiles?.mcpOutput(process, item);
      const signature = JSON.stringify([live(), item, process?.status, process?.job?.mcp, process?.job?.artifact, state.citation, state.documentVersion, state.referenceOpen, canonical?.doc, options.records?.getState().capabilities]);
      if (force || holder.dataset.awvArtifact !== signature) {
        const focusKey = holder.contains(document.activeElement) ? document.activeElement?.dataset?.awvFocus : null;
        rememberDiagnostics(holder);
        delete holder._awvHTML;
        holder.innerHTML = canonical ? noteHTML() : live() ? liveArtifactHTML(item) : ({ plot: plotHTML, evidence: evidenceHTML, code: codeHTML, reference: referenceHTML, document: noteHTML }[item.kind] || (() => '<p class="awv-empty">No preview renderer is connected for this artifact.</p>'))();
        const download = process?.job?.mcp && artifactDownload(item);
        if (download) {
          const section = document.createElement('div');
          section.className = 'awv-table-scroll';
          section.setAttribute('aria-live', 'polite');
          section.setAttribute('data-awv-mcp-result', registered?.resultKind || 'unsupported');
          section.textContent = registered ? 'Loading saved ' + ({ 'csv-statistics': 'measurements', 'rc-step-response': 'RC response', 'mcp-result': 'tool result' }[registered.resultKind] || 'result') + '…' : 'A structured preview is not available for this tool version. Download the saved result to inspect it.';
          holder.querySelector('h3').parentElement.after(section);
          // The request owns this element. A late reply can only update its detached old view.
          if (registered) void renderMcpResult(section, download, registered.resultKind);
        }
        restoreDiagnostics(holder);
        holder.dataset.awvArtifact = signature;
        if (focusKey) Array.from(holder.querySelectorAll('[data-awv-focus]')).find(element => element.dataset.awvFocus === focusKey && !element.disabled)?.focus({ preventScroll: true });
      }
      if (!live() && item.kind === 'code') updateCode();
      if (!live() && item.kind === 'document' && state.referenceOpen) updateDocument();
      if (!live() && item.kind === 'plot') redrawPlot();
    }

    function eventGroup(event) {
      const type = String(event.type || '').toLowerCase();
      if (type.includes('approval')) return 'approval';
      if (type.includes('artifact')) return 'artifact';
      if (type.includes('agent') || type.includes('spawn')) return 'agent';
      if (type.includes('tool') || type.includes('log')) return 'tool';
      if (type.includes('task')) return 'task';
      return 'run';
    }

    function filteredEvents() {
      return (snapshot.events || []).filter(event => (state.timelineTask === 'all' || event.taskId === state.timelineTask) && (state.timelineType === 'all' || eventGroup(event) === state.timelineType)).slice().sort((a, b) => Number(a.at) - Number(b.at));
    }

    function updateTimeline() {
      updateAgentHistory();
      syncSelect('[data-awv-timeline-task]', [['all', 'All tasks'], ...tasks().map(t => [t.id, taskTitle(t)])], state.timelineTask);
      const typeSelect = q('[data-awv-timeline-type]'); if (typeSelect && typeSelect.value !== state.timelineType) typeSelect.value = state.timelineType;
      const events = filteredEvents();
      setText('[data-awv-event-count]', events.length + (events.length === 1 ? ' event' : ' events'));
      const html = events.map(event => {
        const group = eventGroup(event), item = task(event.taskId);
        const typeLabel = String(event.type || group).replace(/[._-]/g, ' ');
        const summary = labels.text(event.summary, item ? taskTitle(item) + ' · ' + typeLabel : typeLabel, [event.id, event.taskId, event.agentId, event.toolId, event.runId, event.attemptId, event.agentSessionId, snapshot.sessionId, snapshot.run?.id]);
        const content = '<span class="awv-event-mark">' + (group === 'agent' ? ava(item, event.agentId) : group === 'tool' ? window.AthenaPiActivity.iconHTML(window.AthenaPiActivity.toolPresentation((snapshot.tools || []).find(tool => tool.id === event.toolId)?.sdkToolName || 'custom').icon) : icon(({ run: 'play', task: 'list-checks', tool: 'square-terminal', approval: 'shield-check', artifact: 'file-text' })[group] || 'circle')) + '</span><span class="awv-event-body"><span class="awv-event-meta"><time datetime="' + (event.at && Number.isFinite(new Date(event.at).getTime()) ? new Date(event.at).toISOString() : '') + '">' + time(event.at) + '</time><span>' + esc(typeLabel) + '</span></span><strong>' + esc(summary) + '</strong>' + (item ? '<small>' + esc(taskTitle(item)) + '</small>' : '') + '</span>';
        return '<li data-awv-event-id="' + esc(event.id) + '">' + (event.taskId || event.toolId || event.artifactId ? '<button type="button" class="awv-event" data-awv-event="' + esc(event.id) + '" data-awv-focus="event-' + esc(event.id) + '" title="' + (group === 'tool' ? 'View tool activity in conversation' : 'Inspect this event') + '">' + content + icon('chevron-right') + '</button>' : '<div class="awv-event">' + content + '</div>') + (summary !== event.summary && event.summary ? labels.diagnostics([['Original event summary', event.summary], ['Event ID', event.id], ['Task ID', event.taskId], ['Tool ID', event.toolId]], 'event-' + event.id) : '') + '</li>';
      }).join('');
      setHTML('[data-awv-events]', html || '<li class="awv-empty">' + icon('history') + '<h3>' + ((snapshot.events || []).length ? 'No matching events' : 'The timeline is ready') + '</h3><p>' + ((snapshot.events || []).length ? 'Change the task or event type to see more activity.' : live() ? 'The connected runtime has not reported events for this session.' : 'Start the local demo to record task, agent, and tool activity here.') + '</p>' + (state.timelineTask !== 'all' || state.timelineType !== 'all' ? '<button type="button" class="awv-button" data-awv-action="reset-filters">Reset filters</button>' : '') + '</li>');
      q('[data-awv-action="latest-event"]').disabled = !events.length;
      q('[data-awv-action="download-events"]').disabled = !events.length;
    }

    function updateAgentHistory() {
      const section = q('[data-awv-agent-history]');
      if (!section) return;
      const agents = (snapshot.agents || []).filter(agent => agent.agentSessionId);
      section.hidden = !live() || !snapshot.capabilities?.agentHistory;
      if (section.hidden) { history = { key: '', messages: [], status: '', error: '' }; return; }
      const selected = agents.find(agent => agent.agentSessionId === state.agentSessionId);
      syncSelect('[data-awv-agent-select]', [['', 'Choose an agent'], ...agents.map(agent => [agent.agentSessionId, agentTitle(agent) + ' · ' + taskTitle(agent.taskId)])], selected?.agentSessionId || '');
      q('[data-awv-agent-select]').disabled = !agents.length;
      const work = selected && (snapshot.processes || []).filter(process => process.agentSessionId === selected.agentSessionId);
      setHTML('[data-awv-agent-work]', selected ? '<p class="awv-caption">' + [agentTitle(selected), selected.status && label(selected.status), taskTitle(selected.taskId)].filter(Boolean).map(esc).join(' · ') + '</p>' + (work || []).map(processButton).join('') + labels.diagnostics([['Agent ID', selected.id], ['Agent session ID', selected.agentSessionId], ['Task ID', selected.taskId], ['Attempt ID', selected.attemptId], ['History error', history.agentSessionId === selected.agentSessionId ? history.error : '']], 'agent-' + selected.agentSessionId) : '');
      if (!selected) { history = { key: '', messages: [], status: '', error: '' }; setText('[data-awv-agent-status]', agents.length ? 'Choose an agent to read its conversation.' : 'No agent sessions reported yet.'); setHTML('[data-awv-agent-messages]', ''); return; }
      const conversationId = snapshot.sessionId;
      const key = JSON.stringify([scopeKey(snapshot), selected.agentSessionId, snapshot.hydration, snapshot.revision]);
      if (history.key !== key) {
        const sameAgent = history.agentSessionId === selected.agentSessionId && history.conversationId === conversationId;
        const request = { key, conversationId, agentSessionId: selected.agentSessionId, messages: sameAgent ? history.messages : [], status: 'loading', error: '' };
        history = request;
        const settle = (status, messages, error = '') => {
          if (destroyed || history !== request) return;
          history = { ...request, status, messages, error };
          if (state.view === 'timeline') updateAgentHistory();
        };
        store.getAgentHistory(conversationId, selected.agentSessionId).then(messages => settle('ready', messages), error => settle('error', [], String(error?.message || error)));
      }
      const messages = history.messages.flatMap((message, index) => {
        if (!['user', 'assistant', 'toolResult'].includes(message?.role)) return [];
        const body = typeof message.content === 'string' ? message.content : (Array.isArray(message.content) ? message.content : []).filter(block => block?.type === 'text').map(block => block.text || '').join('\n');
        if (!body) return [];
        if (message.role === 'toolResult') {
          const presentation = window.AthenaPiActivity.toolPresentation(message.toolName, {}, message.isError ? 'failed' : 'succeeded', tasks());
          return ['<li><strong>' + esc(presentation.label || 'Tool result') + '</strong>' + labels.diagnostics([['Tool', message.toolName], ['Tool call ID', message.toolCallId], ['Output', body]], 'agent-tool-' + selected.agentSessionId + '-' + (message.toolCallId || message.id || index)) + '</li>'];
        }
        return ['<li><strong>' + (message.role === 'assistant' ? 'Agent' : 'Request') + '</strong><div class="awv-record-text">' + esc(body) + '</div></li>'];
      });
      setText('[data-awv-agent-status]', labels.text(history.error, '', [selected.id, selected.agentSessionId, selected.taskId, selected.attemptId, snapshot.sessionId]) || (history.error ? 'Could not load this agent conversation.' : history.status === 'loading' ? 'Loading agent history…' : messages.length ? messages.length + (messages.length === 1 ? ' message' : ' messages') + ' recorded' : 'No messages recorded for this agent.'));
      setHTML('[data-awv-agent-messages]', messages.join(''));
    }

    function update(force = false) {
      if (destroyed) return;
      researchBoard?.update();
      updateHeading();
      if (state.view === 'workflow') updateWorkflow();
      if (state.view === 'artifacts') updateArtifacts(force);
      if (state.view === 'timeline') updateTimeline();
      refreshIcons();
    }

    function open(view, selection = null) {
      if (destroyed || !VIEWS[view]) return false;
      const chosen = typeof selection === 'string' ? { id: selection } : selection || {};
      const id = chosen.id;
      if (chosen.taskId || tasks().some(item => item.id === id)) state.taskId = chosen.taskId || id;
      const toolId = chosen.toolId || (snapshot.tools || []).find(item => item.id === id)?.id;
      if (toolId) { state.taskId = (snapshot.tools || []).find(item => item.id === toolId)?.taskId || state.taskId; }
      if (view === 'workflow' && (chosen.taskId || tasks().some(item => item.id === id) || toolId)) { const selected = task(state.taskId); if (selected?.runId) { state.workflowRunId = selected.runId; state.workflowFollowLatest = false; } }
      const artifactId = chosen.artifactId || (artifactList().some(item => item.id === id) ? id : null);
      if (artifactId) { state.artifactId = artifactId; state.artifactVersion = chosen.version ?? chosen.artifactVersion ?? null; state.documentVersion = chosen.documentVersion ?? (!live() ? chosen.version : null) ?? null; state.referenceOpen = false; }
      if (chosen.page) state.notePage = clamp(Number(chosen.page) || 1, 1, PAGES.length);
      if (chosen.citation !== undefined) state.citation = chosen.citation;
      else if (view === 'artifacts') state.citation = null;
      if (view === 'timeline' && (chosen.taskId || tasks().some(item => item.id === id))) state.timelineTask = chosen.taskId || id;
      if (view === 'timeline' && chosen.agentSessionId) state.agentSessionId = chosen.agentSessionId;
      state.view = view;
      shell();
      if (chosen.eventId) qa('[data-awv-event-id]').find(el => el.dataset.awvEventId === chosen.eventId)?.scrollIntoView?.({ block: 'nearest' });
      return true;
    }

    function navigate(view, selection) {
      if (options.onNavigate) options.onNavigate(view, selection);
      else open(view, selection);
    }

    async function copy(text) {
      try {
        if (!navigator.clipboard?.writeText) throw new Error('unavailable');
        await navigator.clipboard.writeText(text);
        if (!destroyed) notify('Copied to clipboard.');
      } catch (_) {
        // A selectable local text field keeps the action useful in sandboxed previews.
        if (destroyed) return;
        const dialog = document.createElement('dialog');
        dialog.className = 'awv-copy-dialog';
        dialog.innerHTML = '<h3>Copy text</h3><p>Clipboard access is unavailable here. Select this text and use your copy shortcut.</p><textarea readonly aria-label="Text to copy"></textarea><form method="dialog"><button type="submit" class="awv-button">Done</button></form>';
        dialog.querySelector('textarea').value = text;
        host.append(dialog);
        dialog.addEventListener('close', () => dialog.remove(), { once: true });
        if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', '');
        const area = dialog.querySelector('textarea'); area.focus(); area.select?.();
      }
    }

    function downloadText(text, filename, type = 'text/plain;charset=utf-8') {
      const url = URL.createObjectURL(new Blob([text], { type }));
      urls.add(url);
      const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
      const timer = setTimeout(() => { URL.revokeObjectURL(url); urls.delete(url); timers.delete(timer); }, 1500);
      timers.add(timer);
    }

    function downloadArtifact() {
      const item = artifact();
      if (!item) return;
      const canonical = canonicalDocument(item);
      if (canonical) downloadText(canonical.version.text, canonical.doc.documentId + '-v' + canonical.version.version + '.md', 'text/markdown;charset=utf-8');
      else if (live()) {
        if (typeof item.text !== 'string') { notify('The runtime has not supplied downloadable text for this artifact.'); return; }
        downloadText(item.text, item.filename || item.id + '-v' + (artifactVersion(item) || 'unknown') + '.txt');
      } else if (item.kind === 'document') { notify('This document revision has not been provided.'); return; }
      else if (item.kind === 'plot') downloadText(responseCSV(), item.filename, 'text/csv;charset=utf-8');
      else if (item.kind === 'evidence') downloadText(evidenceCSV(), item.filename, 'text/csv;charset=utf-8');
      else if (item.kind === 'code') downloadText(state.codeTab === 'diff' ? DIFF.map(row => row[1]).join('\n') + '\n' : CODE, state.codeTab === 'diff' ? 'sample-tolerance-changes.diff' : item.filename);
      else downloadText(referenceText(), item.filename, 'text/markdown;charset=utf-8');
      notify('Download prepared.');
    }

    async function exportCurrentPDF() {
      const canonical = canonicalDocument(); if (!canonical) return;
      const identity = { documentId: canonical.doc.documentId, version: canonical.version.version, projectId: canonical.doc.projectId };
      try {
        const result = await options.records.exportPDF(identity.documentId, identity.version);
        if (destroyed) return;
        options.onExport?.(result);
        const selected = canonicalDocument();
        if (!selected || selected.doc.projectId !== identity.projectId || selected.doc.documentId !== identity.documentId || selected.version.version !== identity.version) return;
        setHTML('[data-awv-export-result]', exportReceiptHTML(result));
        refreshIcons();
      } catch (error) { if (!destroyed) notify(String(error?.message || error)); }
    }

    function openCitation(button) {
      navigate('artifacts', { artifactId: button.dataset.awvTarget, citation: button.dataset.awvCitation });
    }

    host.addEventListener('click', event => {
      const button = event.target.closest('button');
      if (!button || !host.contains(button) || button.disabled) return;
      if (button.dataset.awvTask) {
        state.taskId = button.dataset.awvTask;
        const selected = task(state.taskId); if (selected?.runId) { state.workflowRunId = selected.runId; state.workflowFollowLatest = false; }
        updateHeading(); updateWorkflow(); refreshIcons();
        return;
      }
      if (button.dataset.awvOpenTool) {
        const tool = (snapshot.tools || []).find(item => item.id === button.dataset.awvOpenTool);
        navigate('execution', { toolId: button.dataset.awvOpenTool, taskId: tool?.taskId });
        return;
      }
      if (button.dataset.awvOpenProcess) { navigate('execution', { processId: button.dataset.awvOpenProcess, taskId: (snapshot.processes || []).find(process => process.id === button.dataset.awvOpenProcess)?.taskId }); return; }
      if (button.dataset.awvOpenAgent) { navigate('timeline', { agentSessionId: button.dataset.awvOpenAgent, taskId: state.taskId }); return; }
      if (button.dataset.awvCancelTask) { if (can('cancelTask')) store.cancelTask(button.dataset.awvCancelTask); return; }
      if (button.dataset.awvOpenArtifact) { navigate('artifacts', { artifactId: button.dataset.awvOpenArtifact, ...(button.dataset.awvVersion ? { version: button.dataset.awvVersion } : {}) }); return; }
      if (button.dataset.awvApproval) { options.onApproval?.(button.dataset.awvApproval); return; }
      if (button.dataset.awvRetry) { if (can('retryTask')) store.retryTask(button.dataset.awvRetry); return; }
      if (button.dataset.awvCitation) { openCitation(button); return; }
      if (button.dataset.awvEvent) {
        const item = (snapshot.events || []).find(e => e.id === button.dataset.awvEvent);
        if (!item) return;
        const approval = eventGroup(item) === 'approval' && (snapshot.approvals || []).find(a => a.taskId === item.taskId && a.status === 'pending');
        if (approval && can('decideApproval') && options.onApproval) options.onApproval(approval.id);
        else if (eventGroup(item) === 'artifact' && item.artifactId) navigate('artifacts', { artifactId: item.artifactId, version: item.artifactVersion ?? item.version });
        else if (eventGroup(item) === 'tool' && item.toolId) navigate('execution', { toolId: item.toolId, taskId: item.taskId });
        else navigate('workflow', { taskId: item.taskId });
        return;
      }
      const action = button.dataset.awvAction;
      if (action === 'cancel-run' && can('cancelRun')) store.cancel();
      if (action === 'workflow-mode') { state.workflowMode = button.dataset.awvValue; updateWorkflow(); }
      if (['graph-zoom-in', 'graph-zoom-out', 'graph-fit', 'graph-actual'].includes(action)) {
        state.graphFit = action === 'graph-fit';
        if (!state.graphFit) state.graphZoom = action === 'graph-actual' ? 100 : clamp(state.graphZoom + (action === 'graph-zoom-in' ? 10 : -10), 35, 150);
        updateGraphViewport();
        if (state.graphFit) { const viewport = q('[data-awg-viewport]'); if (viewport) { viewport.scrollLeft = 0; viewport.scrollTop = 0; } }
      }
      if (action === 'code-tab') { state.codeTab = button.dataset.awvValue; updateCode(); }
      if (action === 'copy-artifact') { const value = currentArtifactText(); if (value != null) copy(value); }
      if (action === 'download-artifact') downloadArtifact();
      if (action === 'open-manuscript') { const selected = canonicalDocument(), item = artifact(); const documentId = selected?.doc.documentId || item?.documentId, version = selected?.version.version || item?.documentVersion; if (documentId && version != null) navigate('manuscript', { documentId, version: String(version) }); }
      if (action === 'export-record-pdf') void exportCurrentPDF();
      if (action === 'original-reference' && !live()) { state.referenceOpen = !state.referenceOpen; updateArtifacts(true); }
      if (action === 'copy-original-reference' && !live()) copy(noteText());
      if (action === 'download-original-pdf' && !live()) { const link = document.createElement('a'); link.href = PDF_URL; link.download = 'sample-research-note.pdf'; link.click(); notify('Original sample PDF download prepared.'); }
      if (action === 'toggle-data') {
        state.table = !state.table;
        button.setAttribute('aria-expanded', String(state.table));
        button.innerHTML = icon('table-2') + (state.table ? 'Hide data table' : 'Show data table');
        q('[data-awv-data-table]').hidden = !state.table;
      }
      if (action === 'note-mode') { state.noteMode = button.dataset.awvValue; updateDocument(); }
      if (action === 'previous-page' || action === 'next-page') { state.notePage = clamp(state.notePage + (action === 'next-page' ? 1 : -1), 1, PAGES.length); updateDocument(); }
      if (action === 'zoom-out' || action === 'zoom-in' || action === 'reset-zoom') { state.noteZoom = action === 'reset-zoom' ? 100 : clamp(state.noteZoom + (action === 'zoom-in' ? 10 : -10), 80, 150); updateDocument(); }
      if (action === 'latest-event') q('[data-awv-events] li:last-child')?.scrollIntoView?.({ block: 'end', behavior: 'auto' });
      if (action === 'download-events') downloadText(JSON.stringify(filteredEvents(), null, 2), live() ? 'runtime-timeline-events.json' : 'sample-timeline-events.json', 'application/json;charset=utf-8');
      if (action === 'reset-filters') { state.timelineTask = 'all'; state.timelineType = 'all'; updateTimeline(); }
      refreshIcons();
    }, { signal: abort.signal });

    host.addEventListener('change', event => {
      const el = event.target;
      if (el.matches('[data-awv-run-select]') && workflowRuns().some(run => run.id === el.value)) { state.workflowRunId = el.value; state.workflowFollowLatest = false; state.taskId = workflowTasks()[0]?.id || null; state.graphZoom = 100; state.graphFit = false; update(); }
      if (el.matches('[data-awv-artifact-select]')) { const selected = artifactList().find(item => (live() ? artifactKey(item) : item.id) === el.value); if (selected) { state.artifactId = selected.id; state.artifactVersion = live() ? artifactVersion(selected) : null; state.documentVersion = null; state.referenceOpen = false; state.citation = null; updateArtifacts(true); } }
      if (el.matches('[data-awv-series]')) { state[el.dataset.awvSeries] = el.checked; redrawPlot(); }
      if (el.matches('[data-awv-page-select]')) { state.notePage = clamp(Number(el.value) || 1, 1, PAGES.length); updateDocument(); }
      if (!live() && el.matches('[data-awv-document-version]')) { state.documentVersion = el.value; updateArtifacts(true); }
      if (el.matches('[data-awv-highlights]')) { state.highlights = el.checked; updateDocument(); }
      if (el.matches('[data-awv-timeline-task]')) { state.timelineTask = el.value; updateTimeline(); }
      if (el.matches('[data-awv-agent-select]')) { state.agentSessionId = el.value; updateAgentHistory(); }
      if (el.matches('[data-awv-timeline-type]')) { state.timelineType = el.value; updateTimeline(); }
      refreshIcons();
    }, { signal: abort.signal });

    host.addEventListener('keydown', event => {
      const group = event.target.closest('.awv-segmented');
      if (!group || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const buttons = Array.from(group.querySelectorAll('button'));
      const index = buttons.indexOf(event.target);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus(); buttons[next]?.click();
    }, { signal: abort.signal });

    shell();
    if (typeof window.ResizeObserver === 'function') {
      resizeObserver = new window.ResizeObserver(() => { if (!destroyed) { redrawPlot(); updateGraphViewport(); } });
      resizeObserver.observe(host);
    }
    unsubscribe = store.subscribe(next => { snapshot = next || store.getState(); const scope = scopeKey(snapshot); if (scope !== lastScope) { qa('[data-aw-diagnostics]').forEach(detail => { detail.open = false; }); diagnosticState.clear(); lastScope = scope; state.workflowRunId = null; state.workflowFollowLatest = true; state.graphZoom = 100; state.graphFit = false; const first = artifactList()[0]; state.artifactId = first?.id || null; state.artifactVersion = live() && first ? artifactVersion(first) : null; state.documentVersion = null; state.referenceOpen = false; state.taskId = tasks()[0]?.id || null; state.agentSessionId = ''; history = { key: '', messages: [], status: '', error: '' }; state.timelineTask = 'all'; state.timelineType = 'all'; } update(); });
    recordUnsubscribe = options.records?.subscribe(() => { if (!destroyed && state.view === 'artifacts') { updateArtifacts(true); refreshIcons(); } });
    return {
      open,
      setResearchService(service) { researchService = service || null; researchBoard?.setService(researchService); },
      focus: () => {
        if (destroyed || !host.isConnected || host.hidden || host.closest('[hidden],[inert],[aria-hidden="true"]')) return;
        q('[data-awv-heading]')?.focus({ preventScroll: true });
      },
      getState: () => ({ ...state }),
      destroy() {
        if (destroyed) return;
        destroyed = true;
        unsubscribe?.(); recordUnsubscribe?.(); researchBoard?.destroy(); abort.abort();
        resizeObserver?.disconnect();
        timers.forEach(clearTimeout); urls.forEach(url => URL.revokeObjectURL(url));
        timers.clear(); urls.clear(); diagnosticState.clear();
        host.replaceChildren(); host.classList.remove('awv-host'); delete host.dataset.workspaceView;
      }
    };
  }

  window.AthenaWorkspaceViews = Object.freeze({ mount });
})();
