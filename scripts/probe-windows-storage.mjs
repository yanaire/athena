import { lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { realpath } from 'node:fs/promises';
import { hasPrivatePermissions, setWindowsPrivate } from '../runtime/private-storage.ts';
import { AnalysisFiles } from '../runtime/analysis-files.ts';
const root = mkdtempSync(join(tmpdir(), 'athena-storage-probe-'));
const files = new AnalysisFiles(root);
const scope = { projectId: 'probe', sessionId: 'probe', taskId: 'probe' };
function describe(error, depth = 0) {
  if (!error || depth > 3) return;
  console.log(JSON.stringify({ depth, name: error.name, code: error.code,
    message: String(error.message).slice(0, 300),
    stack: String(error.stack).split('\n').slice(0, 5),
    stderr: error.stderr ? String(error.stderr).slice(0, 3000) : undefined }));
  if (error.cause) describe(error.cause, depth + 1);
}
function paths(directory, depth = 0) {
  if (depth > 3) return;
  const info = lstatSync(directory);
  const canonical = realpathSync(directory);
  console.log(JSON.stringify({ path: directory, canonical, same: directory === canonical,
    directory: info.isDirectory(), link: info.isSymbolicLink(), mode: info.mode.toString(8) }));
  if (info.isDirectory()) for (const entry of readdirSync(directory, { withFileTypes: true }))
    paths(join(directory, entry.name), depth + 1);
}
try {
  console.log(JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version, root, canonical: realpathSync(root), native: realpathSync.native(root), asyncCanonical: await realpath(root) }));
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { await files.write(scope, 'calc.py', 'print(1)'); console.log('WRITE OK attempt=' + attempt); }
    catch (error) { console.log('WRITE FAILED attempt=' + attempt); describe(error); }
    paths(root);
  }
  try {
    const target = join(realpathSync(root), 'fresh', 'inner');
    const created = mkdirSync(target, { recursive: true, mode: 0o700 });
    console.log(JSON.stringify({ created, target, absolute: resolve(target), relative: created ? relative(created, resolve(target)) : null }));
    if (created) {
      setWindowsPrivate(created);
      let next = created;
      for (const part of relative(created, resolve(target)).split(sep).filter(Boolean)) {
        next = join(next, part); setWindowsPrivate(next);
      }
    }
    console.log(JSON.stringify({ private: hasPrivatePermissions(target, lstatSync(target)), canonical: realpathSync(target), target }));
  } catch (error) { describe(error); }
} finally { rmSync(root, { recursive: true, force: true }); }
