/* Athena side surfaces. The host application owns the panel and its resizing.
   These are local UI views; this module never starts a process or agent. */
(() => {
  'use strict';

  const SURFACES = [
    { id: 'browser', label: 'Browser', icon: 'globe', key: 'B' },
    { id: 'workflow', label: 'Workflow', icon: 'workflow', key: 'W' },
    { id: 'artifacts', label: 'Artifacts', icon: 'panels-top-left', key: 'O' },
    { id: 'timeline', label: 'Agent timeline', icon: 'history', key: 'A' },
    { id: 'knowledge', label: 'Knowledge', icon: 'library', key: 'K' },
    { id: 'files', label: 'Files', icon: 'files', key: 'F' },
    { id: 'diff', label: 'Diff', icon: 'file-diff', key: 'D' },
    { id: 'pull-request', label: 'Pull request', icon: 'git-pull-request', key: 'P', disabled: true },
    { id: 'linked-pr', label: 'Linked pull requests', icon: 'link', key: 'L', disabled: true },
    { id: 'device', label: 'Device', icon: 'smartphone', key: 'M' },
    { id: 'research', label: 'Research panel', icon: 'flask-conical', key: 'R' }
  ];

  // These views do not advertise a host capability. Keep their scope visible
  // before the user opens them; a working conversation is not a device bridge.
  const LIMITED_SURFACES = {
    browser: 'Web links only',
    files: 'Workspace browsing unavailable',
    diff: 'Repository diff unavailable',
    device: 'Device connection unavailable'
  };


  const esc = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const icon = name => '<i data-lucide="' + name + '" aria-hidden="true"></i>';
  const fileIcon = name => /\.csv$/i.test(name) ? 'file-spreadsheet' : /\.(cir|py|js|rs|json)$/i.test(name) ? 'file-code-2' : 'file-text';

  function mount(host, options = {}) {
    if (!host) throw new Error('AthenaSurfaces.mount requires a host element.');
    const controller = new AbortController();
    const signal = controller.signal;
    const files = options.files || {};
    const filenames = Object.keys(files);
    const state = { surface: 'home', selectedFile: filenames[0] || null, fileQuery: '', address: '' };
    const objectUrls = new Set();
    const timers = new Set();
    let destroyed = false, runtimeMode = false;
    const q = selector => host.querySelector(selector);
    const qa = selector => Array.from(host.querySelectorAll(selector));
    const notify = text => options.toast?.(text);
    const refreshIcons = () => {
      if (options.icons) options.icons();
      else window.lucide?.createIcons({ attrs: { 'aria-hidden': 'true' } });
    };
    const contentOf = name => typeof files[name] === 'string' ? files[name] : String(files[name]?.content ?? '');

    host.classList.add('acs-host');

    function header(id) {
      const item = SURFACES.find(entry => entry.id === id);
      return '<div class="acs-toolbar"><button type="button" class="acs-icon-button cursor-interaction" data-acs-action="home" aria-label="Back to surface list" title="Surface list">' + icon('arrow-left') + '</button><span class="acs-toolbar-title">' + icon(item.icon) + '<strong>' + item.label + '</strong></span><span class="acs-view-caption">' + (runtimeMode ? (id === 'browser' ? 'Web links only' : 'Unavailable') : id === 'files' ? 'Project files' : 'Preview') + '</span></div>';
    }

    function homeHTML() {
      return '<div class="acs-home acs-scroll"><div class="acs-chooser" tabindex="-1" aria-label="Choose a surface"><h2>Open a surface</h2><p class="acs-home-description">Keep your tools beside the conversation.</p><div class="acs-surface-list">' + SURFACES.map(item => '<button type="button" class="acs-surface-option cursor-interaction' + (item.id === 'research' ? ' acs-research-option' : '') + '" data-acs-surface="' + item.id + '"' + (item.disabled ? ' disabled aria-label="' + item.label + ' · Repository connection required" title="Repository connection required"' : '') + '>' + icon(item.icon) + '<span class="acs-surface-copy">' + item.label + (runtimeMode && LIMITED_SURFACES[item.id] ? '<small data-acs-capability="' + item.id + '">' + LIMITED_SURFACES[item.id] + '</small>' : '') + '</span><kbd>' + item.key + '</kbd></button>').join('') + '</div><p class="acs-shortcut-note">Use the shown keys while focused on this list.</p></div>' + (!runtimeMode && filenames.length ? '<section class="acs-recent"><div class="acs-section-label"><h3>Files in this conversation</h3><span>' + filenames.length + '</span></div>' + filenames.slice(0, 3).map(name => '<button class="acs-recent-file cursor-interaction" type="button" data-acs-file="' + esc(name) + '">' + icon(fileIcon(name)) + '<span>' + esc(name) + '</span>' + icon('arrow-up-right') + '</button>').join('') + '</section>' : '') + '</div>';
    }

    function fileListHTML() {
      const needle = state.fileQuery.trim().toLocaleLowerCase();
      const found = filenames.filter(name => name.toLocaleLowerCase().includes(needle));
      return found.length ? found.map(name => '<button type="button" class="acs-file-item cursor-interaction' + (state.selectedFile === name ? ' acs-selected' : '') + '" data-acs-file="' + esc(name) + '" aria-pressed="' + String(state.selectedFile === name) + '">' + icon(fileIcon(name)) + '<span>' + esc(name) + '</span><small>' + esc(name.split('.').pop().toUpperCase()) + '</small></button>').join('') : '<p class="acs-empty-search">No matching files.</p>';
    }

    function filesHTML() {
      if (runtimeMode) return header('files') + '<div class="acs-scroll"><div class="acs-empty-state">' + icon('files') + '<h3>File browser not connected</h3><p>Workspace folders cannot be browsed here yet. Knowledge holds imported sources; Artifacts shows output files saved by the host.</p><div class="acs-empty-actions"><button type="button" class="acs-text-button" data-acs-workspace="knowledge">Open Knowledge' + icon('arrow-up-right') + '</button><button type="button" class="acs-text-button" data-acs-workspace="artifacts">Open Artifacts' + icon('arrow-up-right') + '</button></div></div></div>';
      const name = state.selectedFile;
      const lineCount = name ? contentOf(name).split('\n').length : 0;
      return header('files') + '<div class="acs-scroll acs-files-pane"><label class="acs-search">' + icon('search') + '<input type="search" data-acs-search placeholder="Search filenames" aria-label="Search filenames" autocomplete="off" value="' + esc(state.fileQuery) + '"></label><div class="acs-file-group-label">' + icon('folder-open') + '<span>Biosignal circuits</span></div><div class="acs-file-list">' + fileListHTML() + '</div>' + (name ? '<section class="acs-file-preview" aria-label="Selected file"><div class="acs-preview-heading"><div><h3 tabindex="-1" data-acs-file-heading>' + esc(name) + '</h3><span>Read only · ' + lineCount + (lineCount === 1 ? ' line' : ' lines') + '</span></div><div class="acs-preview-actions"><button type="button" class="acs-icon-button cursor-interaction" data-acs-action="copy-file" aria-label="Copy file contents" title="Copy contents">' + icon('copy') + '</button><button type="button" class="acs-icon-button cursor-interaction" data-acs-action="download-file" aria-label="Download file" title="Download file">' + icon('download') + '</button></div></div><pre class="acs-code" tabindex="0" aria-label="' + esc(name) + ' contents">' + esc(contentOf(name)) + '</pre></section>' : '<div class="acs-empty-state">' + icon('files') + '<h3>No files yet</h3><p>Project files added to this conversation will appear here.</p></div>') + '</div>';
    }

    function browserHTML() {
      const preview = runtimeMode
        ? '<div class="acs-empty-state">' + icon('globe') + '<h3>Browser automation is not connected</h3><p>Athena cannot read pages, control tabs, or perform browser actions from this panel. Opening a link does not give it to an agent.</p></div>'
        : '<div class="acs-document-preview"><div class="acs-document-kicker">Project document · sample</div><h2>RC low-pass filter</h2><p>Review the circuit conditions and notes beside your conversation.</p><div class="acs-formula">f<sub>c</sub> = 1 / (2πRC)</div><dl class="acs-properties"><div><dt>Resistance R</dt><dd>1 kΩ</dd></div><div><dt>Capacitance C</dt><dd>100 nF</dd></div><div><dt>Theoretical cutoff</dt><dd>Approx. 1.5915 kHz</dd></div></dl><h3>What to check</h3><ul><li>Error between theory and calculated results</li><li>Response changes within component tolerances</li><li>Additional conditions for physical measurements</li></ul><button type="button" class="acs-text-button cursor-interaction" data-acs-research="results">View linked research results' + icon('arrow-up-right') + '</button></div>';
      return header('browser') + '<div class="acs-scroll"><form class="acs-address-bar" data-acs-address-form><label class="acs-address-label">' + icon('globe') + '<input type="text" inputmode="url" autocomplete="url" data-acs-address aria-label="Web address to open or copy" aria-describedby="acs-browser-scope" placeholder="Enter a web address" value="' + esc(state.address) + '"></label><button type="submit" class="acs-icon-button cursor-interaction" aria-label="Open this address in a new tab in web mode" title="Open in a new tab in web mode">' + icon('arrow-up-right') + '</button><button type="button" class="acs-icon-button cursor-interaction" data-acs-action="copy-address" aria-label="Copy web address" title="Copy web address"' + (!state.address.trim() ? ' disabled' : '') + '>' + icon('copy') + '</button></form><p class="acs-browser-note" id="acs-browser-scope">Web mode can open links in a new tab. Athena desktop does not support opening links from this panel yet; copy the address into your browser. An embedded browser is not connected.</p>' + preview + '</div>';
    }

    function diffHTML() {
      if (runtimeMode) return header('diff') + '<div class="acs-scroll"><div class="acs-empty-state">' + icon('file-diff') + '<h3>No workspace diff service</h3><p>Repository comparisons and file edits are not connected. Output files saved by the host are available in Artifacts.</p><button type="button" class="acs-text-button" data-acs-workspace="artifacts">Open Artifacts' + icon('arrow-up-right') + '</button></div></div>';
      const rows = [
        ['1', '1', 'context', '* RC low-pass · example'],
        ['2', '2', 'context', 'V1 in 0 AC 1'],
        ['3', '', 'removed', 'R1 in out 1k'],
        ['4', '', 'removed', 'C1 out 0 100n'],
        ['', '3', 'added', 'R1 in out 1.01k'],
        ['', '4', 'added', 'C1 out 0 105n'],
        ['5', '5', 'context', '.ac dec 100 10 100k'],
        ['6', '6', 'context', '.end']
      ];
      return header('diff') + '<div class="acs-scroll acs-diff-pane"><div class="acs-inline-note">' + icon('file-diff') + '<span>Sample comparison · no files modified.</span></div><div class="acs-diff-heading"><strong>baseline.cir</strong><span><b class="acs-added-count">+2</b><b class="acs-removed-count">−2</b></span></div><div class="acs-diff-description"><span>Baseline circuit</span>' + icon('arrow-right') + '<span>Tolerance scenario</span></div><div class="acs-diff-scroll" tabindex="0" aria-label="Sample code changes"><table class="acs-diff-code"><caption class="ac-sr-only">Sample resistor and capacitor changes. Two lines removed and two added.</caption><tbody>' + rows.map(row => '<tr class="acs-diff-' + row[2] + '"><td aria-hidden="true">' + row[0] + '</td><td aria-hidden="true">' + row[1] + '</td><td class="acs-diff-sign"><span class="ac-sr-only">' + (row[2] === 'removed' ? 'Removed ' : row[2] === 'added' ? 'Added ' : '') + '</span>' + (row[2] === 'removed' ? '−' : row[2] === 'added' ? '+' : ' ') + '</td><td><code>' + esc(row[3]) + '</code></td></tr>').join('') + '</tbody></table></div><div class="acs-diff-summary"><h3>Reason for change</h3><p>This example compares the cutoff frequency with resistance increased by 1% and capacitance by 5%.</p><button type="button" class="acs-text-button cursor-interaction" data-acs-research="workflow">View linked research task' + icon('arrow-up-right') + '</button></div></div>';
    }

    function deviceHTML() {
      return header('device') + '<div class="acs-scroll acs-device-pane"><div class="acs-empty-state acs-device-empty"><span class="acs-device-icon">' + icon('monitor') + '</span><h2>No devices connected</h2><p>Device connection is not implemented. Athena cannot pair a computer or lab server, control its desktop, or access its folders from this panel.</p><span class="acs-status-label"><span class="acs-neutral-dot"></span>Connection unavailable</span></div><div class="acs-device-details"><h3>Available in this workspace</h3><p>The connected Athena host reports its research tasks and saved results in Workflow.</p><button type="button" class="acs-text-button" data-acs-workspace="workflow">Open Workflow' + icon('arrow-up-right') + '</button></div></div>';
    }

    function render(moveFocus = false) {
      if (destroyed) return;
      host.dataset.surface = state.surface;
      const views = { home: homeHTML, files: filesHTML, browser: browserHTML, diff: diffHTML, device: deviceHTML };
      host.innerHTML = (views[state.surface] || homeHTML)();
      refreshIcons();
      if (moveFocus) {
        const target = state.surface === 'home' ? q('[data-acs-surface]:not([disabled])') : q('[data-acs-action="home"]');
        target?.focus({ preventScroll: true });
      }
    }

    function open(id = 'home', moveFocus = true) {
      if (destroyed) return;
      // Old tool/terminal entry points now reveal activity in the conversation.
      if (id === 'execution' || id === 'terminal') { options.onWorkspace?.('execution'); return; }
      if (['workflow','artifacts','timeline','knowledge'].includes(id)) { options.onWorkspace?.(id); return; }
      if (id === 'agents') { options.onWorkspace?.('timeline'); return; }
      if (id === 'research') { options.onResearch?.('results'); return; }
      if (id !== 'home' && !SURFACES.some(item => item.id === id && !item.disabled)) return;
      state.surface = id;
      render(moveFocus);
    }

    function openFile(name) {
      if (destroyed || !Object.prototype.hasOwnProperty.call(files, name)) return false;
      state.selectedFile = name;
      state.fileQuery = '';
      state.surface = 'files';
      render();
      q('[data-acs-file-heading]')?.focus({ preventScroll: true });
      return true;
    }

    async function copy(text, message = 'Contents copied.') {
      try {
        if (!navigator.clipboard?.writeText) throw new Error('clipboard-unavailable');
        await navigator.clipboard.writeText(text);
        if (!destroyed) notify(message);
      } catch (_) {
        if (!destroyed) notify('Clipboard unavailable. Select the text and copy it manually.');
      }
    }

    function downloadSelectedFile() {
      const name = state.selectedFile;
      if (!name || !Object.prototype.hasOwnProperty.call(files, name)) return;
      const url = URL.createObjectURL(new Blob([contentOf(name)], { type: /\.csv$/i.test(name) ? 'text/csv;charset=utf-8' : 'text/plain;charset=utf-8' }));
      objectUrls.add(url);
      const link = document.createElement('a');
      link.href = url;
      link.download = name.split(/[\\/]/).pop() || 'athena-file.txt';
      link.click();
      const timer = setTimeout(() => { URL.revokeObjectURL(url); objectUrls.delete(url); timers.delete(timer); }, 1000);
      timers.add(timer);
    }

    host.addEventListener('click', event => {
      const button = event.target.closest('button');
      if (!button || !host.contains(button) || button.disabled) return;
      if (button.dataset.acsSurface) { open(button.dataset.acsSurface); return; }
      if (button.dataset.acsResearch) { options.onResearch?.(button.dataset.acsResearch); return; }
      if (button.dataset.acsWorkspace) { options.onWorkspace?.(button.dataset.acsWorkspace); return; }
      if (button.dataset.acsFile) {
        if (!Object.prototype.hasOwnProperty.call(files, button.dataset.acsFile)) return;
        if (state.surface !== 'files') state.fileQuery = '';
        state.selectedFile = button.dataset.acsFile;
        state.surface = 'files';
        render();
        q('[data-acs-file-heading]')?.focus({ preventScroll: true });
        return;
      }
      const action = button.dataset.acsAction;
      if (action === 'home') open('home');
      if (action === 'copy-file' && state.selectedFile) copy(contentOf(state.selectedFile));
      if (action === 'download-file') downloadSelectedFile();
      if (action === 'copy-address') {
        try { copy(normalizeAddress(), 'Web address copied.'); }
        catch (_) { notify('Enter a web address beginning with http or https.'); }
      }
    }, { signal });

    host.addEventListener('input', event => {
      if (event.target.matches('[data-acs-search]')) {
        state.fileQuery = event.target.value;
        q('.acs-file-list').innerHTML = fileListHTML();
        refreshIcons();
      }
      if (event.target.matches('[data-acs-address]')) {
        state.address = event.target.value;
        q('[data-acs-action="copy-address"]').disabled = !state.address.trim();
      }
    }, { signal });

    function normalizeAddress() {
      const address = state.address.trim();
      const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(address) && !/^[^/?#\s]+:\d+(?:[/?#]|$)/.test(address);
      const url = new URL(hasScheme ? address : 'https://' + address);
      if (!['https:', 'http:'].includes(url.protocol) || !url.hostname) throw new Error('unsupported-address');
      state.address = url.href;
      q('[data-acs-address]').value = state.address;
      return url.href;
    }

    host.addEventListener('submit', event => {
      if (!event.target.matches('[data-acs-address-form]')) return;
      event.preventDefault();
      const address = state.address.trim();
      if (!address) { q('[data-acs-address]')?.focus(); return; }
      try {
        window.open(normalizeAddress(), '_blank', 'noopener,noreferrer');
      } catch (_) { notify('Enter a web address beginning with http or https.'); }
    }, { signal });

    host.addEventListener('keydown', event => {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (state.surface === 'home') options.onClose?.();
        else open('home');
        return;
      }
      if (state.surface !== 'home' || !event.target.closest('.acs-chooser') || event.target.matches('input,textarea,[contenteditable="true"]')) return;
      const items = qa('[data-acs-surface]:not([disabled])');
      const index = items.indexOf(document.activeElement);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
        return;
      }
      const surface = SURFACES.find(item => !item.disabled && item.key.toLowerCase() === event.key.toLowerCase());
      if (surface) { event.preventDefault(); event.stopPropagation(); open(surface.id); }
    }, { signal });

    render();
    return {
      open,
      openFile,
      setRuntimeMode(value) { const next = Boolean(value); if (next === runtimeMode) return; runtimeMode = next; render(); },
      getState: () => ({ ...state }),
      destroy() {
        if (destroyed) return;
        destroyed = true;
        controller.abort();
        timers.forEach(timer => clearTimeout(timer));
        objectUrls.forEach(url => URL.revokeObjectURL(url));
        timers.clear();
        objectUrls.clear();
        host.replaceChildren();
        host.classList.remove('acs-host');
        delete host.dataset.surface;
      }
    };
  }

  window.AthenaSurfaces = { mount };
})();
