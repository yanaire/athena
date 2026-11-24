import type { Writable } from 'node:stream';

import { measurements as csvServer } from './mcp-contract.mjs';
export { csvServer };
export type CsvMcpPhase = 'initialize' | 'tools/list' | 'tools/call';
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// One stdio server per granted snapshot. Only the caller's fixed tool is admissible.
export function csvMcpClient(stdin: Writable, toolId: string, column: string | undefined,
  progress: (phase: CsvMcpPhase) => void) {
  let expected: string | number = 1;
  let buffer = '';
  let finished = false;
  let digest: string | undefined;
  function send(method: string, params: object, id?: string | number) {
    stdin.write(JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params }) + '\n');
  }
  function response(line: string) {
    const msg: unknown = JSON.parse(line);
    if (finished || !record(msg) || msg.jsonrpc !== '2.0' || msg.id !== expected || !record(msg.result) || msg.error) {
      throw new Error('Unexpected MCP response from the measurement server.');
    }
    const result = msg.result;
    if (expected === 1) {
      if (result.protocolVersion !== csvServer.protocol || !record(result.capabilities) || !record(result.capabilities.tools)
        || !record(result.serverInfo) || result.serverInfo.name !== csvServer.server || result.serverInfo.version !== csvServer.version) {
        throw new Error('Incompatible measurement MCP server.');
      }
      send('notifications/initialized', {});
      expected = 2;
      progress('tools/list');
      send('tools/list', {}, expected);
    } else if (expected === 2) {
      if (!Array.isArray(result.tools) || !result.tools.some(t => record(t) && t.name === csvServer.tool
        && record(t.inputSchema) && t.inputSchema.type === 'object')) throw new Error('The measurement MCP tool is unavailable.');
      expected = toolId;
      progress('tools/call');
      send('tools/call', { name: csvServer.tool, arguments: column === undefined ? {} : { column } }, expected);
    } else {
      finished = true;
      stdin.end();
      if (result.isError === true) {
        const detail = Array.isArray(result.content) && result.content.find(v => record(v) && v.type === 'text');
        throw new Error(typeof detail?.text === 'string' ? detail.text : 'Measurement MCP calculation failed.');
      }
      const receipt = result.structuredContent;
      if (!record(receipt) || receipt.filename !== 'statistics.json' || typeof receipt.sha256 !== 'string'
        || !/^[0-9a-f]{64}$/.test(receipt.sha256)) throw new Error('Missing MCP output receipt.');
      digest = receipt.sha256;
    }
  }
  return {
    initialize() {
      send('initialize', { protocolVersion: csvServer.protocol, capabilities: {}, clientInfo: { name: 'Athena', version: '1.0.0' } }, 1);
    },
    consume(text: string) {
      buffer += text;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        response(line);
      }
    },
    digest() { return buffer.trim() ? undefined : digest; },
    get finished() { return finished; },
  };
}
