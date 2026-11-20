/* Athena Agent Steps — DOM adaptation of Kokonut UI AI Loading State v2.0.0.
 * Source: kokonut-labs/kokonutui/components/kokonutui/ai-loading.tsx
 * Commit: 655ec61161aff87721e4c60c3cc4dc3329f3e80e (2026-11-16).
 * Authored durations/easing are retained; state is supplied by the caller.
 * No autonomous demo, network request, tool execution, or invented progress.
 *
 * MIT License
 * Copyright (c) 2025 kokonutUI
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
(() => {
  'use strict';
  const MOUNTS = new WeakMap();
  const STATES = new Set(['pending', 'running', 'done', 'error', 'stopped']);
  const OUTCOMES = new Set(['idle', 'active', 'complete', 'error', 'stopped']);
  let sequence = 0;
  const node = (tag, className, parent) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    parent?.appendChild(element);
    return element;
  };
  const duration = seconds => seconds < 60 ? seconds + 's' : Math.floor(seconds / 60) + 'm ' + String(seconds % 60).padStart(2, '0') + 's';
  const stepDuration = ms => ms < 10000 ? (ms / 1000).toFixed(1) + 's' : Math.round(ms / 1000) + 's';
  const text = value => String(value ?? '').slice(0, 2000);
  const iconName = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,50}$/.test(value) ? value : 'circle';

  function mount(slot, options = {}) {
    if (!slot || slot.nodeType !== 1) throw new TypeError('AthenaAgentSteps.mount needs an element slot.');
    MOUNTS.get(slot)?.destroy();
    const root = node('div', 'as-steps', slot);
    root.setAttribute('data-athena-agent-steps', '');
    root.dataset.initial = 'true';
    const header = node('button', 'as-header cursor-interaction', root);
    header.type = 'button';
    const headerIcon = node('span', 'as-header-icon ar-phase-glyph', header);
    headerIcon.setAttribute('aria-hidden', 'true');
    const title = node('output', 'as-title ar-phase-label', header);
    title.setAttribute('role', 'status'); title.setAttribute('aria-live', 'polite'); title.setAttribute('aria-atomic', 'true');
    const elapsed = node('span', 'as-elapsed', header); elapsed.setAttribute('aria-hidden', 'true');
    const count = node('span', 'as-count', header);
    const chevron = node('span', 'as-chevron', header); chevron.setAttribute('aria-hidden', 'true');
    const chevronIcon = node('i', '', chevron); chevronIcon.setAttribute('data-lucide', 'chevron-down');
    const detail = node('span', 'as-header-detail ar-phase-detail', root);
    const badge = node('span', 'as-preview-label ar-preview-label', root);
    const panel = node('div', 'as-list-panel', root);
    panel.id = 'athena-agent-steps-' + (++sequence);
    const list = node('ol', 'as-list', panel);
    header.setAttribute('aria-controls', panel.id);
    const appRoot = slot.closest('#athena-codex');
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const reduced = () => media.matches || appRoot?.dataset.reducedMotion === 'true';
    const rows = new Map(), pending = new Set();
    let steps = [], meta = {}, isOpen = true, wasDone = false, hasRendered = false, destroyed = false;
    let elapsedTimer = 0, closeTimer = 0, startedAt = null, seconds = 0, active = false;
    let headerGlyph = '', iconsDirty = true;
    const refreshIcons = () => {
      if (!iconsDirty) return;
      iconsDirty = false;
      if (typeof options.icons === 'function') options.icons();
      else window.lucide?.createIcons?.({ attrs: { 'aria-hidden': 'true' } });
      for (const path of root.querySelectorAll('.as-check-draw path,.as-check-draw polyline')) path.setAttribute('pathLength', '1');
    };
    const later = (ms, callback) => {
      const id = setTimeout(() => { pending.delete(id); if (!destroyed) callback(); }, ms);
      pending.add(id); return id;
    };
    function clearTimer(id) { clearTimeout(id); pending.delete(id); }
    function doneState() { return meta.outcome === 'complete' || (!meta.outcome && steps.length > 0 && steps.every(step => step.status === 'done')); }
    function updateHeader() {
      const failed = steps.find(step => step.status === 'error');
      const running = steps.find(step => step.status === 'running');
      const stopped = meta.outcome === 'stopped' || (!active && steps.some(step => step.status === 'stopped'));
      const done = doneState();
      let value = meta.title || (meta.outcome === 'error' || (failed && !meta.outcome) ? 'Stopped at: ' + (failed?.label || 'response') : stopped ? 'Stopped' : done ? seconds > 0 ? 'Worked for ' + duration(seconds) : 'Done' : running?.label || 'Getting ready');
      if (title.textContent !== value) title.textContent = value;
      elapsed.textContent = duration(seconds); elapsed.hidden = !active;
      count.textContent = done ? '· ' + steps.length + (steps.length === 1 ? ' step' : ' steps') : ''; count.hidden = !done;
      detail.textContent = meta.detail || ''; detail.hidden = !meta.detail;
      badge.textContent = meta.previewLabel || ''; badge.hidden = !meta.previewLabel;
      const glyph = iconName(meta.icon || (done ? 'check' : stopped ? 'square' : failed ? 'circle-alert' : 'sparkles'));
      if (glyph !== headerGlyph) {
        headerGlyph = glyph; headerIcon.replaceChildren();
        const icon = node('i', '', headerIcon); icon.setAttribute('data-lucide', glyph); iconsDirty = true;
      }
      headerIcon.dataset.iconProvider = meta.iconProvider === 'pi' ? 'pi' : 'fallback';
      headerIcon.dataset.active = String(active); headerIcon.dataset.piActive = String(active);
      root.dataset.active = String(active); root.dataset.outcome = done ? 'complete' : meta.outcome || (failed ? 'error' : active ? 'active' : 'idle');
    }
    function setOpen(value, animate = true) {
      const open = Boolean(value);
      if (closeTimer) { clearTimer(closeTimer); closeTimer = 0; }
      isOpen = open;
      header.setAttribute('aria-expanded', String(open));
      root.dataset.open = String(open);
      panel.inert = !open;
      panel.setAttribute('aria-hidden', String(!open));
      root.dataset.initial = String(!animate || reduced());
      if (open) {
        panel.hidden = false;
        // Resolve the previous grid row before transitioning from a folded list.
        void panel.offsetHeight;
        panel.dataset.open = 'true';
      } else {
        panel.dataset.open = 'false';
        if (!animate || reduced()) panel.hidden = true;
        else closeTimer = later(250, () => { closeTimer = 0; if (!isOpen) panel.hidden = true; });
      }
    }
    function makeIcon(status, animate) {
      const state = node('span', 'as-icon-state' + (animate ? ' is-entering' : ''));
      state.dataset.status = status; state.setAttribute('aria-hidden', 'true');
      if (status === 'pending') node('span', 'as-pending-dot', state);
      else if (status === 'running') node('span', 'as-spinner', state);
      else {
        const icon = node('i', status === 'done' && animate ? 'as-check-draw' : '', state);
        icon.setAttribute('data-lucide', status === 'done' ? 'check' : status === 'error' ? 'x' : 'square');
        iconsDirty = true;
      }
      return state;
    }
    function rowFor(step) {
      let row = rows.get(step.id);
      if (row) return row;
      const element = node('li', 'as-step', list); element.dataset.agentStep = step.id;
      const rail = node('span', 'as-rail', element); rail.setAttribute('aria-hidden', 'true'); node('span', 'as-rail-fill', rail);
      const icon = node('span', 'as-step-icon', element);
      const content = node('div', 'as-step-content', element);
      const line = node('div', 'as-step-heading', content);
      const label = node('p', 'as-step-label', line);
      const time = node('span', 'as-step-time', line); time.hidden = true;
      const log = node('div', 'as-log-viewport', content); log.setAttribute('aria-hidden', 'true'); log.hidden = true;
      const logLines = node('div', 'as-log-lines', log);
      row = { element, rail, icon, label, time, log, logLines, state: null, labelText: '', lineValues: [], start: null, duration: null };
      rows.set(step.id, row); return row;
    }
    function renderRow(step, index) {
      const row = rowFor(step), changed = row.state !== step.status, initial = row.state === null, now = Date.now();
      row.element.dataset.status = step.status; row.rail.hidden = index === steps.length - 1;
      if (changed) {
        if (step.status === 'pending') { row.start = null; row.duration = null; }
        else if (step.status === 'running') { row.start = now; row.duration = null; }
        else if (row.duration == null && row.start != null) row.duration = Math.max(0, now - row.start);
        const previous = row.icon.lastElementChild;
        const animate = hasRendered && !initial && !reduced();
        if (previous) {
          if (animate) { previous.classList.remove('is-entering'); previous.classList.add('is-leaving'); later(180, () => previous.remove()); }
          else row.icon.replaceChildren();
        }
        row.icon.appendChild(makeIcon(step.status, animate));
      }
      if (changed || row.labelText !== step.label) {
        row.label.replaceChildren();
        if (step.status === 'running') {
          node('span', 'as-sr-only', row.label).textContent = step.label;
          const wave = node('span', 'as-wave-label', row.label); wave.setAttribute('aria-hidden', 'true');
          Array.from(step.label).forEach((character, i) => {
            const letter = node('span', 'as-wave-letter', wave); letter.textContent = character; letter.style.animationDelay = (i * .05) + 's';
          });
        } else row.label.textContent = step.label;
        row.labelText = step.label;
      }
      row.time.hidden = row.duration == null;
      if (row.duration != null) row.time.textContent = stepDuration(row.duration);
      const lines = step.status === 'running' ? step.detail : [];
      const prefix = row.lineValues.every((line, i) => lines[i] === line);
      if (!prefix) { row.logLines.replaceChildren(); row.lineValues = []; }
      for (let i = row.lineValues.length; i < lines.length; i++) {
        const line = node('div', 'as-log-line', row.logLines);
        node('span', 'as-log-number', line).textContent = String(i + 1);
        node('span', 'as-log-text', line).textContent = lines[i];
      }
      row.lineValues = [...lines];
      row.log.hidden = !lines.length;
      row.log.style.height = (24 * Math.min(lines.length, 3)) + 'px';
      row.log.dataset.masked = String(lines.length >= 3);
      row.logLines.style.transform = 'translateY(' + (-24 * Math.max(0, lines.length - 3)) + 'px)';
      row.state = step.status;
    }
    function update(input = [], metadata = {}) {
      if (destroyed) return false;
      const seen = new Set();
      steps = (Array.isArray(input) ? input : []).filter(step => step && typeof step.id === 'string' && !seen.has(step.id) && seen.add(step.id)).slice(0, 40).map(step => ({ id: step.id, label: text(step.label), status: STATES.has(step.status) ? step.status : 'pending', detail: Array.isArray(step.detail) ? step.detail.slice(0, 100).map(text) : [] }));
      meta = { ...metadata, outcome: OUTCOMES.has(metadata.outcome) ? metadata.outcome : undefined, title: text(metadata.title), detail: text(metadata.detail), previewLabel: text(metadata.previewLabel) };
      const done = doneState(), wasActive = active;
      active = !done && meta.outcome !== 'error' && meta.outcome !== 'stopped' && (typeof meta.active === 'boolean' ? meta.active : steps.some(step => step.status === 'running'));
      if (active && (!wasActive || startedAt == null)) {
        if (wasDone) { startedAt = null; seconds = 0; }
        startedAt ??= Date.now();
      }
      if (startedAt != null && (wasActive || active)) seconds = Math.floor(Math.max(0, Date.now() - startedAt) / 1000);
      const visibleIds = new Set(steps.map(step => step.id));
      for (const [id, row] of rows) if (!visibleIds.has(id)) { row.element.remove(); rows.delete(id); }
      steps.forEach((step, index) => {
        renderRow(step, index);
        const element = rows.get(step.id).element;
        if (list.children[index] !== element) list.insertBefore(element, list.children[index] || null);
      });
      if (options.collapseWhenDone !== false && (!hasRendered || done !== wasDone)) setOpen(!done, hasRendered);
      else if (!hasRendered) setOpen(true, false);
      wasDone = done;
      if (active && !elapsedTimer) elapsedTimer = setInterval(() => { if (!destroyed && active) { seconds = Math.floor(Math.max(0, Date.now() - startedAt) / 1000); updateHeader(); } }, 500);
      if (!active && elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = 0; }
      root.dataset.reducedMotion = String(reduced());
      updateHeader(); refreshIcons(); hasRendered = true;
      return true;
    }
    function reset() {
      if (destroyed) return;
      for (const timer of pending) clearTimeout(timer); pending.clear(); closeTimer = 0;
      clearInterval(elapsedTimer); elapsedTimer = 0;
      startedAt = null; seconds = 0; active = false; wasDone = false; hasRendered = false;
      rows.clear(); list.replaceChildren(); steps = []; meta = {};
      update([], { outcome: 'idle' });
    }
    function toggle() { setOpen(!isOpen, true); }
    function motionChanged() {
      root.dataset.reducedMotion = String(reduced());
      if (reduced()) {
        for (const old of root.querySelectorAll('.as-icon-state.is-leaving')) old.remove();
        setOpen(isOpen, false);
      }
    }
    header.addEventListener('click', toggle);
    if (media.addEventListener) media.addEventListener('change', motionChanged); else media.addListener(motionChanged);
    appRoot?.addEventListener('ac:settings-change', motionChanged);
    function destroy() {
      if (destroyed) return; destroyed = true;
      for (const timer of pending) clearTimeout(timer); pending.clear();
      clearInterval(elapsedTimer);
      header.removeEventListener('click', toggle);
      if (media.removeEventListener) media.removeEventListener('change', motionChanged); else media.removeListener(motionChanged);
      appRoot?.removeEventListener('ac:settings-change', motionChanged);
      root.remove(); rows.clear();
      if (MOUNTS.get(slot) === api) MOUNTS.delete(slot);
    }
    const api = Object.freeze({ update, reset, destroy, setOpen: value => setOpen(value, true), getState: () => ({ steps: steps.map(step => ({ ...step, detail: [...step.detail] })), open: isOpen, active, outcome: root.dataset.outcome, elapsedSeconds: seconds, reducedMotion: reduced() }) });
    MOUNTS.set(slot, api); update([], { outcome: 'idle' }); return api;
  }
  window.AthenaAgentSteps = Object.freeze({ mount });
})();
