import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDesktopPlatform } from './desktop-platform.mjs';

const { platform, target } = resolveDesktopPlatform();
assert.equal(platform, 'darwin', 'DMG verification requires a native Mac build.');
assert.equal(process.argv.length, 2, 'Usage: node scripts/check-macos-dmg.mjs');

const root = fileURLToPath(new URL('..', import.meta.url));
const bundles = join(root, 'src-tauri', 'target', target, 'release', 'bundle');
const app = join(bundles, 'macos', 'Athena.app');
const name = `Athena-${target}.dmg`;
const artifact = join(bundles, 'dmg', name);
const run = (executable, args, timeout = 300_000) => execFileSync(executable, args, { cwd: root, stdio: 'inherit', timeout });
const image = (...args) => run('/usr/bin/hdiutil', args);

// desktop:build seals the app after Tauri finishes. Package that sealed copy.
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
// Tauri rejects an executable launched through a symlink, including /var.
const work = await mkdtemp(join(await realpath(tmpdir()), 'athena-dmg-'));
const payload = join(work, 'payload');
const mount = join(work, 'mount');
const installation = join(work, 'Installed Athena');
const candidate = join(work, name);
let mounted = false;
const failures = [];

try {
  await Promise.all([mkdir(payload), mkdir(mount), mkdir(installation)]);
  run('/usr/bin/ditto', [app, join(payload, 'Athena.app')]);
  const imageStarted = performance.now();
  console.log(`Creating read-only ${name}.`);
  // Keep package creation separate from installer and application checks.
  run('/usr/bin/hdiutil', ['create', '-srcfolder', payload, '-fs', 'HFS+', '-format', 'UDRO', '-volname', 'Athena', candidate], 600_000);
  console.log(`Created ${name} in ${((performance.now() - imageStarted) / 1000).toFixed(1)} seconds.`);
  image('verify', candidate);
  image('attach', '-readonly', '-nobrowse', '-mountpoint', mount, candidate);
  mounted = true;
  const installed = join(installation, 'Athena.app');
  run('/usr/bin/ditto', [join(mount, 'Athena.app'), installed]);
  run(process.execPath, ['scripts/check-desktop-bundle.mjs', '--verify-only', installed]);
  run(process.execPath, ['scripts/smoke-installed-desktop.mjs', installed]);
} catch (error) {
  failures.push(error);
}

try {
  if (mounted) {
    try { image('detach', mount); }
    catch { image('detach', '-force', mount); }
    mounted = false;
  }
  if (failures.length === 0) {
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(candidate)) digest.update(chunk);
    await mkdir(join(bundles, 'dmg'), { recursive: true });
    await copyFile(candidate, artifact);
    console.log(`Verified ${name}. SHA-256: ${digest.digest('hex')}`);
  }
} catch (error) {
  failures.push(error);
} finally {
  if (!mounted) {
    try { await rm(work, { recursive: true, force: true }); }
    catch (error) { failures.push(error); }
  }
}
if (failures.length) throw new AggregateError(failures, 'macOS DMG verification or cleanup failed.');
