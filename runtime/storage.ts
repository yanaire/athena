import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Project, Session, Scope } from '../athena-backend-handoff/athena-codex-ui/integrations/task-manager.d.ts';

export type StoredSession = Session & { readonly sessionFile: string; readonly sessionDir: string };
export type RecordKind = 'run' | 'task' | 'agent' | 'tool' | 'event' | 'pi_event' | 'file';
export type Receipt = {
  readonly sessionId: string;
  readonly requestId: string;
  readonly fingerprint: string;
  readonly state: 'accepted' | 'completed' | 'failed' | 'interrupted';
  readonly response: unknown;
};

/** All JSON is written by this class's typed callers, never accepted from the network. */
function decode<T>(value: unknown): T {
  if (typeof value !== 'string') throw new TypeError('Invalid persisted JSON column.');
  const decoded: T = JSON.parse(value);
  return decoded;
}

export class Storage {
  readonly #db: DatabaseSync;

  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(join(directory, 'workspace.sqlite'));
    this.#db.exec(`
      PRAGMA foreign_keys=ON;
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, body TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
        body TEXT NOT NULL, UNIQUE(id, project_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS records (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL, id TEXT NOT NULL, project_id TEXT NOT NULL,
        session_id TEXT NOT NULL, run_id TEXT, body TEXT NOT NULL,
        UNIQUE(kind,id),
        FOREIGN KEY(session_id,project_id) REFERENCES sessions(id,project_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS records_scope ON records(session_id,kind,sequence);
      CREATE TABLE IF NOT EXISTS receipts (
        session_id TEXT NOT NULL REFERENCES sessions(id), request_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL, state TEXT NOT NULL, response TEXT NOT NULL,
        PRIMARY KEY(session_id,request_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;
      INSERT OR IGNORE INTO metadata VALUES('revision','0');
    `);
  }

  transaction<T>(action: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  projects(): Project[] {
    return this.#db.prepare('SELECT body FROM projects ORDER BY rowid').all().map(row => decode<Project>(row.body));
  }

  project(id: string): Project | undefined {
    const row = this.#db.prepare('SELECT body FROM projects WHERE id=?').get(id);
    return row ? decode<Project>(row.body) : undefined;
  }

  putProject(project: Project): void {
    this.#db.prepare('INSERT INTO projects VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body')
      .run(project.id, JSON.stringify(project));
  }

  sessions(): StoredSession[] {
    return this.#db.prepare('SELECT body FROM sessions ORDER BY rowid').all().map(row => decode<StoredSession>(row.body));
  }

  session(id: string): StoredSession | undefined {
    const row = this.#db.prepare('SELECT body FROM sessions WHERE id=?').get(id);
    return row ? decode<StoredSession>(row.body) : undefined;
  }

  putSession(session: StoredSession): void {
    this.#db.prepare('INSERT INTO sessions VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body')
      .run(session.id, session.projectId, JSON.stringify(session));
  }

  records<T>(kind: RecordKind, sessionId: string): T[] {
    return this.#db.prepare('SELECT body FROM records WHERE kind=? AND session_id=? ORDER BY sequence')
      .all(kind, sessionId).map(row => decode<T>(row.body));
  }

  record<T>(kind: RecordKind, id: string): T | undefined {
    const row = this.#db.prepare('SELECT body FROM records WHERE kind=? AND id=?').get(kind, id);
    return row ? decode<T>(row.body) : undefined;
  }

  putRecord<T extends Scope & { readonly id: string }>(kind: RecordKind, value: T): void {
    // Scope cannot be changed by an upsert, even if a caller accidentally reuses an ID.
    const result = this.#db.prepare(`INSERT INTO records(kind,id,project_id,session_id,run_id,body) VALUES(?,?,?,?,?,?)
      ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body
      WHERE records.project_id=excluded.project_id AND records.session_id=excluded.session_id
        AND records.run_id IS excluded.run_id`)
      .run(kind, value.id, value.projectId, value.sessionId, value.runId ?? null, JSON.stringify(value));
    if (result.changes !== 1) throw new TypeError('An existing record cannot change scope.');
  }

  get<T>(key: string): T | undefined {
    const row = this.#db.prepare('SELECT body FROM metadata WHERE key=?').get(key);
    return row ? decode<T>(row.body) : undefined;
  }

  set(key: string, value: unknown): void {
    this.#db.prepare('INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body')
      .run(key, JSON.stringify(value));
  }

  revision(): number { return this.get<number>('revision') ?? 0; }

  advanceRevision(): number {
    const revision = this.revision() + 1;
    if (!Number.isSafeInteger(revision)) throw new RangeError('Snapshot revision exhausted.');
    this.set('revision', revision);
    return revision;
  }

  receipt(sessionId: string, requestId: string): Receipt | undefined {
    const row = this.#db.prepare('SELECT * FROM receipts WHERE session_id=? AND request_id=?').get(sessionId, requestId);
    return row ? decode<Receipt>(row.response) : undefined;
  }

  putReceipt(receipt: Receipt): void {
    this.#db.prepare(`INSERT INTO receipts VALUES(?,?,?,?,?) ON CONFLICT(session_id,request_id)
      DO UPDATE SET state=excluded.state,response=excluded.response`)
      .run(receipt.sessionId, receipt.requestId, receipt.fingerprint, receipt.state, JSON.stringify(receipt));
  }

  pendingReceipts(): Receipt[] {
    return this.#db.prepare("SELECT response FROM receipts WHERE state='accepted'").all()
      .map(row => decode<Receipt>(row.response));
  }

  close(): void { this.#db.close(); }
}
