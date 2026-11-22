/* Athena panel resizing. Local presentation state only; no backend dependency. */
(() => {
  'use strict';

  const instances = new WeakMap();
  const STORAGE_KEY = 'athena.ui.panel-widths.v1';
  const DEFAULTS = Object.freeze({ left: 240, right: 440 });
  const LIMITS = Object.freeze({ leftMin: 200, leftMax: 360, rightMin: 300, rightMax: 720, leftChatMin: 320, chatMin: 380 });
  const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));

  function mount(root, options = {}) {
    if (!root) throw new Error('AthenaResize.mount requires an application root.');
    instances.get(root)?.destroy();
    const panels = { left: root.querySelector('#ac-sidebar'), right: root.querySelector('#ac-research-panel') };
    if (!panels.left || !panels.right) throw new Error('AthenaResize requires both panel elements.');

    const controller = new AbortController();
    const { signal } = controller;
    const listen = (target, type, callback, settings = {}) => target.addEventListener(type, callback, { ...settings, signal });
    const originalVars = {
      left: root.style.getPropertyValue('--ac-left-width'),
      right: root.style.getPropertyValue('--ac-right-width')
    };
    const originalPanelLayout = root.getAttribute('data-panel-layout');
    let preferred = { ...DEFAULTS };
    try {
      const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null');
      for (const side of ['left', 'right']) {
        if (saved && typeof saved[side] === 'number' && Number.isFinite(saved[side])) {
          preferred[side] = clamp(Math.round(saved[side]), LIMITS[side + 'Min'], LIMITS[side + 'Max']);
        }
      }
    } catch (_) {
      // File URLs, embedded previews, and private browsing may disallow storage.
    }

    let actual = { ...preferred };
    let bounds = { left: [LIMITS.leftMin, LIMITS.leftMax], right: [LIMITS.rightMin, LIMITS.rightMax] };
    let modes = { left: 'docked', right: 'split' };
    let drag = null;
    let destroyed = false;
    let frame = 0;
    let lastSignature = '';
    let lastRootWidth = 0;
    const handles = {};

    for (const side of ['left', 'right']) {
      const handle = document.createElement('div');
      handle.id = 'ac-' + side + '-resizer';
      handle.className = 'ac-resize-handle ac-resize-' + side;
      handle.dataset.resizeSide = side;
      handle.tabIndex = 0;
      handle.setAttribute('role', 'separator');
      handle.setAttribute('aria-orientation', 'vertical');
      handle.setAttribute('aria-label', side === 'left' ? 'Resize projects sidebar' : 'Resize side view');
      handle.setAttribute('aria-controls', panels[side].id);
      handle.title = 'Drag or use arrow keys to resize. Double-click to reset.';
      panels[side].appendChild(handle);
      handles[side] = handle;
    }

    function snapshot() {
      return {
        left: actual.left,
        right: actual.right,
        preferred: { ...preferred },
        bounds: { left: [...bounds.left], right: [...bounds.right] },
        modes: { ...modes },
        resizing: drag?.side || null
      };
    }

    function persist() {
      try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferred)); } catch (_) { /* Optional persistence. */ }
    }

    function setVariable(side, value) {
      const name = '--ac-' + side + '-width';
      const next = value + 'px';
      if (root.style.getPropertyValue(name) !== next) root.style.setProperty(name, next);
    }

    function refresh() {
      if (destroyed) return snapshot();
      const width = Math.floor(root.clientWidth || root.getBoundingClientRect().width || lastRootWidth);
      if (!width) return snapshot();
      lastRootWidth = width;
      const leftOpen = root.dataset.leftOpen !== 'false';
      const leftDocked = width > 600 && leftOpen;
      const panelOpen = root.dataset.panelOpen === 'true';
      modes.left = width > 600 ? 'docked' : 'drawer';

      // The project list remains open until the user closes it. On compact
      // screens it becomes a drawer; changing viewport size never closes it.
      const leftSpace = width <= 600 ? Math.max(0, width - 32)
        : width - LIMITS.leftChatMin;
      const leftMinimum = Math.min(LIMITS.leftMin, leftSpace);
      let leftMaximum = Math.max(leftMinimum, Math.min(LIMITS.leftMax, leftSpace));
      bounds.left = [leftMinimum, leftMaximum];
      actual.left = clamp(preferred.left, ...bounds.left);

      const reservedLeft = leftDocked ? actual.left : 0;
      const availableStage = Math.max(0, width - reservedLeft);
      modes.right = availableStage >= 700 ? 'split' : 'overlay';
      if (root.dataset.panelLayout !== modes.right) root.dataset.panelLayout = modes.right;
      if (leftDocked && panelOpen && modes.right === 'split') {
        // The >=700px split threshold already leaves this space around the
        // current width. Also expose a compatible maximum to keyboard users.
        leftMaximum = Math.max(leftMinimum, Math.min(leftMaximum,
          width - LIMITS.leftChatMin - LIMITS.rightMin));
        bounds.left = [leftMinimum, leftMaximum];
      }
      const rightMaximum = Math.max(LIMITS.rightMin,
        Math.min(LIMITS.rightMax, availableStage - LIMITS.chatMin));
      const overlayWidth = Math.min(DEFAULTS.right, Math.max(0, availableStage - 16));
      bounds.right = modes.right === 'overlay' ? [Math.min(LIMITS.rightMin, overlayWidth), overlayWidth]
        : [LIMITS.rightMin, rightMaximum];
      actual.right = modes.right === 'overlay' ? overlayWidth : clamp(preferred.right, ...bounds.right);

      handles.left.hidden = !leftDocked;
      handles.right.hidden = !panelOpen || modes.right !== 'split';
      for (const side of ['left', 'right']) {
        setVariable(side, actual[side]);
        const handle = handles[side];
        handle.setAttribute('aria-valuemin', String(bounds[side][0]));
        handle.setAttribute('aria-valuemax', String(bounds[side][1]));
        handle.setAttribute('aria-valuenow', String(actual[side]));
        handle.setAttribute('aria-valuetext', Math.round(actual[side]) + ' pixels');
        handle.setAttribute('aria-disabled', String(handle.hidden));
        handle.tabIndex = handle.hidden ? -1 : 0;
      }

      if (drag && handles[drag.side].hidden) finishDrag(false);
      const signature = [width, actual.left, actual.right, leftOpen, panelOpen, modes.left, modes.right].join(':');
      if (signature !== lastSignature) {
        lastSignature = signature;
        options.onResize?.(snapshot());
      }
      return snapshot();
    }

    function scheduleRefresh() {
      if (destroyed || frame) return;
      frame = window.requestAnimationFrame(() => { frame = 0; refresh(); });
    }

    function setWidth(side, value, save = false) {
      preferred[side] = Math.round(clamp(value, ...bounds[side]));
      refresh();
      if (save) persist();
    }

    function finishDrag(commit = true) {
      if (!drag) return;
      const previous = drag;
      drag = null;
      delete root.dataset.resizing;
      if (!commit) preferred[previous.side] = previous.startPreferred;
      try {
        if (previous.handle.hasPointerCapture?.(previous.pointerId)) previous.handle.releasePointerCapture(previous.pointerId);
      } catch (_) { /* Capture can be released by browser cancellation. */ }
      refresh();
      if (commit) persist();
    }

    for (const side of ['left', 'right']) {
      const handle = handles[side];
      listen(handle, 'pointerdown', event => {
        if (event.button !== 0 || event.isPrimary === false || handle.hidden || destroyed) return;
        refresh();
        if (drag) finishDrag(true);
        event.preventDefault();
        event.stopPropagation();
        handle.focus({ preventScroll: true });
        drag = {
          side, handle, pointerId: event.pointerId, startX: event.clientX,
          startWidth: actual[side], startPreferred: preferred[side]
        };
        root.dataset.resizing = side;
        try { handle.setPointerCapture(event.pointerId); } catch (_) { /* Document listeners are the fallback. */ }
      });
      listen(handle, 'lostpointercapture', event => {
        if (drag?.pointerId === event.pointerId) finishDrag(true);
      });
      listen(handle, 'dblclick', event => {
        event.preventDefault();
        if (drag) finishDrag(true);
        preferred[side] = DEFAULTS[side];
        refresh();
        persist();
      });
      listen(handle, 'keydown', event => {
        if (event.isComposing || event.altKey || event.metaKey || event.ctrlKey || handle.hidden) return;
        if (event.key === 'Escape' && drag) {
          event.preventDefault();
          event.stopPropagation();
          finishDrag(false);
          return;
        }
        let value;
        const step = event.shiftKey ? 40 : 10;
        if (event.key === 'Home') value = bounds[side][0];
        else if (event.key === 'End') value = bounds[side][1];
        else if (event.key === 'ArrowLeft') value = actual[side] + (side === 'left' ? -step : step);
        else if (event.key === 'ArrowRight') value = actual[side] + (side === 'left' ? step : -step);
        else return;
        event.preventDefault();
        event.stopPropagation();
        setWidth(side, value, true);
      });
    }

    listen(document, 'pointermove', event => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      event.preventDefault();
      const delta = (event.clientX - drag.startX) * (drag.side === 'left' ? 1 : -1);
      setWidth(drag.side, drag.startWidth + delta);
    }, { passive: false });
    listen(document, 'pointerup', event => { if (drag?.pointerId === event.pointerId) finishDrag(true); });
    listen(document, 'pointercancel', event => { if (drag?.pointerId === event.pointerId) finishDrag(false); });
    listen(window, 'blur', () => finishDrag(true));
    listen(window, 'resize', scheduleRefresh);

    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(scheduleRefresh) : null;
    observer?.observe(root);
    const mutationObserver = typeof MutationObserver !== 'undefined' ? new MutationObserver(scheduleRefresh) : null;
    mutationObserver?.observe(root, { attributes: true, attributeFilter: ['data-left-open', 'data-panel-open'] });

    const api = {
      refresh,
      getState: snapshot,
      reset() {
        if (destroyed) return snapshot();
        finishDrag(false);
        preferred = { ...DEFAULTS };
        persist();
        return refresh();
      },
      destroy() {
        if (destroyed) return;
        finishDrag(true);
        destroyed = true;
        controller.abort();
        observer?.disconnect();
        mutationObserver?.disconnect();
        if (frame) window.cancelAnimationFrame(frame);
        for (const side of ['left', 'right']) {
          handles[side].remove();
          const name = '--ac-' + side + '-width';
          if (originalVars[side]) root.style.setProperty(name, originalVars[side]);
          else root.style.removeProperty(name);
        }
        delete root.dataset.resizing;
        if (originalPanelLayout === null) root.removeAttribute('data-panel-layout');
        else root.setAttribute('data-panel-layout', originalPanelLayout);
        if (instances.get(root) === api) instances.delete(root);
      }
    };
    instances.set(root, api);
    refresh();
    return api;
  }

  window.AthenaResize = Object.freeze({ mount });
})();
