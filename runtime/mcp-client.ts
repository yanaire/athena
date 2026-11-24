import type { Writable } from 'node:stream';
import { isDeepStrictEqual } from 'node:util';
import type { Registration } from './mcp-registry.ts';

export type McpPhase = 'initialize' | 'tools/list' | 'tools/call';
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// One stdio server per granted snapshot. Only the caller's fixed tool is admissible.
export function mcpClient(stdin: Writable, registration: Registration, toolId: string, args: Readonly<Record<string,unknown>>,
  progress: (phase: McpPhase) => void) {
  const {identity, inputSchema, outputName} = registration.binding;
  let expected: string | number = 1;
  let buffer = '';
  let finished = false;
  let digest: string | undefined;
  function send(method: string, params: object, id?: string | number) {
    stdin.write(JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params }) + '\n');
  }
  function response(line: string) {
    const msg: unknown = JSON.parse(line);
    if (finished || !record(msg) || msg.jsonrpc !== '2.0' || msg.id !== expected || !record(msg.result) || 'error' in msg) {
      throw new Error('Unexpected MCP response from the built-in server.');
    }
    const result = msg.result;
    if (expected === 1) {
      if (result.protocolVersion !== identity.protocol || !record(result.capabilities) || !record(result.capabilities.tools)
        || !record(result.serverInfo) || result.serverInfo.name !== identity.server || result.serverInfo.version !== identity.version) {
        throw new Error('Incompatible built-in MCP server.');
      }
      send('notifications/initialized', {});
      expected = 2;
      progress('tools/list');
      send('tools/list', {}, expected);
    } else if (expected === 2) {
      const listed = Array.isArray(result.tools) && result.tools.length === 1 && result.tools[0];
      if (!record(listed) || listed.name !== identity.tool || !isDeepStrictEqual(listed.inputSchema, inputSchema)
        || result.nextCursor !== undefined) throw new Error('Unexpected MCP tool listing or input schema.');
      expected = toolId;
      progress('tools/call');
      send('tools/call', { name: identity.tool, arguments: args }, expected);
    } else {
      finished = true;
      stdin.end();
      if (!Array.isArray(result.content) || !result.content.every(v => record(v) && v.type === 'text' && typeof v.text === 'string')
        || (result.isError !== undefined && typeof result.isError !== 'boolean')) throw new Error('Malformed MCP tool response.');
      if (result.isError === true) {
        const detail = Array.isArray(result.content) && result.content.find(v => record(v) && v.type === 'text');
        throw new Error(typeof detail?.text === 'string' ? detail.text : 'MCP calculation failed.');
      }
      const receipt = result.structuredContent;
      if (!record(receipt) || receipt.filename !== outputName || typeof receipt.sha256 !== 'string'
        || !/^[0-9a-f]{64}$/.test(receipt.sha256)) throw new Error('Missing MCP output receipt.');
      digest = receipt.sha256;
    }
  }
  return {
    initialize() {
      send('initialize', { protocolVersion: identity.protocol, capabilities: {}, clientInfo: { name: 'Athena', version: '1.0.0' } }, 1);
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
