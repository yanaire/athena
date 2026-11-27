import { Type } from 'typebox';
import { Check } from 'typebox/value';
import { hash, ManagerError, object } from './orchestration.ts';

export const RESEARCH_BOARD = 'athena.research.get_research_board';
export const READ_ARTIFACT = 'athena.artifacts.read_file';
const closed = { additionalProperties: false } as const;
const identifier = Type.String({ minLength: 1, maxLength: 256 });
const digest = Type.String({ pattern: '^[a-f0-9]{64}$', minLength: 64, maxLength: 64 });
const version = Type.Integer({ minimum: 1, maximum: 2147483647 });
const identity = { id: identifier, version, hash: digest };
export const contractPin = Type.Object(identity, closed);
export const readCall = Type.Object({ ...identity, args: Type.Record(Type.String(), Type.Unknown()) }, closed);
export const discoveryInput = Type.Object({ id: Type.Optional(identifier), query: Type.Optional(Type.String({ maxLength: 120 })) }, closed);
export const codeInput = Type.Object({
  source: Type.String({ minLength: 1, maxLength: 16_384 }),
  tools: Type.Array(contractPin, { minItems: 1, maxItems: 2 }),
}, closed);
export type ContractPin = { id: string; version: number; hash: string };
export type ReadCall = ContractPin & { args: Readonly<Record<string, unknown>> };

const source = Type.Object({
  id: identifier, title: Type.String(), name: Type.String(), version: identifier,
  versionId: identifier, sha256: digest, bytes: Type.Integer({ minimum: 0 }),
  mimeType: Type.String(), uri: Type.String(),
}, closed);

function contract(definition: {
  id: string; name: string; description: string; version: number;
  inputSchema: object; outputSchema: object;
}) {
  return Object.freeze({ ...definition, hash: hash(JSON.stringify(definition)) });
}

// These IDs are host-owned. The registry never imports an external MCP catalog.
const registry = new Map([
  [RESEARCH_BOARD, contract({
    id: RESEARCH_BOARD, name: 'get_research_board', version: 1,
    description: 'List missions and granted result evidence for this run, optionally for one exact mission ID.',
    inputSchema: Type.Object({ missionId: Type.Optional(identifier) }, closed),
    outputSchema: Type.Object({
      missions: Type.Array(Type.Object({ id: identifier, objective: Type.String() }, closed)),
      evidence: Type.Array(Type.Object({
        id: identifier, missionId: identifier, title: Type.String(), artifacts: Type.Array(source),
      }, closed)),
    }, closed),
  })],
  [READ_ARTIFACT, contract({
    id: READ_ARTIFACT, name: 'read_file', version: 1,
    description: 'Read the verified UTF-8 contents of a published result owned by or explicitly granted to this worker.',
    inputSchema: Type.Object({ artifactId: identifier }, closed),
    outputSchema: Type.Object({ artifact: source, content: Type.String() }, closed),
  })],
]);

export function describeReadTools(args: unknown, allowed: (id: string) => boolean) {
  if (!Check(discoveryInput, args) || (args.id !== undefined && args.query !== undefined))
    throw new ManagerError('INVALID_INPUT', 'Supply an exact read tool ID or a search query.');
  if (args.id !== undefined) {
    const entry = registry.get(args.id);
    if (!entry || !allowed(entry.id)) throw new ManagerError('TOOL_UNAVAILABLE', 'This read tool is unavailable to the current task.');
    return entry;
  }
  const query = args.query?.trim().toLowerCase();
  return { tools: [...registry.values()].filter(entry => allowed(entry.id)
    && (!query || [entry.id, entry.description].some(value => value.toLowerCase().includes(query))))
    .map(({ id, name, version, hash, description }) => ({ id, name, version, hash, description })) };
}

export function readIdentity(value: unknown): ContractPin | undefined {
  if (!object(value)) return;
  const candidate = { id: value.id, version: value.version, hash: value.hash };
  return Check(contractPin, candidate) ? candidate : undefined;
}

export function checkReadPin(pin: ContractPin, allowed: (id: string) => boolean) {
  const entry = registry.get(pin.id);
  if (!entry || !allowed(entry.id)) throw new ManagerError('TOOL_UNAVAILABLE', 'This read tool is unavailable to the current task.');
  if (pin.version !== entry.version || pin.hash !== entry.hash)
    throw new ManagerError('CONTRACT_CHANGED', 'Read tool contract changed. Discover its current contract before retrying.');
  return entry;
}

export function checkReadCall(raw: unknown, allowed: (id: string) => boolean): ReadCall {
  if (!Check(readCall, raw)) throw new ManagerError('INVALID_INPUT', 'Supply a read tool ID, version, hash and JSON object arguments.');
  const contract = checkReadPin(raw, allowed);
  if (!Check(contract.inputSchema, raw.args)) throw new ManagerError('INVALID_INPUT', 'Arguments do not match the selected read tool contract.');
  return raw;
}
