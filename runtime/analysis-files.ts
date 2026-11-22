import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';

export type AnalysisScope = { readonly projectId: string; readonly sessionId: string; readonly taskId: string };
type Attempt = AnalysisScope & { readonly attemptId: string };
export type AnalysisSnapshot = { readonly name: string; readonly bytes: Uint8Array };
export type AnalysisArtifact = Attempt & {
  readonly kind: 'analysis'; readonly id: string; readonly versionId: string; readonly name: string;
  readonly mimeType: string; readonly bytes: number; readonly sha256: string;
};

export const ANALYSIS_FILE_LIMITS = Object.freeze({ fileBytes: 1024 * 1024, batchFiles: 8, workspaceFiles: 32 });
const MIME = new Map([
  ['.csv', 'text/csv'], ['.json', 'application/json'], ['.md', 'text/markdown'],
  ...['.txt', '.py', '.js', '.mjs', '.cjs', '.ts'].map((ext): [string, string] => [ext, 'text/plain']),
]);
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class AnalysisFileError extends Error {
  readonly code = 'ANALYSIS_FILE_DENIED';
}

type CommandFilename = { readonly field: string; readonly mount: '/workspace/' | '/outputs/' };

const isAnalysisName = (name: string) => typeof name === 'string' && name.length <= 96 &&
  /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name) && !name.includes('..') && MIME.has(extname(name).toLowerCase());

export function validateAnalysisName(name: string, hint?: CommandFilename): string {
  if (!isAnalysisName(name)) {
    if (hint) {
      const candidate = name.startsWith(hint.mount) ? name.slice(hint.mount.length) : '';
      const correction = isAnalysisName(candidate) ? ` Use ${JSON.stringify(candidate)} in the tool arguments.` : '';
      throw new AnalysisFileError(`run_command.${hint.field} must be a basename with a supported extension, without a directory.${correction} The ${hint.mount} prefix belongs only in the script.`);
    }
    throw new AnalysisFileError('Expected a plain analysis filename with a supported extension.');
  }
  return name;
}

export function validateOutputNames(names: readonly string[], fromCommand = false): readonly string[] {
  if (!Array.isArray(names) || names.length > ANALYSIS_FILE_LIMITS.batchFiles) throw new AnalysisFileError('File list exceeds limit.');
  const copy = Array.from(names, (name, index) => validateAnalysisName(name, fromCommand ? { field: `outputs[${index}]`, mount: '/outputs/' } : undefined));
  if (new Set(copy.map(n => n.toLowerCase())).size !== copy.length) throw new AnalysisFileError('Duplicate file name.');
  return Object.freeze(copy);
}

function text(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > ANALYSIS_FILE_LIMITS.fileBytes || bytes.includes(0)) {
    throw new AnalysisFileError('Expected bounded UTF-8 text without NUL.');
  }
  try { return decoder.decode(bytes); }
  catch (cause) { throw new AnalysisFileError('Invalid UTF-8.', { cause }); }
}

function copy(bytes: Uint8Array): Buffer {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > ANALYSIS_FILE_LIMITS.fileBytes) throw new AnalysisFileError('File exceeds byte limit.');
  const owned = Buffer.from(bytes);
  text(owned);
  return owned;
}

function scopeKey(...ids: readonly string[]): string {
  if (ids.some(id => typeof id !== 'string' || !id.trim() || id.includes('\0') || Buffer.byteLength(id) > 256)) {
    throw new AnalysisFileError('Invalid file scope.');
  }
  return digest(JSON.stringify(ids));
}

// The manager owns dataDir and its ancestors. No paths from this store enter a guest.
function privateDir(parent: string, child: string): string {
  const path = join(parent, child);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const st = lstatSync(path);
  if (!st.isDirectory() || st.uid !== process.getuid?.() || (st.mode & 0o077) || realpathSync(path) !== path) {
    throw new AnalysisFileError('Expected a private host-owned storage directory.');
  }
  return path;
}

function inspect(path: string) {
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (st && (!st.isFile() || st.nlink !== 1 || st.size > ANALYSIS_FILE_LIMITS.fileBytes || st.uid !== process.getuid?.() || (st.mode & 0o077))) {
    throw new AnalysisFileError('Invalid analysis file.');
  }
  return st;
}

function readBytes(path: string): Buffer {
  const expected = inspect(path);
  if (!expected) throw new AnalysisFileError('Analysis file does not exist.');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (st.dev !== expected.dev || st.ino !== expected.ino || st.size !== expected.size || st.nlink !== 1) {
      throw new AnalysisFileError('File changed while opening.');
    }
    const bytes = Buffer.allocUnsafe(st.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, size);
      if (!count) break;
      size += count;
    }
    if (size !== st.size) throw new AnalysisFileError('File changed while reading.');
    return bytes.subarray(0, size);
  } finally { closeSync(fd); }
}

