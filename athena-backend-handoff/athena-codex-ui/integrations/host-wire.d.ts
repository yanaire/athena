import type { WorkspaceSnapshot, SessionActivation, AthenaTaskManager } from './task-manager.d.ts';
import type { ConnectionSnapshot } from './connections.d.ts';
import type { FileReference, InputContract } from './pi-bridge-contracts.d.ts';

/** JSON only. The browser supplies subscribe/request methods after activation. */
export type WireSessionActivation = Omit<SessionActivation, 'connection'>;
export interface EventCursor { readonly epoch: string; readonly sequence: number }
export interface HostBootstrap {
  readonly snapshot: WorkspaceSnapshot;
  /** Absent only on legacy M1 hosts and fixtures. */
  readonly cursor?: EventCursor;
  readonly connection: ConnectionSnapshot;
  readonly capabilities: readonly AthenaTaskManager['capabilities'][number][];
  /** Includes stage_files only when the host can stage and resolve attachments. */
  readonly piCapabilities: readonly string[];
  readonly inputContract?: InputContract;
}
export interface StagedWireFile {
  readonly name: string;
  readonly mimeType: string;
  /** Base64 encoded bytes, without a data URL prefix. */
  readonly data: string;
}
export interface PiCommand {
  readonly type: string;
  readonly id?: string;
  readonly [parameter: string]: unknown;
}
export interface PiResponse {
  readonly type: 'response';
  readonly command: string;
  readonly id?: string;
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: string;
}
export type HostRpcRequest =
  | { readonly method: 'createProject'; readonly args: readonly [Parameters<NonNullable<AthenaTaskManager['createProject']>>[0]] }
  | { readonly method: 'createSession'; readonly args: readonly [Parameters<NonNullable<AthenaTaskManager['createSession']>>[0]] }
  | { readonly method: 'openSession'; readonly args: readonly [string] }
  | { readonly method: 'cancelRun' | 'cancelTask'; readonly args: readonly [string] }
  | { readonly method: 'getAgentHistory'; readonly args: readonly [conversationId: string, agentSessionId: string] }
  | { readonly method: 'setProjectDefaultModel'; readonly args: Parameters<NonNullable<AthenaTaskManager['setProjectDefaultModel']>> }
  | { readonly method: 'verifyConnection' | 'saveConfig'; readonly args: readonly [unknown] }
  | { readonly method: 'pi'; readonly args: readonly [string, PiCommand] }
  | { readonly method: 'stageFiles'; readonly args: readonly [string, readonly StagedWireFile[]] };
export type HostRpcResponse<T = unknown> = { readonly result: T } | { readonly error: string };
export type HostEvent =
  | { readonly type: 'snapshot'; readonly snapshot: WorkspaceSnapshot }
  | { readonly type: 'connection'; readonly connection: ConnectionSnapshot }
  | { readonly type: 'pi'; readonly sessionId: string; readonly event: Readonly<Record<string, unknown>> };
export type SequencedHostEvent = EventCursor & (HostEvent | { readonly type: 'reset' });
export interface StagedFilesResult { readonly fileReferences: readonly FileReference[] }
