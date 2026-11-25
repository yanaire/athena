/* A view of durable host research records. Planned stages, executed evidence,
 * independent review and human conventions remain distinct. */
(() => {
  'use strict';
  const rows = value => Array.isArray(value) ? value : [];
  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const verdicts = { supported: 'Supported by checked evidence', changes_required: 'Changes required', insufficient_evidence: 'Insufficient evidence' };
  const states = { awaiting_reviewer: 'Awaiting reviewer', pending: 'Review in progress', completed: 'Review submitted', failed: 'Review failed', cancelled: 'Review cancelled', paused: 'Review paused' };
  const phases = { planned: 'Plan recorded', evidence_recorded: 'Evidence recorded', review_pending: 'Review pending', review_interrupted: 'Review interrupted', reviewed: 'Review recorded', knowledge_recorded: 'Knowledge recorded' };
  const levels = { observation: 'Observation', verified: 'Independently checked', convention: 'Team convention' };
  const when = value => Number.isFinite(Number(value)) ? new Date(Number(value)).toLocaleString() : 'Time not reported';

  function mount(host, options = {}) {
    if (!host) throw new TypeError('AthenaResearchBoard.mount requires a host element.');
    const controller = new AbortController();
    let service = options.service || null, snapshot = null, destroyed = false, busy = false, request = 0, generation = 0;
    let projectId = null, sessionId = null, revision = null, refreshTimer = null, failure = '';
    const opened = new Map();
    const workspace = () => options.getWorkspace?.() || {};
    const q = selector => host.querySelector(selector);
    const hiddenIds = () => [projectId, sessionId, ...['tasks', 'agents', 'attempts', 'processes'].flatMap(key => rows(workspace()[key]).flatMap(item => [item.id, item.taskId, item.attemptId, item.agentSessionId]))];
    const publicText = value => window.AthenaActivityLabels ? window.AthenaActivityLabels.text(value, '', hiddenIds()) : String(value ?? '');
    const details = (fields, key) => '<details class="arb-details" data-arb-detail="' + esc(key) + '"><summary>Technical details</summary><dl>' + fields.filter(([, value]) => value !== undefined && value !== null && value !== '').map(([name, value]) => '<div><dt>' + esc(name) + '</dt><dd>' + esc(typeof value === 'object' ? JSON.stringify(value, null, 2) : value) + '</dd></div>').join('') + '</dl></details>';
    const provenance = record => details([['Record ID', record.id], ['Mission ID', record.missionId], ['Project ID', record.projectId || record.createdBy?.projectId], ['Conversation ID', record.sessionId || record.createdBy?.sessionId], ['Run ID', record.runId || record.createdBy?.runId], ['Task ID', record.createdBy?.taskId], ['Attempt ID', record.createdBy?.attemptId], ['Agent session ID', record.createdBy?.agentSessionId], ['Created', when(record.createdAt)]], 'record-' + record.id);
    const list = values => '<ul>' + rows(values).map(value => '<li>' + esc(publicText(value)) + '</li>').join('') + '</ul>';
    host.classList.add('arb-host');
    host.innerHTML = '<section class="arb-panel" aria-label="Research board"><header class="arb-heading"><div><h3>Research board</h3><p>Plans, execution evidence and reviews</p></div><button type="button" class="arb-button cursor-interaction" data-arb-action="refresh">Refresh</button></header><p class="arb-error" role="alert" data-arb-error hidden></p><div data-arb-records></div></section>';

    function evidenceHTML(evidence) {
      return '<article class="arb-card"><h4>' + esc(publicText(evidence.title) || 'Saved evidence') + '</h4>' + (evidence.summary ? '<p>' + esc(publicText(evidence.summary)) + '</p>' : '')
        + '<ul class="arb-targets">' + rows(evidence.targets).map(target => {
          const artifact = rows(workspace().artifacts).find(item => item.id === target.id && String(item.version ?? item.file?.versionId ?? item.file?.sha256) === String(target.version) && (item.file?.sha256 || item.sha256) === target.sha256);
          const title = artifact?.title || artifact?.file?.name || (target.kind === 'artifact' ? 'Saved result version' : 'Original input version');
          return '<li>' + (artifact ? '<button type="button" class="arb-link cursor-interaction" data-arb-action="artifact" data-artifact="' + esc(target.id) + '" data-version="' + esc(target.version) + '">' + esc(publicText(title)) + '</button>' : '<span>' + esc(title) + '</span>')
            + '<span class="arb-caption">' + (target.kind === 'artifact' ? 'Result' : 'Input') + ' · ' + esc(target.bytes) + ' bytes</span>'
            + details([['Type', target.kind], ['ID', target.id], ['Version', target.version], ['SHA-256', target.sha256], ['Producer task ID', target.taskId], ['Producer attempt ID', target.attemptId], ['Producer session ID', target.agentSessionId]], 'target-' + evidence.id + '-' + target.id) + '</li>';
        }).join('') + '</ul>' + provenance(evidence) + '</article>';
    }

    function reviewHTML(review) {
      const completed = review.state === 'completed';
      const task = rows(workspace().tasks).find(item => item.id === review.reviewer?.taskId);
      const reviewerName = task ? window.AthenaActivityLabels?.task(task, rows(workspace().tasks), 'Review worker') || 'Review worker' : 'Review worker';
      return '<article class="arb-card"><div class="arb-card-heading"><h4>' + esc(publicText(review.question) || 'Independent review') + '</h4><span class="arb-badge" data-state="' + esc(review.state) + '">' + (states[review.state] || 'Status unavailable') + '</span></div>'
        + (completed && Object.hasOwn(verdicts, review.verdict) ? '<p class="arb-verdict">' + verdicts[review.verdict] + '</p>' : '<p class="arb-caption">No completed review verdict is recorded.</p>')
        + (review.reviewer ? '<p class="arb-caption">' + esc(reviewerName) + ' · separate worker session</p>' : '')
        + (rows(review.checks).length ? '<h5>Checks performed</h5>' + list(review.checks) : '')
        + (rows(review.findings).length ? '<h5>Findings and limitations</h5>' + list(review.findings) : '')
        + details([['Review ID', review.id], ['Evidence IDs', review.evidenceIds], ['Reviewer task ID', review.reviewer?.taskId], ['Reviewer attempt ID', review.reviewer?.attemptId], ['Reviewer agent session ID', review.reviewer?.agentSessionId], ['Reproduction evidence IDs', review.reproductionEvidenceIds], ['Submitted', review.submittedAt ? when(review.submittedAt) : undefined]], 'review-' + review.id) + '</article>';
    }

    function bookHTML(book) {
      const active = book.state === 'active';
      const replacements = rows(snapshot?.books).filter(item => item.id !== book.id && item.state === 'active');
      return '<article class="arb-card"><div class="arb-card-heading"><h4>' + esc(publicText(book.title) || 'Reusable method') + '</h4><span class="arb-badge" data-state="' + esc(book.state) + '">' + (active ? levels[book.level] || 'Unclassified' : book.state === 'revoked' ? 'Revoked' : 'Superseded') + '</span></div>'
        + '<h5>Method</h5><p>' + esc(publicText(book.method)) + '</p><h5>Rationale</h5><p>' + esc(publicText(book.rationale)) + '</p>'
        + '<h5>When it applies</h5>' + list(book.applicability)
        + details([['Knowledge ID', book.id], ['Evidence IDs', book.evidenceIds], ['Review IDs', book.reviewIds], ['History', book.history], ['Created', when(book.createdAt)]], 'book-' + book.id)
        + (active && service?.decideKnowledge ? '<details class="arb-decision" data-arb-detail="decision-' + esc(book.id) + '"><summary class="cursor-interaction">Manage this knowledge record</summary><label>Reason<textarea rows="2" maxlength="4096" data-arb-reason="' + esc(book.id) + '" placeholder="Explain this decision"></textarea></label><div class="arb-actions">'
          + (book.level === 'verified' ? '<button type="button" class="arb-button cursor-interaction" data-arb-action="convention" data-book="' + esc(book.id) + '">Confirm team convention</button>' : '')
          + '<button type="button" class="arb-button cursor-interaction" data-arb-action="revoke" data-book="' + esc(book.id) + '">Revoke</button></div>'
          + (replacements.length ? '<label>Replacement<select data-arb-replacement="' + esc(book.id) + '"><option value="">Choose a saved record</option>' + replacements.map(item => '<option value="' + esc(item.id) + '">' + esc(publicText(item.title)) + '</option>').join('') + '</select></label><button type="button" class="arb-button cursor-interaction" data-arb-action="supersede" data-book="' + esc(book.id) + '">Replace with selected record</button>' : '') + '</details>' : '') + '</article>';
    }

    function memoryHTML(memory) {
      const task = rows(workspace().tasks).find(item => item.id === memory.createdBy?.taskId);
      const author = window.AthenaActivityLabels?.task(task, rows(workspace().tasks), 'Research worker') || 'Research worker';
      return '<article class="arb-card"><p>' + esc(publicText(memory.text)) + '</p><p class="arb-caption">' + esc(author) + ' · ' + esc(when(memory.createdAt)) + '</p>' + provenance(memory) + '</article>';
    }

    function recordsHTML() {
      if (!service?.getResearch) return '<p class="arb-empty">Research records are available when a supporting Athena host is connected.</p>';
      if (!projectId || !sessionId) return '<p class="arb-empty">Open a project conversation to view its research records.</p>';
      if (!snapshot) return '<p class="arb-empty">Loading saved research records…</p>';
      const missions = rows(snapshot.missions);
      const content = missions.map(mission => {
        const evidence = rows(snapshot.evidence).filter(item => item.missionId === mission.id);
        const reviews = rows(snapshot.reviews).filter(item => item.missionId === mission.id);
        return '<section class="arb-mission"><h4 class="arb-objective">' + esc(publicText(mission.objective)) + '</h4><div class="arb-counts">' + (Object.hasOwn(phases, mission.phase) ? '<span class="arb-badge" data-state="' + esc(mission.phase) + '">' + phases[mission.phase] + '</span>' : '') + '<span>' + evidence.length + ' evidence records</span><span>' + reviews.filter(item => item.state === 'completed').length + ' completed reviews</span></div>'
          + '<details class="arb-plan" data-arb-detail="mission-' + esc(mission.id) + '"><summary>Plan &amp; acceptance criteria</summary><h5>Acceptance criteria</h5>' + list(mission.acceptanceCriteria) + '<h5>Planned stages</h5><ol>' + rows(mission.stages).map(stage => '<li>' + esc(publicText(stage)) + '</li>').join('') + '</ol><p class="arb-caption">These stages describe the plan. Completion is established by the execution and review records below.</p>' + provenance(mission) + '</details>'
          + (evidence.length ? '<details data-arb-detail="evidence-' + esc(mission.id) + '"><summary>Execution evidence · ' + evidence.length + '</summary>' + evidence.map(evidenceHTML).join('') + '</details>' : '<p class="arb-caption">No execution evidence has been recorded yet.</p>')
          + (reviews.length ? '<details data-arb-detail="reviews-' + esc(mission.id) + '"><summary>Independent reviews · ' + reviews.length + '</summary>' + reviews.map(reviewHTML).join('') + '</details>' : '') + '</section>';
      }).join('');
      const books = rows(snapshot.books);
      const projectNotes = rows(snapshot.memories?.project), workerNotes = rows(snapshot.memories?.agents);
      return content + (!missions.length ? '<p class="arb-empty">No research plan has been recorded in this conversation. Ask Athena to plan the study, preserve its evidence and request an independent review.</p>' : '')
        + (books.length ? '<details class="arb-books" data-arb-detail="books"><summary>Reusable knowledge · ' + books.length + '</summary><p class="arb-caption">Observations, independently checked methods and human-confirmed conventions remain separate.</p>' + books.map(bookHTML).join('') + '</details>' : '')
        + (projectNotes.length || workerNotes.length ? '<details data-arb-detail="working-notes"><summary>Working notes · ' + (projectNotes.length + workerNotes.length) + '</summary><p class="arb-caption">Working notes preserve research context. They are not independently verified knowledge.</p>' + (projectNotes.length ? '<h5>Project notes</h5>' + projectNotes.map(memoryHTML).join('') : '') + (workerNotes.length ? '<h5>Worker notes in this conversation</h5>' + workerNotes.map(memoryHTML).join('') : '') + '</details>' : '');
    }

    function render() {
      if (destroyed) return;
      host.hidden = workspace().mode !== 'runtime';
      q('[data-arb-error]').textContent = failure; q('[data-arb-error]').hidden = !failure;
      const target = q('[data-arb-records]'), html = recordsHTML();
      if (target._arbHTML !== html) {
        for (const detail of target.querySelectorAll('[data-arb-detail]')) opened.set(detail.dataset.arbDetail, detail.open);
        const drafts = new Map([...target.querySelectorAll('[data-arb-reason]')].map(field => [field.dataset.arbReason, field.value]));
        target.innerHTML = html; target._arbHTML = html;
        for (const detail of target.querySelectorAll('[data-arb-detail]')) detail.open = opened.get(detail.dataset.arbDetail) === true;
        for (const field of target.querySelectorAll('[data-arb-reason]')) field.value = drafts.get(field.dataset.arbReason) || '';
      }
      for (const button of host.querySelectorAll('button')) button.disabled = busy || !service?.getResearch || !projectId || !sessionId;
      for (const field of host.querySelectorAll('input,textarea,select')) field.disabled = busy;
      options.icons?.();
    }

    async function refresh() {
      clearTimeout(refreshTimer); refreshTimer = null;
      if (destroyed || busy || !service?.getResearch || !projectId || !sessionId) return;
      const token = ++request, owner = generation, project = projectId, session = sessionId;
      try {
        const next = await service.getResearch(project, session);
        if (destroyed || owner !== generation || token !== request || project !== projectId || session !== sessionId) return;
        if (!next || next.schemaVersion !== 1 || next.projectId !== project || !['missions', 'evidence', 'reviews', 'books'].every(key => Array.isArray(next[key]))) throw new Error('The host returned invalid research records.');
        snapshot = next; failure = ''; render();
      } catch (error) {
        if (destroyed || owner !== generation || token !== request || project !== projectId || session !== sessionId) return;
        failure = String(error?.message || error); render();
      }
    }

    function update() {
      const next = workspace();
      if (next.projectId !== projectId || next.sessionId !== sessionId) {
        ++generation; ++request; busy = false; snapshot = null; failure = ''; opened.clear();
        projectId = next.projectId || null; sessionId = next.sessionId || null; revision = next.revision;
        delete q('[data-arb-records]')._arbHTML; q('[data-arb-records]').replaceChildren(); render(); void refresh(); return;
      }
      if (revision !== next.revision) { revision = next.revision; clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 150); }
      render();
    }

    host.addEventListener('click', event => {
      const button = event.target.closest('[data-arb-action]');
      if (!button || !host.contains(button) || button.disabled) return;
      const action = button.dataset.arbAction;
      if (action === 'refresh') { void refresh(); return; }
      if (action === 'artifact') { options.onNavigate?.('artifacts', { artifactId: button.dataset.artifact, version: button.dataset.version }); return; }
      if (!['convention', 'revoke', 'supersede'].includes(action) || !service?.decideKnowledge || !snapshot) return;
      const book = rows(snapshot.books).find(item => item.id === button.dataset.book);
      if (!book || book.state !== 'active' || action === 'convention' && book.level !== 'verified') return;
      const reason = [...host.querySelectorAll('[data-arb-reason]')].find(field => field.dataset.arbReason === book.id)?.value.trim();
      const replacementId = [...host.querySelectorAll('[data-arb-replacement]')].find(field => field.dataset.arbReplacement === book.id)?.value;
      if (!reason || action === 'supersede' && !replacementId) { failure = !reason ? 'Explain the decision before saving it.' : 'Choose a saved replacement record.'; render(); return; }
      const owner = generation, project = projectId;
      busy = true; failure = ''; ++request; render();
      void (async () => {
        try { await service.decideKnowledge(project, book.id, { decision: action, reason, ...(action === 'supersede' ? { replacementId } : {}) }); }
        catch (error) { if (!destroyed && owner === generation) failure = String(error?.message || error); }
        finally {
          if (!destroyed && owner === generation) { busy = false; const savedFailure = failure; render(); await refresh(); if (savedFailure && owner === generation) { failure = savedFailure; render(); } }
        }
      })();
    }, { signal: controller.signal });

    update();
    return {
      setService(value) { ++generation; ++request; busy = false; service = value || null; snapshot = null; failure = ''; opened.clear(); q('[data-arb-records]').replaceChildren(); delete q('[data-arb-records]')._arbHTML; render(); void refresh(); },
      update,
      refresh,
      getState: () => ({ connected: Boolean(service), projectId, sessionId, snapshot, busy, error: failure }),
      destroy() { if (destroyed) return; destroyed = true; ++generation; ++request; clearTimeout(refreshTimer); controller.abort(); host.replaceChildren(); host.classList.remove('arb-host'); }
    };
  }
  window.AthenaResearchBoard = Object.freeze({ mount });
})();