function replace(path: string, bytes: Uint8Array | string, mode: number): void {
  const temp = join(path, '..', '.' + randomUUID());
  try {
    writeFileSync(temp, bytes, { flag: 'wx', mode, flush: true });
    renameSync(temp, path);
  } catch (error) {
    if (lstatSync(temp, { throwIfNoEntry: false })) unlinkSync(temp);
    throw error;
  }
}

// Published names point directly to immutable blobs. One rename makes a whole
// batch visible. Local edits shadow an earlier publication only at index commit.
function published(dir: string): Map<string, string> {
  const path = join(dir, '.published');
  const st = inspect(path);
  if (!st) return new Map();
  if ((st.mode & 0o7777) !== 0o600 || st.size > 16 * 1024) throw new AnalysisFileError('Invalid workspace index.');
  const body: unknown = JSON.parse(text(readBytes(path)));
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AnalysisFileError('Invalid workspace index.');
  const results = new Map<string, string>();
  for (const [name, ref] of Object.entries(body)) {
    if (validateAnalysisName(name) !== name.toLowerCase() || typeof ref !== 'string' || !/^[a-f0-9]{128}$/.test(ref)
      || results.size >= ANALYSIS_FILE_LIMITS.workspaceFiles) throw new AnalysisFileError('Invalid workspace index entry.');
    results.set(name, ref);
  }
  return results;
}

function checkQuota(dir: string, index: Map<string, string>, added: readonly string[]): void {
  const existing = readdirSync(dir).filter(n => n !== '.published').map(n => n.replace(/^\.grant-/, ''));
  if (new Set([...existing, ...index.keys(), ...added.map(n => n.toLowerCase())]).size > ANALYSIS_FILE_LIMITS.workspaceFiles) {
    throw new AnalysisFileError('Workspace file count exceeds limit.');
  }
}

