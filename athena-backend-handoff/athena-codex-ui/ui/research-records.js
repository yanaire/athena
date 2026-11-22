/* Versioned research records. Local revisions are session-only until a host confirms storage. */
(() => {
  'use strict';
  const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const text = value => typeof value === 'string' ? value : '';
  const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f\u241f]/u.test(value);
  const REVIEW_STATES = new Set(['unreviewed', 'in_review', 'approved', 'changes_requested']);
  const reviewFor = (review, version) => ({ ...copy(review || {}), status: REVIEW_STATES.has(review?.status) && String(review?.version) === String(version) ? review.status : 'unreviewed', version: String(version) });

  function create(options = {}) {
    let projectId = text(options.projectId) || 'project-rc', adapter = null, unsubscribe = null, epoch = 0, subscriptionToken = 0, serial = 0, destroyed = false;
    const documents = new Map(), listeners = new Set(), pending = new Map();
    const keyFor = (id, project = projectId) => project + '\u241f' + id;
    const available = method => Boolean(adapter && typeof adapter[method] === 'function' && (!Array.isArray(adapter.capabilities) || adapter.capabilities.includes(method)));
    const getDocument = (id, project = projectId) => copy(documents.get(keyFor(id, project)) || null);
    function getState() {
      return { projectId, connected: Boolean(adapter), persistence: adapter ? 'host-available' : 'session-only', capabilities: Object.fromEntries(['getDocument', 'saveDocument', 'exportPDF'].map(method => [method, available(method)])), documents: [...documents.values()].filter(doc => doc.projectId === projectId).map(copy), pending: [...pending.keys()].filter(key => key.startsWith(projectId + '\u241f')).map(key => key.split('\u241f').slice(1).join('\u241f')) };
    }
    function publish() { if (!destroyed) { const state = getState(); for (const fn of listeners) fn(state); } }
    function record(id) { const value = documents.get(keyFor(id)); if (!value) throw new Error('This document is not available in the current project.'); return value; }
    function normalizedVersion(input, fallback = {}) {
      const version = String(input.version || fallback.version || '1');
      if (!validId(version)) throw new Error('Document versions need a stable identifier.');
      const evidence = Array.isArray(input.evidence) ? input.evidence : fallback.evidence || [];
      if (evidence.some(item => !validId(item?.sourceId) || item.version == null)) throw new Error('Evidence must refer to a source ID and exact version.');
      return { version, title: text(input.title) || fallback.title || 'Research note', text: text(input.text), evidence: copy(evidence), review: reviewFor(input.review, version), createdAt: input.createdAt || new Date().toISOString(), baseVersion: input.baseVersion == null ? null : String(input.baseVersion), persistence: input.persistence === 'host' ? 'host' : 'session', originalLocation: copy(input.originalLocation || null), originalSample: input.originalSample === true };
    }
    function ensureDocument(input) {
      if (!validId(input?.documentId)) throw new Error('A document ID is required.');
      const project = input.projectId || projectId, key = keyFor(input.documentId, project);
      if (!validId(project)) throw new Error('A project ID is required.');
      if (documents.has(key)) return copy(documents.get(key));
      const version = normalizedVersion(input);
      const doc = { documentId: input.documentId, projectId: project, title: version.title, currentVersion: version.version, selectedVersion: version.version, versions: [version], draft: { text: version.text, baseVersion: version.version, dirty: false }, error: null, exports: [] };
      documents.set(key, doc); publish(); return copy(doc);
    }
    function updateDraft(id, value) {
      const doc = record(id);
      if (doc.selectedVersion !== doc.currentVersion) throw new Error('Return to the latest revision before editing. Earlier versions are read-only.');
      if (typeof value !== 'string') throw new TypeError('A document draft must be text.');
      const latest = doc.versions.find(version => version.version === doc.currentVersion);
      doc.draft = { text: value, baseVersion: doc.currentVersion, dirty: value !== latest.text };
      doc.error = null; publish(); return copy(doc.draft);
    }
    function commitDraft(id, input = {}) {
      const doc = record(id);
      if (doc.selectedVersion !== doc.currentVersion) throw new Error('Earlier document revisions are read-only.');
      const latest = doc.versions.find(version => version.version === doc.currentVersion);
      const evidence = input.evidence === undefined ? latest.evidence : input.evidence;
      const title = text(input.title) || doc.title;
      if (!doc.draft.dirty && title === latest.title && JSON.stringify(evidence) === JSON.stringify(latest.evidence)) return copy(latest);
      let version; do { version = 'local-' + (++serial); } while (doc.versions.some(item => item.version === version));
      const revision = normalizedVersion({ version, text: doc.draft.text, title, evidence, baseVersion: doc.currentVersion });
      doc.versions.push(revision); doc.currentVersion = version; doc.selectedVersion = version; doc.title = title;
      doc.draft = { text: revision.text, baseVersion: version, dirty: false }; doc.error = null;
      publish(); return copy(revision);
    }
    function selectVersion(id, value) {
      const doc = record(id), version = String(value);
      if (!doc.versions.some(item => item.version === version)) throw new Error('That document revision is not available.');
      doc.selectedVersion = version; publish(); return copy(doc.versions.find(item => item.version === version));
    }
    function acceptDocument(input, project = projectId, expected = null) {
      if (!validId(input?.documentId) || input.projectId !== project || input.version == null || typeof input.text !== 'string') throw new Error('The document service did not return an exact project, document and version.');
      if (expected && (input.documentId !== expected.documentId || input.text !== expected.text || JSON.stringify(input.evidence || []) !== JSON.stringify(expected.evidence || []))) throw new Error('The document service returned a different document payload. The local revision was preserved.');
      const key = keyFor(input.documentId, project), revision = normalizedVersion({ ...input, persistence: 'host' });
      let doc = documents.get(key);
      if (!doc) { ensureDocument({ ...input, persistence: 'host' }); doc = documents.get(key); }
      const existing = doc.versions.find(item => item.version === revision.version);
      if (existing && (existing.text !== revision.text || JSON.stringify(existing.evidence) !== JSON.stringify(revision.evidence))) throw new Error('A stored version cannot replace different text or evidence.');
      if (existing) { existing.persistence = 'host'; existing.originalLocation = revision.originalLocation; existing.review = revision.review; }
      else doc.versions.push(revision);
      if (!doc.draft.dirty && (!expected || doc.currentVersion === expected.version)) {
        doc.currentVersion = revision.version; doc.selectedVersion = revision.version; doc.title = revision.title;
        doc.draft = { text: revision.text, baseVersion: revision.version, dirty: false };
      }
      doc.error = null; publish(); return copy(revision);
    }
    async function operation(id, method, execute) {
      if (!available(method)) throw new Error(method === 'exportPDF' ? 'PDF export needs a connected document service. The original sample PDF is unchanged.' : 'Project document storage is not connected. This revision remains in this session.');
      const project = projectId, bound = epoch, target = adapter, key = keyFor(id, project) + '\u241f' + method;
      if (pending.has(key)) throw new Error('This document operation is already running.');
      const token = {}; pending.set(key, token); publish();
      try {
        const result = await execute(target, project);
        if (destroyed || bound !== epoch || target !== adapter || project !== projectId) throw new Error('The document connection or project changed. The local revision was preserved.');
        return result;
      } catch (error) {
        const doc = documents.get(keyFor(id, project)); if (doc && !destroyed) { doc.error = String(error?.message || error); publish(); }
        throw error;
      } finally { if (pending.get(key) === token) pending.delete(key); publish(); }
    }
    async function saveDocument(id) {
      if (!available('saveDocument')) return operation(id, 'saveDocument', () => {});
      const version = commitDraft(id), documentId = id;
      const storedVersion = record(id).versions.filter(item => item.persistence === 'host').at(-1)?.version || null;
      return operation(id, 'saveDocument', async (target, project) => {
        const result = await target.saveDocument({ projectId: project, documentId, ...copy(version), expectedCurrentVersion: storedVersion });
        // Validate the epoch before committing a delayed response into the store.
        return { result, expected: { documentId, ...version }, project };
      }).then(({ result, expected, project }) => acceptDocument(result, project, expected));
    }
    async function loadDocument(id, version) {
      const result = await operation(id, 'getDocument', (target, project) => target.getDocument({ projectId: project, documentId: id, ...(version == null ? {} : { version: String(version) }) }));
      if (result?.documentId !== id || version != null && String(result?.version) !== String(version)) throw new Error('The document service returned a different document or revision.');
      return acceptDocument(result);
    }
    async function exportPDF(id, value) {
      const doc = record(id), version = String(value ?? doc.selectedVersion), revision = doc.versions.find(item => item.version === version);
      if (!revision) throw new Error('Choose an existing revision to export.');
      if (doc.draft.dirty && version === doc.currentVersion) throw new Error('Keep the edited draft as a new revision before exporting it.');
      const result = await operation(id, 'exportPDF', (target, project) => target.exportPDF({ projectId: project, documentId: id, version, text: revision.text, evidence: copy(revision.evidence) }));
      if (!result || result.projectId !== doc.projectId || result.documentId !== id || String(result.version) !== version || result.mediaType !== 'application/pdf' || !validId(result.artifactId) || !result.location || typeof result.location.uri !== 'string') throw new Error('PDF export did not return a matching document version and artifact.');
      doc.exports.push(copy(result)); publish(); return copy(result);
    }
    function receive(event) {
      if (destroyed || !event || event.projectId !== projectId) return false;
      if (event.type === 'document.saved') { acceptDocument(event.document, projectId); return true; }
      if (event.type === 'document.reviewed') {
        const doc = documents.get(keyFor(event.documentId)), version = doc?.versions.find(item => item.version === String(event.version));
        if (!version || !REVIEW_STATES.has(event.review?.status) || String(event.review.version) !== version.version) return false;
        version.review = { ...copy(event.review), version: version.version }; publish(); return true;
      }
      return false;
    }
    function detach() { epoch++; subscriptionToken++; unsubscribe?.(); unsubscribe = null; adapter = null; pending.clear(); publish(); }
    function attach(next) {
      if (!next || typeof next !== 'object') throw new TypeError('A research record service adapter is required.');
      detach(); adapter = next; const bound = subscriptionToken;
      if (typeof next.subscribe === 'function') { const off = next.subscribe(event => { if (bound === subscriptionToken && adapter === next) { try { receive(event); } catch (error) { options.onError?.(error); } } }); unsubscribe = typeof off === 'function' ? off : null; }
      publish(); return () => { if (adapter === next && bound === subscriptionToken) detach(); };
    }
    const api = {
      getState, getDocument, ensureDocument, updateDraft, commitDraft, selectVersion, saveDocument, loadDocument, exportPDF, acceptDocument, receive, attach, detach,
      setProject(value) { if (!validId(value)) throw new Error('A project ID is required.'); if (projectId !== value) { epoch++; projectId = value; publish(); } },
      subscribe(fn) { listeners.add(fn); fn(getState()); return () => listeners.delete(fn); },
      destroy() { if (destroyed) return; detach(); destroyed = true; listeners.clear(); documents.clear(); }
    };
    for (const document of options.documents || []) ensureDocument(document);
    if (options.adapter) attach(options.adapter);
    return api;
  }

  function mountToolbar(slot, options = {}) {
    if (!slot || !options.store || !options.documentId) throw new TypeError('The revision toolbar needs a record store and document ID.');
    const store = options.store, id = options.documentId, controller = new AbortController();
    const root = document.createElement('section'); root.className = 'arr-toolbar'; root.setAttribute('aria-label', 'Document revision and storage');
    root.innerHTML = '<div class="arr-revision-row"><span class="arr-document-id"></span><label><span class="arr-sr-only">Document revision</span><select class="cursor-interaction" aria-label="Document revision"></select></label><span class="arr-review"></span></div><p class="arr-storage" role="status"></p><div class="arr-actions"><button type="button" class="cursor-interaction" data-arr="commit">Keep revision</button><button type="button" class="cursor-interaction" data-arr="save">Save to project</button><button type="button" class="cursor-interaction" data-arr="pdf">Export PDF</button></div><p class="arr-error" role="alert" hidden></p>';
    slot.replaceChildren(root); const q = selector => root.querySelector(selector); let destroyed = false;
    function render() {
      if (destroyed) return;
      const state = store.getState(), doc = store.getDocument(id); root.hidden = !doc; if (!doc) return;
      const selected = doc.versions.find(item => item.version === doc.selectedVersion), busy = state.pending.some(key => key.startsWith(id + '\u241f'));
      q('.arr-document-id').textContent = doc.documentId;
      q('select').replaceChildren(...doc.versions.map(version => { const option = document.createElement('option'); option.value = version.version; option.textContent = 'v' + version.version + (version.version === doc.currentVersion ? ' · Latest' : ''); option.selected = version.version === doc.selectedVersion; return option; }));
      q('.arr-review').textContent = doc.draft.dirty && doc.selectedVersion === doc.currentVersion ? 'Edited draft · Unreviewed' : selected.review.status.replaceAll('_', ' ');
      q('.arr-storage').textContent = doc.draft.dirty ? 'Unsaved edits. Earlier revisions and their review results are preserved.' : selected.persistence === 'host' ? 'This revision is stored by the connected document service.' : 'This revision is available in this session. Project document storage has not confirmed a save.';
      q('[data-arr="commit"]').disabled = busy || !doc.draft.dirty || doc.selectedVersion !== doc.currentVersion;
      q('[data-arr="save"]').disabled = busy || !state.capabilities.saveDocument || doc.selectedVersion !== doc.currentVersion;
      q('[data-arr="save"]').title = state.capabilities.saveDocument ? 'Save this exact revision to the connected project' : 'Connect a document storage service to save project revisions';
      q('[data-arr="pdf"]').disabled = busy || !state.capabilities.exportPDF || doc.draft.dirty && doc.selectedVersion === doc.currentVersion;
      q('[data-arr="pdf"]').title = state.capabilities.exportPDF ? 'Export the selected document version' : 'PDF export requires a connected document service';
      q('.arr-error').textContent = doc.error || ''; q('.arr-error').hidden = !doc.error;
    }
    root.addEventListener('change', event => { if (event.target === q('select')) { const revision = store.selectVersion(id, event.target.value); options.onVersion?.(revision, store.getDocument(id)); } }, { signal: controller.signal });
    root.addEventListener('click', async event => {
      const button = event.target.closest('[data-arr]'); if (!button || button.disabled) return;
      try {
        if (button.dataset.arr === 'commit') { const revision = store.commitDraft(id); options.onVersion?.(revision, store.getDocument(id)); options.toast?.('New revision kept in this session. It needs its own review.'); }
        else if (button.dataset.arr === 'save') { const revision = await store.saveDocument(id); if (!destroyed) { options.onVersion?.(revision, store.getDocument(id)); options.toast?.('This document revision was saved by the connected service.'); } }
        else if (button.dataset.arr === 'pdf') { const result = await store.exportPDF(id); if (!destroyed) options.onExport?.(result); }
      } catch (error) { if (!destroyed) { q('.arr-error').textContent = String(error?.message || error); q('.arr-error').hidden = false; } }
    }, { signal: controller.signal });
    const unsubscribe = store.subscribe(render); options.icons?.();
    return { render, destroy() { destroyed = true; unsubscribe(); controller.abort(); root.remove(); } };
  }
  window.AthenaResearchRecords = Object.freeze({ create, mountToolbar });
})();
