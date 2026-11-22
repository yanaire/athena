/** Optional host-owned persistence/extraction contract. No backend or transport is implemented by the UI. */
export type ProjectId = string;
export type DocumentId = string;
export type VersionId = string;
export type ReviewStatus = 'unreviewed' | 'in_review' | 'approved' | 'changes_requested';
export interface SourceLocation { uri: string; label?: string; page?: number; line?: number; }
export interface Review { status: ReviewStatus; version: VersionId; reviewerId?: string; reviewedAt?: string; notes?: string; }
export interface EvidenceRef { sourceId: string; version: VersionId; location?: SourceLocation; }
export interface DocumentVersion {
  projectId: ProjectId; documentId: DocumentId; version: VersionId; title: string; text: string;
  evidence: EvidenceRef[]; review?: Review; baseVersion?: VersionId | null;
  originalLocation?: SourceLocation; createdAt?: string; persistence?: 'host' | 'session'; originalSample?: boolean;
}
export interface PDFArtifact {
  projectId: ProjectId; documentId: DocumentId; version: VersionId; artifactId: string;
  mediaType: 'application/pdf'; location: SourceLocation; sizeBytes?: number; digest?: string;
}
export type ExtractionState = 'not_requested' | 'queued' | 'extracting' | 'ready' | 'failed' | 'unsupported';
export interface KnowledgeSource {
  projectId: ProjectId; sourceId: string; version: VersionId; title: string;
  kind: 'documents' | 'notes' | 'datasets'; format: string; size?: number; text?: string;
  originalLocation: SourceLocation; persistence: 'host';
  extraction: { status: ExtractionState; version: VersionId; extractor?: string; error?: string; };
  review: Review; createdAt?: string;
}
export type ResearchRecordEvent =
  | { type: 'document.saved'; projectId: ProjectId; document: DocumentVersion }
  | { type: 'document.reviewed'; projectId: ProjectId; documentId: DocumentId; version: VersionId; review: Review }
  | { type: 'source.updated'; projectId: ProjectId; source: KnowledgeSource };
export interface ResearchRecordService {
  capabilities?: Array<'getDocument' | 'saveDocument' | 'exportPDF' | 'listSources' | 'storeSource' | 'extractSource'>;
  subscribe?(listener: (event: ResearchRecordEvent) => void): (() => void) | void;
  getDocument?(request: { projectId: ProjectId; documentId: DocumentId; version?: VersionId }): Promise<DocumentVersion>;
  /** Must preserve previous text/evidence versions; enforce expectedCurrentVersion atomically. */
  saveDocument?(request: DocumentVersion & { expectedCurrentVersion: VersionId | null }): Promise<DocumentVersion>;
  /** Export exactly the requested version; the authored sample PDF is a separate reference artifact. */
  exportPDF?(request: Pick<DocumentVersion, 'projectId' | 'documentId' | 'version' | 'text' | 'evidence'>): Promise<PDFArtifact>;
  listSources?(request: { projectId: ProjectId }): Promise<{ sources: KnowledgeSource[] }>;
  /** Original bytes are handed over explicitly; receipt must contain a durable URI and exact source version. */
  storeSource?(request: { projectId: ProjectId; sourceId: string; version: VersionId; title: string; kind: KnowledgeSource['kind']; format: string; file?: File; text?: string }): Promise<KnowledgeSource>;
  /** Native PDF preview is not extraction. Status becomes ready only from this service or its events. */
  extractSource?(request: { projectId: ProjectId; sourceId: string; version: VersionId; originalLocation: SourceLocation }): Promise<KnowledgeSource>;
}
export interface LocalDocumentRecord {
  projectId: ProjectId; documentId: DocumentId; title: string; currentVersion: VersionId; selectedVersion: VersionId;
  versions: Array<Omit<DocumentVersion, 'projectId' | 'documentId'>>;
  draft: { text: string; baseVersion: VersionId; dirty: boolean }; error: string | null; exports: PDFArtifact[];
}
