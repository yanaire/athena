import { createHash } from 'node:crypto';
import { Type, type TObject } from 'typebox';
import { Check } from 'typebox/value';
import { csvBinding, rcBinding, maxRcSamples } from './mcp-contract.mjs';

export const MCP_LIMITS = Object.freeze({
  inputBytes: 1024 * 1024, artifactBytes: 64 * 1024, streamBytes: 16 * 1024,
  queue: 32, heapMiB: 64, maxConcurrency: 4, maxTimeoutMs: 30_000, killWaitMs: 1_000,
});
const fileId = Type.Optional(Type.String({minLength:1,maxLength:256,description:'Exact granted upload ID. Omit for the only granted upload.'}));
const closed = {additionalProperties:false};
interface Binding {
  readonly identity: {
    registryVersion: number; server: string; displayName: string; version: string;
    protocol: string; tool: string; alias: string; resultKind: string;
  };
  readonly worker: string;
  readonly inputName: string;
  readonly inputBytes: number;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputName: string;
  readonly outputBytes: number;
  readonly mimeType: 'application/json';
  validArgs(args: Readonly<Record<string, unknown>>): boolean;
}
export interface Registration {
  binding: Binding;
  role: 'child';
  description: string;
  parameters: TObject;
  acceptsFile(name: string): boolean;
  validResult(value: unknown): boolean;
  resultField: string;
  errorCode: string;
}
const object = (v:unknown): v is Record<string,unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v:unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const count = (v:unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
export const csvRegistration: Registration = {
  binding: csvBinding, role:'child', description:'Create statistics.json for the granted CSV. Optionally select an exact column.',
  parameters:Type.Object({fileId, column:Type.Optional(Type.String({minLength:1,maxLength:256}))},closed),
  acceptsFile: () => true, // Historical CSV grants use content, not a filename extension.
  validResult(v) {
    if (!object(v) || v.schemaVersion !== 1 || !count(v.rowCount) || !Array.isArray(v.columns)
      || !v.columns.every(c => typeof c === 'string') || !Array.isArray(v.statistics) || !v.statistics.length) return false;
    const {columns,rowCount} = v;
    return v.statistics.every(s => object(s) && typeof s.column === 'string' && columns.includes(s.column) && count(s.count) && count(s.missing)
      && count(s.nonNumeric) && s.count + s.missing + s.nonNumeric === rowCount
      && [s.min,s.mean,s.max].every(x => s.count === 0 ? x === null : finite(x)));
  },
  resultField:'statistics', errorCode:'CSV_FAILED',
};
export const rcRegistration: Registration = {
  binding:rcBinding, role:'child', description:'Calculate the ideal RC low-pass step response from the granted JSON. Publishes rc-response.json.',
  parameters:Type.Object({fileId},closed), acceptsFile:name => /\.json$/i.test(name),
  validResult(v) {
    return object(v) && v.schemaVersion === 1 && finite(v.timeConstantSeconds) && v.timeConstantSeconds > 0
      && finite(v.cutoffHz) && v.cutoffHz > 0 && Array.isArray(v.samples) && v.samples.length > 0 && v.samples.length <= maxRcSamples
      && v.samples.every(s => object(s) && finite(s.timeSeconds) && s.timeSeconds >= 0 && finite(s.outputVolt));
  },
  resultField:'response', errorCode:'MCP_FAILED',
};
export function registerBuiltins(entries: readonly Registration[]) {
  const aliases = new Map<string,Registration>();
  const servers = new Set<string>();
  const reserved = new Set(['read','read_file','write_file','run_command','spawn_agent','send_to_agent','wait_for_agents','get_task','list_tasks','cancel_task']);
  for (const entry of entries) {
    const {alias,server} = entry.binding.identity;
    if (reserved.has(alias) || aliases.has(alias) || servers.has(server)) throw new Error('Duplicate built-in MCP registration: ' + alias);
    const { worker, inputName, outputName, inputBytes, outputBytes } = entry.binding;
    if (![worker,inputName,outputName].every(name => /^[a-zA-Z0-9_-]+[.][a-zA-Z0-9]+$/.test(name))
      || new Set([inputName, outputName, 'artifact.json']).size !== 3
      || !Number.isSafeInteger(inputBytes) || inputBytes < 1 || inputBytes > MCP_LIMITS.inputBytes
      || !Number.isSafeInteger(outputBytes) || outputBytes < 1 || outputBytes > MCP_LIMITS.artifactBytes) {
      throw new Error('Invalid built-in MCP file binding: ' + alias);
    }
    aliases.set(alias,entry);
    servers.add(server);
  }
  return aliases as ReadonlyMap<string,Registration>;
}
export const builtins = registerBuiltins([csvRegistration,rcRegistration]);

export function bindCall(entry: Registration, args: Readonly<Record<string,unknown>>) {
  if (!Check(entry.parameters,args)) throw new Error('Invalid arguments for ' + entry.binding.identity.alias);
  const {fileId, ...wire} = args;
  if (!entry.binding.validArgs(wire)) throw new Error('Invalid arguments for ' + entry.binding.identity.alias);
  return {fileId, wire};
}

export function verifyMcpOutput(entry: Registration, content: Buffer, receiptDigest?: string) {
  const digest = createHash('sha256').update(content).digest('hex');
  if (content.length > entry.binding.outputBytes || digest !== receiptDigest) {
    throw new Error('MCP result does not match the stored output file.');
  }
  const result: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content));
  if (!entry.validResult(result)) throw new Error('Invalid result for ' + entry.binding.identity.alias);
  return digest;
}
