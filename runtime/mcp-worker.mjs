import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { constants, closeSync, fstatSync, openSync, readSync, writeFileSync } from 'node:fs';

export class McpDataError extends Error {}

function input(binding) {
  const fd = openSync(binding.inputName, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size < 1 || st.size > binding.inputBytes) throw new McpDataError('Input size is invalid.');
    const data = Buffer.allocUnsafe(binding.inputBytes + 1);
    let size = 0;
    while (size < data.length) {
      const n = readSync(fd, data, size, data.length - size, size);
      if (!n) break;
      size += n;
    }
    if (size !== st.size) throw new McpDataError('Input changed during reading.');
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, size));
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      throw new McpDataError('Input must be valid UTF-8.');
    }
  } finally {
    closeSync(fd);
  }
}

export async function serve(binding, description, calculate, receiptFields = () => ({})) {
  const {identity} = binding;
  const tool = {name: identity.tool, description, inputSchema: binding.inputSchema};
  const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
  let phase = 'new';
  function dispatch(msg) {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      send({ id: null, error: { code: -32600, message: 'Invalid Request' } });
      return;
    }
    const { method, params = {}, id } = msg;
    if (id === undefined) {
      if (method === 'notifications/initialized' && phase === 'initializing') phase = 'ready';
      return;
    }
    const fail = (code, message) => send({ id, error: { code, message } });
    const reply = result => send({ id, result });
    if (method === 'ping') return reply({});
    if (method === 'initialize' && phase === 'new') {
      phase = 'initializing';
      return reply({ protocolVersion: identity.protocol, capabilities: { tools: {} }, serverInfo: { name: identity.server, version: identity.version } });
    }
    if (phase !== 'ready') return fail(-32600, 'MCP server is not initialized.');
    if (method === 'tools/list') return reply({ tools: [tool] });
    if (method !== 'tools/call') return fail(-32601, 'Method not found');
    const args = params?.arguments === undefined ? {} : params.arguments;
    if (params?.name !== tool.name || !args || typeof args !== 'object' || Array.isArray(args) || !binding.validArgs(args)) {
      return fail(-32602, 'Invalid MCP tool or arguments.');
    }
    try {
      const result = calculate(input(binding), args);
      const json = JSON.stringify(result) + '\n';
      if (Buffer.byteLength(json) > binding.outputBytes) throw new McpDataError('Results exceed the artifact size limit.');
      writeFileSync(binding.outputName, json, { flag: 'wx', mode: 0o400 });
      const receipt = { filename: binding.outputName, ...receiptFields(result), sha256: createHash('sha256').update(json).digest('hex') };
      return reply({ content: [{ type: 'text', text: JSON.stringify(receipt) }], structuredContent: receipt });
    } catch (error) {
      const message = error instanceof McpDataError ? error.message : 'Could not read the granted input or write the result.';
      return reply({ isError: true, content: [{ type: 'text', text: message }] });
    }
  }
  process.umask(0o077);
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    let msg;
    try { msg = JSON.parse(line); }
    catch { send({ id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
    dispatch(msg);
  }
}
