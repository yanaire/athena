/** UI projection contract. All scheduling, retries and persistence belong to Athena TaskManager. */
export type ModelReference = { provider: string; modelId: string; thinkingLevel?: string | null };
export type VersionRef = { id: string; version: string };
export type Scope = { projectId: string; sessionId: string; runId?: string | null };
export type Status = 'ready' | 'queued' | 'running' | 'blocked' | 'paused' | 'succeeded' | 'failed' | 'cancelled';
export interface Project { id: string; name: string; defaultModel?: ModelReference | null }
export interface Session { id: string; projectId: string; title: string; model?: ModelReference | null }
export interface Task extends Scope { id: string; title: string; status: Status; dependencies: string[]; toolIds: string[]; artifactIds: string[]; role?: string; agentName?: string; progress?: number; total?: number }
export interface Agent extends Scope { id: string; taskId: string; name: string; role: string; status: Status; model?: ModelReference }
export interface Tool extends Scope { id: string; taskId?: string | null; name: string; sdkToolName: string; status: Status; command?: string; cwd?: string; args?: unknown; logs: { at: number; text: string }[]; exitCode?: number | null }
export interface Artifact extends Scope { id: string; version: string; taskId?: string; title: string; kind: string; status: string; documentId?: string; documentVersion?: string; text?: string; location?: { uri: string; label?: string }; review: { status: 'unreviewed' | 'in_review' | 'approved' | 'rejected'; version: string }; evidence: VersionRef[] }
export interface WorkspaceEvent extends Scope { id: string; type: string; at: number; summary: string; taskId?: string; agentId?: string; toolId?: string; artifactId?: string; artifactVersion?: string }
export interface Approval extends Scope { id: string; taskId?: string; status: 'pending' | 'approved' | 'rejected'; description: string; cwd?: string; scope: string; impact: string; command?: string }
export interface WorkspaceSnapshot {
  /** Monotonically increasing across this subscription, including session switches. */
  revision: number; projectId: string | null; sessionId: string | null;
  projects: Project[]; sessions: Session[];
  run: { id: string | null; status: Status; startedAt: number | null; elapsedMs: number; model: ModelReference | null };
  tasks: Task[]; agents: Agent[]; tools: Tool[]; artifacts: Artifact[]; events: WorkspaceEvent[]; approvals: Approval[];
}
export interface SessionActivation { sessionId: string; projectId?: string; title?: string; model?: ModelReference; connection?: unknown; snapshot?: WorkspaceSnapshot }
export interface AthenaTaskManager {
  capabilities: ('create_project' | 'create_session' | 'open_session' | 'set_project_model' | 'retry_task' | 'cancel_run' | 'decide_approval')[];
  getSnapshot(): WorkspaceSnapshot | Promise<WorkspaceSnapshot>;
  subscribe(listener: (snapshot: WorkspaceSnapshot) => void): () => void;
  createProject?(input: { name: string; defaultModel?: ModelReference | null }): Promise<{ project: Project; snapshot?: WorkspaceSnapshot }>;
  createSession?(input: { projectId: string | null; title: string; model?: ModelReference | null; configurationId?: string }): Promise<SessionActivation>;
  openSession?(sessionId: string): Promise<SessionActivation>;
  setProjectDefaultModel?(projectId: string, model: ModelReference | null): Promise<{ saved: true; snapshot: WorkspaceSnapshot }>;
  retryTask?(taskId: string): Promise<unknown>;
  cancelRun?(runId: string): Promise<unknown>;
  decideApproval?(approvalId: string, decision: 'approved' | 'rejected'): Promise<unknown>;
}
