/* AthenaReply — inline presentation of received response text.
 * start() is an explicitly local sample. begin()/append()/end() consume an
 * external stream without fabricating content, elapsed progress, or completion.
 * No network calls, animated container sizing, generated thinking text, or SVG.
 */
(() => {
  'use strict';
  const MOUNTS = new WeakMap();
  const PHASES = Object.freeze({
    idle: { label: 'Ready', icon: 'circle', active: false },
    waiting: { label: 'Waiting', icon: 'hourglass', active: true },
    thinking: { label: 'Thinking', icon: 'brain-circuit', active: true },
    replying: { label: 'Replying', icon: 'message-square-text', active: true },
    preparing: { label: 'Preparing tool call', icon: 'braces', active: true },
    working: { label: 'Working', icon: 'wrench', active: true },
    approval: { label: 'Waiting for approval', icon: 'shield-check', active: false },
    retrying: { label: 'Retrying', icon: 'rotate-cw', active: true },
    compacting: { label: 'Compacting context', icon: 'archive', active: true },
    complete: { label: 'Complete', icon: 'check', active: false },
    error: { label: 'Needs attention', icon: 'circle-alert', active: false },
    stopped: { label: 'Stopped', icon: 'square', active: false },
    paused: { label: 'Paused', icon: 'pause', active: false }
  });
  const ALIASES = Object.freeze({ reply: 'replying', running: 'working', tool: 'working', done: 'complete', succeeded: 'complete', failed: 'error', aborted: 'stopped', cancelled: 'stopped', 'waiting-input': 'approval' });
  const element = (tag, className, parent) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    parent?.appendChild(node);
    return node;
  };
  const canonical = value => Object.hasOwn(PHASES, value) ? value : Object.hasOwn(ALIASES, value) ? ALIASES[value] : 'waiting';

  function mount(slot) {
    if (!slot || slot.nodeType !== 1) throw new TypeError('AthenaReply.mount needs an element slot.');
    MOUNTS.get(slot)?.destroy();
    const root = element('div', '', slot);
    root.setAttribute('data-athena-reply', '');
    root.dataset.phase = 'idle';
    root.dataset.active = 'false';
    const statusRow = element('div', 'ar-status-row ap-phase', root);
    const stepper = window.AthenaAgentSteps?.mount?.(statusRow, { collapseWhenDone: true }) || null;
    if (stepper) statusRow.classList.add('ar-has-agent-steps');
    const glyph = stepper ? statusRow.querySelector('.ar-phase-glyph') : element('span', 'ar-phase-glyph', statusRow);
    glyph.setAttribute('aria-hidden', 'true');
    const output = stepper ? statusRow.querySelector('.as-title') : element('output', 'ar-loading', statusRow);
    output.setAttribute('role', 'status');
    output.setAttribute('aria-live', 'polite');
    output.setAttribute('aria-atomic', 'true');
    const phaseLabel = stepper ? output : element('span', 'ar-phase-label ap-live-label', output);
    const detailLabel = stepper ? statusRow.querySelector('.ar-phase-detail') : element('span', 'ar-phase-detail', statusRow);
    const elapsed = stepper ? statusRow.querySelector('.as-elapsed') : element('span', 'ar-loading-elapsed', statusRow);
    elapsed.setAttribute('aria-hidden', 'true');
    elapsed.hidden = true;
    const previewLabel = stepper ? statusRow.querySelector('.ar-preview-label') : element('span', 'ar-preview-label', statusRow);
    previewLabel.textContent = 'Sample reply';
    const activitySlot = element('div', 'ar-activity-slot', root);
    const bubble = element('div', 'ar-bubble', root);
    bubble.setAttribute('aria-busy', 'false');
    const body = element('p', 'ar-text', bubble);
    const caret = element('span', 'ar-caret', body);
    caret.setAttribute('aria-hidden', 'true');
    caret.hidden = true;
    const announcer = element('span', 'ar-sr-only', root);
    announcer.setAttribute('role', 'status');
    announcer.setAttribute('aria-live', 'polite');

    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const appRoot = slot.closest('#athena-codex');
    const prefersReduced = () => media.matches || appRoot?.dataset.reducedMotion === 'true';
    const timers = new Set();
    const incoming = new Set();
    let destroyed = false;
    let active = false;
    let generation = 0;
    let phase = 'idle';
    let phaseDetail = '';
    let mode = 'stream';
    let text = '';
    let sampleText = '';
    let onDone = null;
    let onPhase = null;
    let elapsedTimer = 0;
    let milestones = [];
    let currentMilestone = null;
    let previewText = '';

    function later(delay, callback) {
      const version = generation;
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!destroyed && version === generation) callback();
      }, delay);
      timers.add(timer);
      return timer;
    }
    function clearResources() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      clearInterval(elapsedTimer); elapsedTimer = 0;
      incoming.clear();
    }
    function cancelAnimations() {
      if (typeof root.getAnimations === 'function') {
        for (const animation of root.getAnimations({ subtree: true })) animation.cancel();
      }
    }
    function descriptor(name) {
      const value = window.AthenaPiActivity?.phase?.(name);
      return value || { id: name, ...PHASES[name] };
    }
    function updateSteps(definition) {
      if (!stepper) return;
      const primary = ['waiting', 'thinking', 'replying'].includes(phase);
      if (active && primary) {
        if (currentMilestone && currentMilestone !== phase) {
          const previous = milestones.find(step => step.id === currentMilestone);
          if (previous && previous.status !== 'error' && previous.status !== 'stopped') previous.status = 'done';
        }
        let current = milestones.find(step => step.id === phase);
        if (!current) {
          current = { id: phase, label: descriptor(phase).label, status: 'running', detail: [] };
          milestones.push(current);
        }
        current.status = 'running'; current.detail = phaseDetail ? [phaseDetail] : [];
        currentMilestone = phase;
      } else if (active) {
        // Tool execution remains in the separate inline tool rows. This compact
        // list records only observed response-generation milestones.
        if (phase === 'retrying') {
          for (const step of milestones) { step.status = 'pending'; step.detail = []; }
          currentMilestone = null;
        } else {
          const current = milestones.find(step => step.id === currentMilestone);
          if (current && current.status === 'running') { current.status = 'pending'; current.detail = []; }
        }
      } else if (phase === 'complete') {
        for (const step of milestones) { step.status = 'done'; step.detail = []; }
      } else if (phase === 'error' || phase === 'stopped') {
        const current = milestones.find(step => step.id === currentMilestone);
        if (current) { current.status = phase === 'error' ? 'error' : 'stopped'; current.detail = []; }
      }
      stepper.update(milestones, {
        outcome: active ? 'active' : phase === 'complete' ? 'complete' : phase === 'error' ? 'error' : phase === 'stopped' ? 'stopped' : 'idle',
        title: phase === 'complete' ? '' : definition.label,
        detail: primary ? '' : phaseDetail,
        icon: definition.icon,
        iconProvider: window.AthenaPiActivity ? 'pi' : 'fallback',
        active: active && definition.active,
        previewLabel: previewText
      });
    }
    function renderPhase(detail = '') {
      phaseDetail = String(detail || '');
      const definition = descriptor(phase);
      root.dataset.phase = phase;
      root.dataset.active = String(active);
      statusRow.dataset.piActive = String(active && definition.active);
      glyph.dataset.active = String(active && definition.active);
      if (stepper) {
        updateSteps(definition);
        caret.hidden = !active || phase !== 'replying';
        return definition;
      }
      if (window.AthenaPiActivity?.iconHTML) {
        glyph.dataset.iconProvider = 'pi';
        glyph.innerHTML = window.AthenaPiActivity.iconHTML(definition.icon, { active: active && definition.active, motion: definition.motion || 'pulse' });
      } else {
        glyph.dataset.iconProvider = 'fallback';
        // The fallback name comes only from the local closed icon registry.
        glyph.innerHTML = '<i data-lucide="' + PHASES[phase].icon + '" aria-hidden="true"></i>';
      }
      phaseLabel.textContent = definition.label;
      detailLabel.textContent = phaseDetail;
      detailLabel.hidden = !phaseDetail;
      caret.hidden = !active || phase !== 'replying';
      if (window.lucide) window.lucide.createIcons({ attrs: { 'aria-hidden': 'true' } });
      return definition;
    }
    function setPhase(value, detail = '') {
      if (destroyed || !active) return false;
      const next = canonical(String(value || 'waiting'));
      const changed = phase !== next;
      if (!changed && phaseDetail === String(detail || '')) return true;
      phase = next;
      const definition = renderPhase(detail);
      if (changed && typeof onPhase === 'function') onPhase(phase, definition);
      return true;
    }
    function settleText() {
      incoming.clear();
      body.replaceChildren(document.createTextNode(text), caret);
    }
    function begin(options = {}) {
      if (destroyed) throw new Error('This AthenaReply mount has been destroyed.');
      clearResources(); cancelAnimations(); generation += 1;
      active = true; text = ''; sampleText = '';
      mode = options.sample === true ? 'sample' : 'stream';
      onDone = typeof options.onDone === 'function' ? options.onDone : null;
      onPhase = typeof options.onPhase === 'function' ? options.onPhase : null;
      phase = 'idle';
      milestones = []; currentMilestone = null; stepper?.reset();
      root.classList.remove('is-settled', 'is-stopped', 'is-error', 'is-streaming');
      root.dataset.demo = String(mode === 'sample');
      root.dataset.reducedMotion = String(prefersReduced());
      previewText = typeof options.previewLabel === 'string' ? options.previewLabel : mode === 'sample' ? 'Sample reply' : '';
      previewLabel.textContent = previewText;
      previewLabel.hidden = !previewText;
      statusRow.hidden = false;
      announcer.textContent = '';
      body.replaceChildren(caret); caret.hidden = true;
      bubble.setAttribute('aria-busy', 'true');
      elapsed.hidden = !options.showElapsed;
      if (options.showElapsed && !stepper) {
        const startedAt = Date.now();
        elapsed.textContent = '0s';
        elapsedTimer = setInterval(() => { if (active) elapsed.textContent = Math.floor((Date.now() - startedAt) / 1000) + 's'; }, 1000);
      }
      setPhase(options.phase || 'waiting', options.detail || '');
      return api;
    }
    function append(delta) {
      if (destroyed || !active || delta == null) return false;
      const value = String(delta);
      if (!value) return true;
      text += value;
      setPhase('replying');
      root.classList.add('is-streaming');
      if (prefersReduced()) {
        body.insertBefore(document.createTextNode(value), caret);
        body.normalize?.();
      } else {
        const chunk = element('span', 'ar-stream-word is-incoming');
        chunk.textContent = value;
        body.insertBefore(chunk, caret); incoming.add(chunk);
        later(240, () => {
          if (!incoming.has(chunk)) return;
          incoming.delete(chunk);
          chunk.replaceWith(document.createTextNode(value));
          body.normalize?.();
        });
      }
      return true;
    }
    function replaceText(value) {
      if (destroyed || !active) return false;
      text = String(value ?? '');
      settleText();
      return true;
    }
    function end(options = {}) {
      if (destroyed || !active) return false;
      const status = canonical(options.status || 'complete');
      const terminal = ['complete', 'error', 'stopped'].includes(status) ? status : 'complete';
      if (options.text != null) text = String(options.text);
      active = false;
      generation += 1;
      clearResources(); cancelAnimations();
      root.classList.remove('is-streaming', 'is-stopped', 'is-settled', 'is-error');
      root.classList.add(terminal === 'stopped' ? 'is-stopped' : terminal === 'error' ? 'is-error' : 'is-settled');
      phase = terminal;
      settleText(); renderPhase(options.detail || '');
      caret.hidden = true;
      bubble.setAttribute('aria-busy', 'false');
      statusRow.hidden = !stepper && terminal !== 'error';
      announcer.textContent = (mode === 'sample' ? 'Sample response ' : 'Response ') + (terminal === 'complete' ? 'ready.' : terminal === 'error' ? 'needs attention.' : 'stopped.');
      const phaseCallback = onPhase, done = onDone;
      onPhase = onDone = null;
      if (typeof phaseCallback === 'function') phaseCallback(phase, descriptor(phase));
      if (typeof done === 'function') done({ status: terminal, text });
      return true;
    }
    function start(options = {}) {
      const value = String(options.text ?? '');
      begin({ ...options, phase: 'waiting', sample: true });
      sampleText = value;
      const version = generation;
      if (prefersReduced() || !value) {
        queueMicrotask(() => { if (!destroyed && active && generation === version) end({ text: value }); });
        return api;
      }
      later(160, () => setPhase('thinking'));
      const chunks = value.match(/\S+\s*|\s+/gu) || [];
      later(900, () => {
        setPhase('replying');
        let index = 0;
        const next = () => {
          if (!active) return;
          if (index < chunks.length) {
            append(chunks[index++]); later(55, next);
          } else later(240, () => end());
        };
        next();
      });
      return api;
    }
    function stop() {
      if (destroyed || !active) return false;
      // User interruption retains only received text and never calls onDone.
      onDone = null;
      return end({ status: 'stopped' });
    }
    function onReducedMotionChange() {
      const reduced = prefersReduced();
      root.dataset.reducedMotion = String(reduced);
      if (!reduced) return;
      cancelAnimations(); settleText();
      // The sample has known authored text. An external stream remains active
      // until its actual end event even when motion is reduced.
      if (active && mode === 'sample') end({ text: sampleText });
    }
    if (media.addEventListener) media.addEventListener('change', onReducedMotionChange);
    else media.addListener(onReducedMotionChange);
    appRoot?.addEventListener('ac:settings-change', onReducedMotionChange);
    function destroy() {
      if (destroyed) return;
      active = false; generation += 1;
      onDone = onPhase = null;
      destroyed = true; clearResources(); cancelAnimations();
      if (media.removeEventListener) media.removeEventListener('change', onReducedMotionChange);
      else media.removeListener(onReducedMotionChange);
      appRoot?.removeEventListener('ac:settings-change', onReducedMotionChange);
      stepper?.destroy();
      root.remove();
      if (MOUNTS.get(slot) === api) MOUNTS.delete(slot);
    }
    const api = Object.freeze({
      start, begin, append, replaceText, setPhase, end, stop, destroy,
      getActivityHost: () => activitySlot,
      getState: () => ({ active, phase, mode, text, reducedMotion: prefersReduced(), steps: stepper?.getState() || null })
    });
    MOUNTS.set(slot, api);
    statusRow.hidden = true;
    root.classList.add('is-stopped');
    root.dataset.reducedMotion = String(prefersReduced());
    return api;
  }
  window.AthenaReply = Object.freeze({ mount });
})();
