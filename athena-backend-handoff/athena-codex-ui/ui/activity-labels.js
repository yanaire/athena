/* Human-readable activity labels. Internal identifiers remain unchanged in state. */
(() => {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const uuid = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
  const opaque = /^(?:(?:task|run|session|agent|attempt|tool|process|request|call|turn)[_:-][0-9a-f]{16,}|[0-9a-f]{24,})$/i;
  const tokenCharacter = /[\p{L}\p{N}_-]/u;
  function containsId(value, id) {
    if (typeof id !== 'string' || !id) return false;
    for (let from = 0, at; (at = value.indexOf(id, from)) !== -1; from = at + id.length) {
      const before = value[at - 1], after = value[at + id.length];
      if ((!before || !tokenCharacter.test(before)) && (!after || !tokenCharacter.test(after))) return true;
    }
    return false;
  }
  function text(value, fallback = '', ids = []) {
    if (typeof value !== 'string' || !value.trim()) return fallback;
    const candidate = value.trim();
    const known = ids.some(id => containsId(candidate, id));
    return known || uuid.test(candidate) || opaque.test(candidate) ? fallback : candidate;
  }
  function task(value, tasks = [], fallback = 'Background task') {
    const list = Array.isArray(tasks) ? tasks : [];
    const item = value && typeof value === 'object' ? value : list.find(entry => entry.id === value);
    if (!item) return fallback;
    const index = list.findIndex(entry => entry.id === item.id);
    return text(item.title, index < 0 ? fallback : 'Task ' + (index + 1), [item.id, item.taskId, item.sessionId, item.runId, item.attemptId, item.agentSessionId]);
  }
  function agent(value = {}, tasks = []) {
    const item = value || {};
    const roles = { main: 'Coordinator', parent: 'Coordinator', researcher: 'Research agent', analyst: 'Analysis agent', reviewer: 'Review agent', writer: 'Writing agent', worker: 'Subagent' };
    const ids = [item.id, item.taskId, item.agentSessionId, item.sessionId, item.runId, item.attemptId];
    const name = text(item.name || item.agentName, '', ids);
    if (name) return name;
    const role = roles[item.role] || text(item.role, 'Subagent', ids);
    const index = (Array.isArray(tasks) ? tasks : []).findIndex(entry => entry.id === item.taskId);
    return role + (index < 0 || ['main', 'parent'].includes(item.role) ? '' : ' ' + (index + 1));
  }
  function attempt(id, task = {}) {
    const attempts = Array.isArray(task?.attempts) ? task.attempts : [];
    const index = attempts.findIndex(item => (typeof item === 'string' ? item : item.id || item.attemptId) === id);
    return index >= 0 ? 'Attempt ' + (index + 1) : id && id !== task?.attemptId && id !== task?.currentAttemptId ? 'Attempt' : 'Current attempt';
  }
  function diagnostics(entries, key = '') {
    const rows = entries.filter(([, value]) => value != null && value !== '').map(([label, value]) => '<div><dt>' + esc(label) + '</dt><dd>' + esc(value) + '</dd></div>').join('');
    return rows ? '<details class="aw-diagnostics" data-aw-diagnostics="' + esc(key) + '"><summary class="cursor-interaction">Technical details</summary><dl>' + rows + '</dl></details>' : '';
  }
  window.AthenaActivityLabels = Object.freeze({ text, task, agent, attempt, diagnostics });
})();
