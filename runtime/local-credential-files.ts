import { randomUUID } from 'node:crypto';
import { closeSync, constants, openSync } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { CredentialVaultError } from './provider-credentials.ts';

const MAX_BYTES = 4 * 1024 * 1024;
const NO_FOLLOW = constants.O_NOFOLLOW | constants.O_NONBLOCK;
const TEMPORARY = /^\.credentials\.v2\.[a-f0-9-]{36}\.tmp$/u;

export function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export function invalidLocalStore(): CredentialVaultError {
  return new CredentialVaultError('VAULT_INVALID', 'The local credential store is unreadable, damaged, or has unsafe ownership or permissions. It was not reset.');
}

export function localWriteFailed(): CredentialVaultError {
  return new CredentialVaultError('VAULT_WRITE_FAILED', 'Athena could not save the local credential store.');
}

export async function requirePrivateDirectory(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o7777) !== 0o700) throw invalidLocalStore();
  } catch (error) {
    if (error instanceof CredentialVaultError) throw error;
    throw invalidLocalStore();
  }
}

export async function prepareCredentialDirectory(path: string): Promise<string> {
  const directory = resolve(path);
  // Walk existing components without following links. Callers canonicalize the home
  // directory first so macOS aliases such as /var are not mistaken for app directories.
  const root = sep;
  const parts = directory.slice(root.length).split(sep);
  let current: string = root;
  for (const part of parts) {
    current = join(current, part);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw localWriteFailed();
    }
    try { if (!(await lstat(current)).isDirectory()) throw invalidLocalStore(); }
    catch { throw invalidLocalStore(); }
  }
  await requirePrivateDirectory(directory);
  return directory;
}

export async function readPrivateCredentialFile(path: string, mode: 'text' | 'probe'): Promise<string | undefined> {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | NO_FOLLOW); }
  catch (error) { if (isMissing(error)) return undefined; throw invalidLocalStore(); }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1
      || (info.mode & 0o7777) !== 0o600 || info.size > MAX_BYTES) throw invalidLocalStore();
    return mode === 'text' ? await handle.readFile('utf8') : '';
  } catch { throw invalidLocalStore(); }
  finally { await handle.close(); }
}

export async function ensureCredentialLockFile(path: string): Promise<void> {
  try {
    // Do not open/close an existing SQLite lock inode through a separate FD:
    // POSIX would release this process's advisory locks on that inode.
    closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | NO_FOLLOW, 0o600));
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw localWriteFailed();
  }
  await requireCredentialLockFile(path);
}

export async function requireCredentialLockFile(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1
      || (info.mode & 0o7777) !== 0o600 || info.size !== 0) throw invalidLocalStore();
  } catch { throw invalidLocalStore(); }
}

export async function clearAbandonedCredentialWrites(directory: string): Promise<void> {
  for (const name of await readdir(directory)) {
    if (!TEMPORARY.test(name)) continue;
    const path = join(directory, name);
    if (await readPrivateCredentialFile(path, 'probe') !== undefined) await unlink(path);
  }
}

export async function writePrivateCredentialFile(path: string, text: string): Promise<void> {
  if (Buffer.byteLength(text) > MAX_BYTES) throw localWriteFailed();
  const directory = dirname(path);
  const temporary = join(directory, `.credentials.v2.${randomUUID()}.tmp`);
  try {
    await requirePrivateDirectory(directory);
    await readPrivateCredentialFile(path, 'probe');
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NO_FOLLOW, 0o600);
    try { await handle.writeFile(text, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, path);
    const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | NO_FOLLOW);
    try { await parent.sync(); } finally { await parent.close(); }
  } catch (error) {
    if (error instanceof CredentialVaultError) throw error;
    throw localWriteFailed();
  } finally {
    await unlink(temporary).catch((error: unknown) => { if (!isMissing(error)) throw localWriteFailed(); });
  }
}
