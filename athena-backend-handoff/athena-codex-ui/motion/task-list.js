/*
 * Athena plain-DOM adaptation of SmoothUI AI Task List (MIT).
 * Copyright (c) 2024 Eduardo Calvo. See LICENSE-SMOOTHUI.txt.
 * Source: https://smoothui.dev/r/ai-task-list.json
 * Spring samples are generated with Motion 14.14.0's spring generator:
 * duration 250 ms, bounce 0.1, keyframes [0, 1]. See LICENSE-MOTION.txt.
 * No runtime package, network request, simulator call, or automatic resubmission.
 */
(function (global) {
  'use strict';

  const SPRING_DEFAULT = Object.freeze({ type: 'spring', duration: 0.25, bounce: 0.1 });
  const SPRING_PROGRESS = [0,0.012995687,0.046984264,0.095601728,0.153796658,0.217609804,0.283984656,0.350605531,0.415759926,0.478222181,0.5371557,0.592031275,0.642559307,0.688633919,0.730287242,0.767652305,0.800933203,0.830381346,0.856276795,0.878913798,0.898589775,0.915597131,0.930217343,0.942716871,0.953344521,0.962329935,0.969882953,0.976193632,0.981432754,0.985752668,0.989288377,0.992158758,0.994467868,0.996306268,0.997752334,0.998873525,0.999727587,1.000363678,1.000823415,1.001141827,1.001348221,1.001466966,1.001518185,1.001518378,1.001480965,1.001416766,1.001334417,1.001240729,1.001141003,1.001039295,1];
  const CHECK_PATH = 'M 3.5 7.5 L 6 10 L 10.5 4.5';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const STATES = new Set(['pending', 'running', 'done', 'failed', 'needs-confirmation']);
  const STATUS_LABELS = Object.freeze({
    pending: 'Pending', running: 'Running', done: 'Done', failed: 'Failed',
    'needs-confirmation': 'Check needed'
  });
  const INITIAL_TASKS = Object.freeze([
    { id: 'plan', label: 'Confirm the plan', detail: 'Agree on the goal, tolerance, and run scope', status: 'done' },
    { id: 'baseline', label: 'Run the baseline circuit', detail: 'ngspice · This computer', status: 'done' },
    { id: 'verify', label: 'Review results', detail: '0.03% error against theory', status: 'done' },
    { id: 'sensitivity', label: 'RC sensitivity analysis', detail: '8 / 12 cases · Lab server', status: 'needs-confirmation' },
    { id: 'report', label: 'Prepare the draft', detail: 'Build a draft from reviewed results', status: 'pending' }
  ]);
  const instances = new WeakMap();

  function element(doc, tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function svgElement(doc, tag, attrs) {
    const node = doc.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, String(value));
    return node;
  }
  function translateY(transform) {
    const match = String(transform).match(/matrix(3d)?\(([^)]+)\)/);
    if (match) return Number(match[2].split(',')[match[1] ? 13 : 5]) || 0;
    const direct = String(transform).match(/translate(?:Y|3d)?\([^,]*,?\s*(-?[\d.]+)px/);
    return direct ? Number(direct[1]) || 0 : 0;
  }

  function mount(slot, options) {
    options = options || {};
    if (typeof slot === 'string') slot = global.document.querySelector(slot);
    if (!slot || slot.nodeType !== 1) throw new TypeError('AthenaTaskList.mount requires a container element.');
    const oldInstance = instances.get(slot);
    if (oldInstance) oldInstance.destroy();
    const doc = slot.ownerDocument;
    const win = doc.defaultView || global;
    const originalChildren = Array.from(slot.childNodes);
    const tasks = INITIAL_TASKS.map(task => Object.assign({}, task));
    const taskMap = new Map(tasks.map(task => [task.id, task]));
    const rows = new Map();
    const animations = new Map();
    const media = typeof win.matchMedia === 'function' ? win.matchMedia('(prefers-reduced-motion: reduce)') : null;
    const appRoot = slot.closest('#athena-codex');
    const prefersReduced = () => Boolean(media && media.matches) || appRoot?.dataset.reducedMotion === 'true';
    let reduced = prefersReduced();
    let destroyed = false;
    let selectedId = 'sensitivity';
    let reconcilePending = false;

    const root = element(doc, 'section', 'athena-task-list');
    root.setAttribute('aria-label', 'Research tasks — sample workflow');
    const header = element(doc, 'div', 'atl-header');
    const heading = element(doc, 'h3', 'atl-heading', 'Execution steps');
    const count = element(doc, 'p', 'atl-count');
    header.append(heading, count);
    const list = element(doc, 'ul', 'atl-rows');
    list.setAttribute('role', 'list');
    const controls = element(doc, 'div', 'atl-reconcile-wrap');
    const reconcile = element(doc, 'button', 'atl-reconcile cursor-interaction');
    reconcile.type = 'button';
    const refreshIcon = element(doc, 'i');
    refreshIcon.setAttribute('data-lucide', 'refresh-cw');
    refreshIcon.setAttribute('aria-hidden', 'true');
    reconcile.append(refreshIcon, element(doc, 'span', '', 'Check status'));
    controls.append(reconcile);
    const live = element(doc, 'span', 'atl-sr-only');
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    live.setAttribute('aria-atomic', 'true');
    root.append(header, list, controls, live);
    slot.replaceChildren(root);

    function cancelRowAnimation(id) {
      const animation = animations.get(id);
      if (animation) { animations.delete(id); animation.cancel(); }
    }
    function snapshot(task) { return Object.freeze(Object.assign({}, task)); }
    function setMarker(row, task, changed) {
      if (!changed) return;
      if (row.mark) row.mark.remove();
      row.mark = null;
      const done = task.status === 'done';
      const failed = task.status === 'failed';
      if (done || failed) {
        const mark = svgElement(doc, 'path', {
          d: done ? CHECK_PATH : 'M 5 5 L 9 9 M 9 5 L 5 9', fill: 'none', pathLength: 1,
          'stroke-dasharray': '1 1', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-width': 1.8,
          'class': 'atl-task-draw', 'data-mark': done ? 'check' : 'cross'
        });
        row.svg.append(mark); row.mark = mark;
      } else if (task.status === 'needs-confirmation') {
        const mark = svgElement(doc, 'path', { d: 'M7 3.7v3.9M7 10.2h.01', fill: 'none', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'class': 'atl-confirm-mark' });
        row.svg.append(mark); row.mark = mark;
      }
    }
    function setRunningUnderline(row, task) {
      const wanted = task.status === 'running' && !reduced;
      if (wanted && !row.underline) {
        row.underline = element(doc, 'span', 'atl-underline');
        row.underline.setAttribute('aria-hidden', 'true');
        row.button.append(row.underline);
      } else if (!wanted && row.underline) { row.underline.remove(); row.underline = null; }
    }
    function paintRow(task, animate, changed) {
      const row = rows.get(task.id);
      let currentOpacity = Number.parseFloat(row.li.style.opacity) || 1;
      let currentY = 0;
      if (animate && typeof win.getComputedStyle === 'function') {
        const computed = win.getComputedStyle(row.li);
        const opacity = Number.parseFloat(computed.opacity);
        if (Number.isFinite(opacity)) currentOpacity = opacity;
        currentY = translateY(computed.transform);
      }
      cancelRowAnimation(task.id);
      const targetOpacity = task.status === 'done' ? 0.65 : 1;
      const targetY = task.status === 'done' && !reduced ? 1 : 0;
      row.li.dataset.state = task.status;
      row.li.dataset.selected = String(selectedId === task.id);
      row.button.setAttribute('aria-pressed', String(selectedId === task.id));
      row.button.setAttribute('aria-label', task.label + ', ' + STATUS_LABELS[task.status] + ', ' + task.detail);
      row.note.textContent = STATUS_LABELS[task.status];
      row.li.style.opacity = String(targetOpacity);
      row.li.style.transform = 'translate3d(0, ' + targetY + 'px, 0)';
      setMarker(row, task, changed);
      setRunningUnderline(row, task);
      const moving = Math.abs(currentOpacity - targetOpacity) > 0.000001 || Math.abs(currentY - targetY) > 0.000001;
      if (animate && moving && !reduced && typeof row.li.animate === 'function') {
        const keyframes = SPRING_PROGRESS.map((value, i) => ({
          offset: i / (SPRING_PROGRESS.length - 1),
          opacity: currentOpacity + (targetOpacity - currentOpacity) * value,
          transform: 'translate3d(0, ' + (currentY + (targetY - currentY) * value) + 'px, 0)'
        }));
        const animation = row.li.animate(keyframes, { duration: SPRING_DEFAULT.duration * 1000, easing: 'linear', fill: 'both' });
        animations.set(task.id, animation);
        animation.onfinish = function () {
          if (animations.get(task.id) === animation) { animations.delete(task.id); animation.cancel(); }
        };
      }
    }
    function updateSummary() {
      const done = tasks.filter(task => task.status === 'done').length;
      count.textContent = done + '/' + tasks.length;
      count.setAttribute('aria-label', done + ' of ' + tasks.length + ' tasks complete');
      const attention = tasks.find(task => task.status === 'needs-confirmation');
      controls.hidden = !attention || typeof options.onReconcile !== 'function';
      reconcile.disabled = reconcilePending;
      reconcile.dataset.taskId = attention ? attention.id : '';
    }
    function selectTask(id) {
      if (destroyed) return;
      const task = taskMap.get(id);
      if (!task) return;
      selectedId = id;
      for (const item of tasks) {
        const row = rows.get(item.id);
        row.li.dataset.selected = String(item.id === selectedId);
        row.button.setAttribute('aria-pressed', String(item.id === selectedId));
      }
      if (typeof options.onSelect === 'function') options.onSelect(id, snapshot(task));
    }
    function onListClick(event) {
      const button = event.target.closest && event.target.closest('.atl-row-button');
      if (button && list.contains(button)) selectTask(button.dataset.taskId);
    }
    function onReconcileClick() {
      if (destroyed || reconcilePending || typeof options.onReconcile !== 'function') return;
      const task = taskMap.get(reconcile.dataset.taskId);
      if (!task || task.status !== 'needs-confirmation') return;
      const result = options.onReconcile(task.id, snapshot(task));
      if (result && typeof result.then === 'function') {
        reconcilePending = true;updateSummary();
        Promise.resolve(result).then(function () {
          if (!destroyed) { reconcilePending = false; updateSummary(); }
        }, function () {
          if (!destroyed) { reconcilePending = false; updateSummary(); live.textContent = 'Unable to check the run status. Please try again.'; }
        });
      }
    }
    function onReducedMotionChange() {
      if (destroyed) return;
      reduced = prefersReduced();
      for (const task of tasks) paintRow(task, false, false);
    }

    for (const task of tasks) {
      const li = element(doc, 'li', 'atl-row');li.dataset.taskId = task.id;
      const button = element(doc, 'button', 'atl-row-button cursor-interaction');button.type = 'button';button.dataset.taskId = task.id;
      const box = element(doc, 'span', 'atl-box');
      const svg = svgElement(doc, 'svg', { viewBox: '0 0 14 14', 'class': 'atl-box-svg', 'aria-hidden': 'true' });
      const rect = svgElement(doc, 'rect', { x: 1, y: 1, width: 12, height: 12, rx: 3.5, 'stroke-width': 1.4, 'class': 'atl-box-rect' });
      svg.append(rect);box.append(svg);
      const copy = element(doc, 'span', 'atl-task-copy');
      copy.append(element(doc, 'span', 'atl-task-label', task.label), element(doc, 'span', 'atl-task-meta', task.detail));
      const note = element(doc, 'span', 'atl-task-note');
      button.append(box, copy, note);li.append(button);list.append(li);
      rows.set(task.id, { li, button, svg, note, mark: null, underline: null });
    }
    list.addEventListener('click', onListClick);
    reconcile.addEventListener('click', onReconcileClick);
    if (media) {
      if (typeof media.addEventListener === 'function') media.addEventListener('change', onReducedMotionChange);
      else if (typeof media.addListener === 'function') media.addListener(onReducedMotionChange);
    }
    appRoot?.addEventListener('ac:settings-change', onReducedMotionChange);
    for (const task of tasks) paintRow(task, true, true);
    updateSummary();

    const api = Object.freeze({
      setTaskState: function (id, status) {
        if (destroyed) return false;
        if (!taskMap.has(id)) throw new RangeError('Unknown Athena task id: ' + id);
        if (!STATES.has(status)) throw new RangeError('Unknown Athena task status: ' + status);
        const task = taskMap.get(id);
        if (task.status === status) return false;
        task.status = status;
        paintRow(task, true, true);
        updateSummary();
        live.textContent = task.label + ': ' + STATUS_LABELS[status];
        return true;
      },
      destroy: function () {
        if (destroyed) return;
        destroyed = true;
        for (const id of Array.from(animations.keys())) cancelRowAnimation(id);
        list.removeEventListener('click', onListClick);
        reconcile.removeEventListener('click', onReconcileClick);
        if (media) {
          if (typeof media.removeEventListener === 'function') media.removeEventListener('change', onReducedMotionChange);
          else if (typeof media.removeListener === 'function') media.removeListener(onReducedMotionChange);
        }
        appRoot?.removeEventListener('ac:settings-change', onReducedMotionChange);
        if (root.parentNode === slot) slot.replaceChildren.apply(slot, originalChildren);
        instances.delete(slot);
      }
    });
    instances.set(slot, api);
    return api;
  }

  global.AthenaTaskList = Object.freeze({ mount: mount });
})(window);
