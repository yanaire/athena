import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import test from 'node:test';
import { mcpClient } from '../runtime/mcp-client.ts';
import { bindCall, csvRegistration, rcRegistration, registerBuiltins, verifyMcpOutput } from '../runtime/mcp-registry.ts';

const rc = rcRegistration.binding;

test('registrations have unique server IDs, child aliases and fixed local filenames', () => {
  for (const identity of [{ alias: 'calculate_csv' }, { server: 'athena-measurements' }, { alias: 'read' }]) {
    const conflict = { ...rcRegistration, binding: { ...rc, identity: { ...rc.identity, ...identity } } };
    assert.throws(() => registerBuiltins([csvRegistration, conflict]), /Duplicate/);
  }
  assert.throws(() => registerBuiltins([{ ...rcRegistration, binding: { ...rc, inputName: '../circuit.json' } }]), /binding/);
  assert.deepEqual(bindCall(csvRegistration, { fileId: 'a', column: 'voltage' }), { fileId: 'a', wire: { column: 'voltage' } });
  for (const args of [{ path: 'circuit.json' }, { column: 'voltage' }, { command: 'node' }, { env: {} }]) {
    assert.throws(() => bindCall(rcRegistration, args), /Invalid arguments/);
  }
});

function connection() {
  const calls: string[] = [];
  const stdin = new Writable({ write(chunk, _encoding, done) { calls.push(JSON.parse(chunk.toString()).method); done(); } });
  const client = mcpClient(stdin, rcRegistration, 'call-id', {}, () => {});
  client.initialize();
  const receive = (id: string | number, result: unknown) => client.consume(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  return { calls, client, receive };
}
const init = { protocolVersion: rc.identity.protocol, capabilities: { tools: {} },
  serverInfo: { name: rc.identity.server, version: rc.identity.version } };
const listed = { name: rc.identity.tool, inputSchema: rc.inputSchema };

test('MCP checks correlation, protocol, server identity and exact advertised schema before calling', () => {
  for (const change of [{ protocolVersion: 'other' }, { capabilities: {} }, { serverInfo: { ...init.serverInfo, name: 'another' } },
    { serverInfo: { ...init.serverInfo, version: '0.0.0' } }]) {
    const c = connection();
    assert.throws(() => c.receive(1, { ...init, ...change }), /Incompatible/);
    assert.deepEqual(c.calls, ['initialize']);
  }
  for (const tools of [[], [{ ...listed, name: 'absent' }], [{ ...listed, inputSchema: { type: 'string' } }], [listed, listed]]) {
    const c = connection();
    c.receive(1, init);
    assert.throws(() => c.receive(2, { tools }), /listing/);
    assert.deepEqual(c.calls, ['initialize', 'notifications/initialized', 'tools/list']);
  }
  const c = connection();
  assert.throws(() => c.receive(2, init), /Unexpected/);
});

test('result publication requires the complete MCP receipt, exact stored bytes and registered result format', () => {
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, timeConstantSeconds: 1, cutoffHz: 0.159,
    samples: [{ timeSeconds: 0, outputVolt: 0 }] }));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const receipt = { filename: rc.outputName, sha256 };
  for (const bad of [{ ...receipt, filename: 'other.json' }, { ...receipt, sha256: 'invalid' }]) {
    const c = connection(); c.receive(1, init); c.receive(2, { tools: [listed] });
    assert.throws(() => c.receive('call-id', { content: [], structuredContent: bad }), /receipt/);
    assert.equal(c.client.digest(), undefined);
  }
  const c = connection(); c.receive(1, init); c.receive(2, { tools: [listed] });
  c.receive('call-id', { content: [{ type: 'text', text: 'done' }], structuredContent: receipt });
  assert.deepEqual(c.calls, ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
  assert.equal(verifyMcpOutput(rcRegistration, bytes, c.client.digest()), sha256);
  assert.throws(() => verifyMcpOutput(rcRegistration, Buffer.concat([bytes, Buffer.from('\n')]), sha256), /does not match/);
  const invalid = Buffer.from('{}');
  assert.throws(() => verifyMcpOutput(rcRegistration, invalid, createHash('sha256').update(invalid).digest('hex')), /Invalid result/);
});
