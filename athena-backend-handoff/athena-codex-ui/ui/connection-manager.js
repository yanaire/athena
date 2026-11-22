/* Capability-gated connection administration. The host owns network access,
 * credentials, durable configuration and creation of execution sessions. */
(() => {
  'use strict';
  const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const validModel = value => value && typeof value.provider === 'string' && value.provider && typeof value.modelId === 'string' && value.modelId;
  const model = value => validModel(value) ? { provider: value.provider, modelId: value.modelId, ...(typeof value.thinkingLevel === 'string' ? { thinkingLevel: value.thinkingLevel } : {}) } : null;
  const initial = () => ({ attached: false, status: 'disconnected', capabilities: { saveConfig: false, verifyConnection: false, createSession: false }, busy: [], configurationId: null, revision: null, defaultModel: null, verification: { status: 'not_checked' }, error: null });
  function create() {
    let host = null, state = initial(), epoch = 0, destroyed = false, unsubscribe = null;
    const listeners = new Set(), pending = new Map();
    const getState = () => copy(state);
    const publish = () => { if (destroyed) return; state.busy = [...pending.keys()]; for (const fn of listeners) fn(getState()); };
    function acceptSnapshot(value) {
      if (!value || typeof value !== 'object') return;
      if (['disconnected', 'configured', 'connected', 'error'].includes(value.status)) state.status = value.status;
      if (typeof value.configurationId === 'string') state.configurationId = value.configurationId;
      if (typeof value.revision === 'string' || typeof value.revision === 'number') state.revision = value.revision;
      if (value.defaultModel !== undefined) state.defaultModel = model(value.defaultModel);
      if (value.configuration !== undefined) state.configuration = copy(value.configuration);
      // Never infer connectivity from the existence of an adapter.
      if (value.verification && ['connected', 'failed', 'not_checked'].includes(value.verification.status)) state.verification = { status: value.verification.status, checkedAt: value.verification.checkedAt || null, message: String(value.verification.message || '') };
      publish();
    }
    function detach() {
      epoch++; unsubscribe?.(); unsubscribe = null; host = null; pending.clear(); state = initial(); publish();
    }
    function attach(adapter) {
      if (destroyed) throw new Error('Connection manager was destroyed.');
      if (!adapter || typeof adapter !== 'object') throw new TypeError('A connection adapter is required.');
      detach(); host = adapter; const bound = epoch;
      state.attached = true;
      for (const key of Object.keys(state.capabilities)) state.capabilities[key] = typeof adapter[key] === 'function';
      if (typeof adapter.subscribe === 'function') { const stop = adapter.subscribe(value => { if (bound === epoch && host === adapter && !destroyed) acceptSnapshot(value); }); if (typeof stop === 'function') unsubscribe = stop; }
      if (typeof adapter.getState === 'function') {
        try { const current = adapter.getState(); if (current && typeof current.then !== 'function') acceptSnapshot(current); } catch (error) { state.error = String(error?.message || error); }
      }
      publish(); return () => bound === epoch && host === adapter ? (detach(), true) : false;
    }
    async function invoke(method, input) {
      if (destroyed || !host || !state.capabilities[method]) throw new Error('The connection host does not support this action.');
      if (pending.size) throw new Error('Wait for the current connection request to finish.');
      const bound = epoch, owner = host, token = {}; pending.set(method, token); state.error = null; publish();
      try {
        const result = await owner[method](copy(input));
        if (destroyed || bound !== epoch || owner !== host) throw new Error('The connection host changed.');
        if (!result || typeof result !== 'object' || result.success === false) throw new Error(String(result?.error || 'The host did not confirm this operation.'));
        return result;
      } catch (error) { if (!destroyed && bound === epoch) { state.error = String(error?.message || error); publish(); } throw error; }
      finally { if (!destroyed && bound === epoch && pending.get(method) === token) { pending.delete(method); publish(); } }
    }
    async function saveConfig(configuration) {
      const bound = epoch;
      const result = await invoke('saveConfig', configuration);
      if (bound !== epoch || destroyed) throw new Error('The connection host changed.');
      if (result.saved !== true || typeof result.configurationId !== 'string' || !result.configurationId) throw new Error('The host did not confirm a saved configuration.');
      state.configurationId = result.configurationId; state.revision = result.revision ?? null;
      state.defaultModel = model(result.defaultModel); state.verification = { status: 'not_checked' };
      state.status = 'configured'; publish();
      return { saved: true, configurationId: state.configurationId, revision: state.revision, defaultModel: copy(state.defaultModel), ...(result.configuration ? { configuration: copy(result.configuration) } : {}) };
    }
    async function verify(configuration) {
      const bound = epoch;
      const result = await invoke('verifyConnection', configuration);
      if (bound !== epoch || destroyed) throw new Error('The connection host changed.');
      if (!['connected', 'failed'].includes(result.status)) throw new Error('The host did not return a connection-check result.');
      const verification = { status: result.status, checkedAt: result.checkedAt || null, message: String(result.message || '') };
      state.verification = verification; state.status = result.status === 'connected' ? 'connected' : 'error'; publish();
      return { ...copy(verification), models: Array.isArray(result.models) ? result.models.map(model).filter(Boolean) : [] };
    }
    async function createSession(input) {
      const result = await invoke('createSession', input);
      if (typeof result.sessionId !== 'string' || !result.sessionId) throw new Error('The host did not confirm a new session.');
      // A returned live Pi connection contains methods and must not be JSON
      // cloned. Only its surrounding serializable session metadata is copied.
      const { connection, ...metadata } = result;
      return { ...copy(metadata), ...(connection ? { connection } : {}) };
    }
    return { attach, detach, getState, saveConfig, verify, createSession, getDefaultModel: () => copy(state.defaultModel),
      subscribe(fn) { listeners.add(fn); fn(getState()); return () => listeners.delete(fn); },
      destroy() { if (destroyed) return; detach(); destroyed = true; listeners.clear(); }
    };
  }
  window.AthenaConnectionManager = Object.freeze({ create });
})();
