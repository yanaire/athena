import { lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, win32 } from 'node:path';
import { AnalysisFiles } from '../runtime/analysis-files.ts';
import { assertWindowsPrivate } from '../runtime/private-storage.ts';
const root = mkdtempSync(join(tmpdir(), 'athena-storage-probe-'));
const files = new AnalysisFiles(root);
const scope = { projectId: 'probe', sessionId: 'probe', taskId: 'probe' };
function describe(error, depth = 0) {
  if (!error || depth > 3) return;
  console.log(JSON.stringify({ depth, name: error.name, code: error.code, message: String(error.message).slice(0, 300),
    stack: String(error.stack).split('\n').slice(0, 5).map(line => line.slice(0, 220)),
    stderr: error.stderr ? String(error.stderr).slice(0, 3000) : undefined }));
  if (error.cause) describe(error.cause, depth + 1);
}
function inspectFiles(directory, depth = 0) {
  if (depth > 4) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const info = lstatSync(path);
    if (info.isDirectory() && !info.isSymbolicLink()) inspectFiles(path, depth + 1);
    else {
      console.log(JSON.stringify({ file: path, mode: info.mode.toString(8), nlink: info.nlink, size: info.size, dev: info.dev, ino: info.ino }));
      try { assertWindowsPrivate(path); console.log('FILE ACL OK'); }
      catch (error) { console.log('FILE ACL FAILED'); describe(error); }
    }
  }
}
try {
  console.log(JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version, root,
    canonical: realpathSync(root), native: realpathSync.native(root), asyncCanonical: await realpath(root) }));
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await files.write(scope, 'calc.py', 'print(1)');
      if (await files.read(scope, 'calc.py') !== 'print(1)') throw new Error('Stored content changed');
      console.log('WRITE AND READ OK attempt=' + attempt);
    } catch (error) { process.exitCode = 1; console.log('WRITE OR READ FAILED attempt=' + attempt); describe(error); }
  }
  inspectFiles(root);
  const target = join(realpathSync(root), 'fresh', 'inner');
  const created = mkdirSync(target, { recursive: true, mode: 0o700 });
  console.log(JSON.stringify({ created, target, unnormalized: relative(created, target),
    normalized: win32.relative(win32.toNamespacedPath(created), win32.toNamespacedPath(target)) }));
} finally { rmSync(root, { recursive: true, force: true }); }