/** Host-only bounded storage. Manager supplies authorized scope and persists provenance. */
export class AnalysisFiles {
  readonly #dataDir: string;
  constructor(dataDir: string) { this.#dataDir = resolve(dataDir); }

  #workspace(scope: AnalysisScope): string {
    const key = scopeKey(scope.projectId, scope.sessionId, scope.taskId);
    if (!lstatSync(this.#dataDir).isDirectory()) throw new AnalysisFileError('Invalid host data directory.');
    return privateDir(privateDir(realpathSync(this.#dataDir), 'analysis-files'), key);
  }

  #files(scope: AnalysisScope): string { return privateDir(this.#workspace(scope), 'files'); }

  #entry(dir: string, name: string, index = published(dir)) {
    const key = validateAnalysisName(name).toLowerCase();
    const grantPath = join(dir, '.grant-' + key);
    const workPath = join(dir, key);
    const grant = inspect(grantPath);
    const work = inspect(workPath);
    if ((grant && ((grant.mode & 0o7777) !== 0o400 || work)) || (work && (work.mode & 0o7777) !== 0o600)) {
      throw new AnalysisFileError('Invalid workspace entry permissions or conflicting grant.');
    }
    const ref = index.get(key);
    if (ref && grant) throw new AnalysisFileError('Invalid workspace grant collision.');
    const path = ref ? join(privateDir(join(dir, '..'), 'versions'), ref.slice(0, 64)) : grant ? grantPath : workPath;
    if (ref && ((inspect(path)?.mode ?? 0) & 0o7777) !== 0o400) throw new AnalysisFileError('Invalid published file.');
    return { grant, work, grantPath, workPath, path, ref };
  }

  #store(scope: AnalysisScope, file: AnalysisSnapshot, mutable: boolean): void {
    const bytes = copy(file.bytes);
    const dir = this.#files(scope);
    const index = published(dir);
    const entry = this.#entry(dir, file.name, index);
    if (entry.grant || entry.work || entry.ref) {
      if (entry.grant && !mutable && bytes.equals(readBytes(entry.path))) return;
      if (entry.grant || !mutable) throw new AnalysisFileError('Conflicting read-only input grant.');
    }
    checkQuota(dir, index, [file.name]);
    replace(mutable ? entry.workPath : entry.grantPath, bytes, mutable ? 0o600 : 0o400);
    if (index.delete(file.name.toLowerCase())) replace(join(dir, '.published'), JSON.stringify(Object.fromEntries(index)), 0o600);
  }

  async grant(scope: AnalysisScope, file: AnalysisSnapshot): Promise<void> { this.#store(scope, file, false); }

  async write(scope: AnalysisScope, name: string, content: string): Promise<void> {
    if (typeof content !== 'string' || Buffer.byteLength(content) > ANALYSIS_FILE_LIMITS.fileBytes || !content.isWellFormed()) {
      throw new AnalysisFileError('Expected bounded Unicode text.');
    }
    this.#store(scope, { name, bytes: Buffer.from(content) }, true);
  }

  async read(scope: AnalysisScope, name: string): Promise<string> {
    return text(this.#bytes(this.#files(scope), name));
  }

  async has(scope: AnalysisScope, name: string): Promise<boolean> {
    const { grant, work, ref } = this.#entry(this.#files(scope), name);
    return Boolean(grant || work || ref);
  }

  #bytes(dir: string, name: string): Buffer {
    const { path, ref } = this.#entry(dir, name);
    const bytes = readBytes(path);
    if (ref && digest(bytes) !== ref.slice(64)) throw new AnalysisFileError('Published file failed verification.');
    return bytes;
  }

  async snapshot(scope: AnalysisScope, names: readonly string[]): Promise<AnalysisSnapshot[]> {
    const selected = validateOutputNames(names);
    const dir = this.#files(scope);
    return selected.map(name => {
      const bytes = this.#bytes(dir, name);
      text(bytes);
      return { name, bytes };
    });
  }

  // The key commits to every receipt field. No mutable manifest or user-controlled
  // filename is consulted on download; an altered receipt addresses no such file.
  #versionPath(file: AnalysisArtifact): string {
    const dir = privateDir(this.#workspace(file), 'versions');
    const key = digest(JSON.stringify([file.attemptId, file.id, file.versionId, file.name, file.mimeType, file.bytes, file.sha256]));
    return join(dir, key);
  }

  /** Runner passes only regular-file snapshots collected from a stopped guest. */
  async publish(attempt: Attempt, declared: readonly string[], produced: readonly AnalysisSnapshot[], script?: AnalysisSnapshot): Promise<AnalysisArtifact[]> {
    const names = validateOutputNames(declared);
    if (!Array.isArray(produced) || produced.length !== names.length) throw new AnalysisFileError('Expected exactly the declared outputs.');
    scopeKey(attempt.attemptId);
    const dir = this.#files(attempt);
    const index = published(dir);
    checkQuota(dir, index, names);
    if (script && names.some(n => n.toLowerCase() === validateAnalysisName(script.name).toLowerCase())) {
      throw new AnalysisFileError('Executed script cannot also be an output.');
    }
    const outputs = names.map(name => {
      if (this.#entry(dir, name, index).grant) throw new AnalysisFileError('An input grant cannot be an output.');
      const result = produced.find(file => file.name === name);
      if (!result) throw new AnalysisFileError('Missing declared output.');
      return result;
    });
    const versions = (script ? [script, ...outputs] : outputs).map(source => {
      const name = validateAnalysisName(source.name);
      const bytes = copy(source.bytes);
      if (extname(name).toLowerCase() === '.json') {
        try { JSON.parse(decoder.decode(bytes).replace(/^\uFEFF/u, '')); }
        catch (cause) {
          if (!(cause instanceof SyntaxError)) throw cause;
          throw new AnalysisFileError(`${name} is not valid JSON. In Python, write JSON with json.dump instead of str(dict).`, { cause });
        }
      }
      const file: AnalysisArtifact = Object.freeze({ kind: 'analysis', projectId: attempt.projectId, sessionId: attempt.sessionId,
        taskId: attempt.taskId, attemptId: attempt.attemptId, id: randomUUID(), versionId: randomUUID(), name,
        mimeType: MIME.get(extname(name).toLowerCase()) ?? 'text/plain', bytes: bytes.length, sha256: digest(bytes) });
      return { file, bytes };
    });
    // All calls execute in the manager process, without yielding between loading
    // the current namespace and committing. Never replay the runner's input view.
    const created: string[] = [];
    try {
      for (const { file, bytes } of versions) {
        const path = this.#versionPath(file);
        replace(path, bytes, 0o400);
        created.push(path);
        if (file.name !== script?.name) index.set(file.name.toLowerCase(), basename(path) + file.sha256);
      }
      if (outputs.length) replace(join(dir, '.published'), JSON.stringify(Object.fromEntries(index)), 0o600);
    } catch (error) {
      const failures: unknown[] = [error];
      for (const path of created) {
        try { unlinkSync(path); }
        catch (cleanupError) { failures.push(cleanupError); }
      }
      if (failures.length > 1) throw new AggregateError(failures, 'Artifact publication and rollback failed.');
      throw error;
    }
    return versions.map(({ file }) => file);
  }

  /** Only call with a manager-authorized artifact record from durable storage. */
  async download(file: AnalysisArtifact): Promise<Buffer> {
    if (file.kind !== 'analysis' || !uuid.test(file.id) || !uuid.test(file.versionId) || !/^[a-f0-9]{64}$/.test(file.sha256)
      || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > ANALYSIS_FILE_LIMITS.fileBytes
      || MIME.get(extname(validateAnalysisName(file.name)).toLowerCase()) !== file.mimeType) throw new AnalysisFileError('Invalid artifact reference.');
    scopeKey(file.attemptId);
    const bytes = readBytes(this.#versionPath(file));
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) throw new AnalysisFileError('Artifact failed verification.');
    return bytes;
  }
}
