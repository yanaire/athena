'use strict';
// Host contract checks only. No provider, network, browser or storage service is called.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
function create() {
  const context = vm.createContext({ window: {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../ui/connection-manager.js'), 'utf8'), context);
  return context.window.AthenaConnectionManager.create();
}
const config = { version: 1, provider: 'local', endpoint: 'http://localhost:10100/v1', defaultModel: 'research', roleModels: { main: '', researcher: '', analyst: '', reviewer: '', writer: '' }, parallelLimit: 2, contextBudget: 32768, outputBudget: 4096 };
test('No attached host cannot verify, save, or create a session', async () => {
  const manager = create();
  for (const call of [() => manager.verify(config), () => manager.saveConfig(config), () => manager.createSession({ projectId: 'p' })]) await assert.rejects(call, /does not support/);
  assert.equal(manager.getState().status, 'disconnected'); assert.equal(manager.getDefaultModel(), null);
});
test('Adapter availability alone does not claim connection and rejected saves do not install a default', async () => {
  const manager = create();
  manager.attach({ saveConfig: async () => ({ saved: false, configurationId: 'unconfirmed' }) });
  assert.equal(manager.getState().attached, true); assert.equal(manager.getState().status, 'disconnected');
  await assert.rejects(manager.saveConfig(config), /did not confirm/);
  assert.equal(manager.getState().configurationId, null); assert.equal(manager.getDefaultModel(), null);
});
test('Explicit save, endpoint verification, and session creation stay distinct', async () => {
  const manager = create(), calls = [];
  const connection = { subscribe() { return () => {}; } };
  manager.attach({
    async saveConfig(value) { calls.push(['save', value]); return { saved: true, configurationId: 'cfg-2', revision: 4, defaultModel: { provider: 'local-provider', modelId: 'research' } }; },
    async verifyConnection(value) { calls.push(['verify', value]); return { status: 'connected', checkedAt: '2026-11-20T00:00:00Z', models: [{ provider: 'local-provider', modelId: 'research' }] }; },
    async createSession(input) { calls.push(['session', input]); return { sessionId: 'session-2', projectId: input.projectId, connection }; }
  });
  await manager.saveConfig(config);
  assert.equal(calls.length, 1); assert.equal(calls[0][1].endpoint, config.endpoint);
  assert.equal(manager.getState().status, 'configured'); assert.equal(manager.getState().verification.status, 'not_checked');
  await manager.verify(config); assert.equal(calls.length, 2); assert.equal(manager.getState().status, 'connected');
  const session = await manager.createSession({ projectId: 'p', configurationId: 'cfg-2', model: manager.getDefaultModel() });
  assert.equal(calls.length, 3); assert.equal(session.sessionId, 'session-2'); assert.equal(session.connection, connection);
});
test('An old host response cannot update a newly attached host', async () => {
  const manager = create(); let resolve;
  manager.attach({ saveConfig: () => new Promise(done => { resolve = done; }) });
  const pending = manager.saveConfig(config), rejected = assert.rejects(pending, /host changed/);
  manager.attach({ verifyConnection: async () => ({ status: 'failed' }) });
  resolve({ saved: true, configurationId: 'obsolete', defaultModel: { provider: 'old', modelId: 'old' } }); await rejected;
  assert.equal(manager.getState().configurationId, null); assert.equal(manager.getDefaultModel(), null);
});
test('A host must confirm a new session ID; empty success-shaped responses are rejected', async () => {
  const manager = create(); manager.attach({ createSession: async () => ({ success: true }) });
  await assert.rejects(manager.createSession({ projectId: 'p' }), /did not confirm a new session/);
});
