/** Athena additions to the verified Pi 1.5.2 bridge, not additional Pi RPC commands. */
export interface InputContract {
  /** Counts JavaScript UTF-16 code units (String.length), not tokens. Default: 262144. */
  maxMessageCharacters: number;
  lengthUnit: 'utf16-code-units';
  supportsFileReferences: boolean;
  canStageFiles: boolean;
  /** False when the host accepts prompts only while idle. */
  supportsStreamingPrompts?: boolean;
}

export interface FileReference {
  /** Opaque, host-issued identifier. A display filename or browser path is not an ID. */
  id: string;
  projectId: string | null;
  name: string;
  mimeType: string;
  size: number;
  versionId?: string;
}

/** Optional public message metadata, projected only from the owning host attempt. */
export interface MessageDisplayMetadata {
  /** Labels only: these records do not grant file access or expose local paths. */
  attachments?: readonly { name: string; mimeType: string; size: number }[];
}

export interface ImageContent {
  type: 'image';
  mimeType: string;
  data: string;
}

export interface FileService {
  /** Persist every supplied file or reject. Partial success must not be presented as complete. */
  stageFiles?(files: readonly File[], context: {
    projectId: string | null;
    sessionId: string | null;
  }): Promise<{ fileReferences: FileReference[] }>;
  /**
   * Validate ownership, project scope, versions, and existence before returning.
   * The host decides whether contextText names tool-readable stored files or
   * contains extracted text. PDF preview is not extraction. Unsupported formats
   * must reject; returning a filename alone does not confirm content ingestion.
   * The adapter appends contextText intact and rechecks the complete input limit.
   */
  resolveReferences(references: readonly FileReference[], context: {
    sessionId: string | null;
    command: 'prompt' | 'steer' | 'follow_up';
  }): Promise<{ resolvedIds: string[]; contextText: string; images?: ImageContent[] }>;
}

export interface PromptPayload {
  message: string;
  images?: ImageContent[];
  /** Only accepted when the connection explicitly advertises supportsFileReferences. */
  fileReferences?: FileReference[];
  streamingBehavior?: 'steer' | 'followUp';
}

export interface InputTooLargeError extends RangeError {
  code: 'INPUT_TOO_LARGE';
  limit: number;
  actual: number;
}

export interface PendingExtensionRequest {
  /** Actual host request ID, returned unchanged in extension_ui_response. */
  id: string;
  /** UI correlation key includes connection/session generation; use for respondUI. */
  requestKey: string;
  method: 'select' | 'confirm' | 'input' | 'editor';
  title?: string;
  message?: string;
  placeholder?: string;
  prefill?: string;
  options?: string[];
  timeout?: number;
  receivedAt: number;
  expired?: boolean;
  detached: boolean;
  responding: boolean;
  responseError: string | null;
  cancelReason?: 'session-changed' | 'disconnected';
}

export type ExtensionResponse = { cancelled: true } | { confirmed: boolean } | { value: string };

export interface RuntimeInputAndUIContract {
  getInputContract(): InputContract;
  /** Returns the original complete value; rejects instead of truncating. */
  validateMessage(message: string): string;
  stageFiles(files: File[], context: { projectId: string | null; sessionId: string | null }): Promise<{ fileReferences: FileReference[] }>;
  /** Full pending queue; the view may paginate but must not drop pending items. */
  getPendingUIRequests(): PendingExtensionRequest[];
  /** A failed send retains the request. Detached requests permit cancellation only. */
  respondUI(requestKey: string, response: ExtensionResponse): Promise<boolean>;
}

/**
 * Message completion contract:
 * - Preferred identity: message.id, message.messageId, or envelope.messageId.
 * - One message_start/turn boundary can contain a stream done/error and an outer
 *   message_end. They finalize one UI message, in either terminal-envelope order.
 * - With no IDs, only the companion terminal envelopes in the same boundary are
 *   paired. Two equal text bodies across message_start boundaries remain distinct.
 * - Host reconnection/replay should supply stable IDs, not content-hash identity.
 * - The host remains responsible for durable pending requests across process exit.
 *   This browser bridge retains requests in memory and forwards cancellation;
 *   it cannot manufacture an acknowledgement if the host is unreachable.
 */
export interface MessageIdentity {
  id?: string;
  messageId?: string;
}

/** Visible tool previews are bounded independently of backend execution records. */
export interface ToolPreviewMetadata {
  inputTruncated: boolean;
  /** Full serialized input size; null only when the input cannot be serialized. */
  inputCharacters: number | null;
  inputPreviewCharacters: number;
  outputTruncated: boolean;
  /** Full received output length; cumulative for append events. */
  outputCharacters: number;
  /** At most 65536 characters; the retained output is the tail. */
  outputPreviewCharacters: number;
}
