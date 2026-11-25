import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detachMacOSImage, macOSEjectTarget, macOSImageAttachment, MACOS_IMAGE_EJECT_ATTEMPTS, resolveDesktopPlatform } from './desktop-platform.mjs';

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
const mount = join(work, 'mount');
const installation = join(work, 'Installed Athena');
const volumeImage = join(work, 'Athena.sparseimage');
const candidate = join(work, name);
let attachedImage;
let ownedPartition;
let ejectAttemptsRemaining = 0;
let mountDevice;
const failures = [];

function attach(path, readOnly = false) {
  // Arm cleanup before the command in case it fails after attaching the volume.
  attachedImage = path;
  ejectAttemptsRemaining = MACOS_IMAGE_EJECT_ATTEMPTS;
  image('attach', readOnly ? '-readonly' : '-readwrite', '-nobrowse', '-noautoopen', '-mountpoint', mount, path);
  const attachment = readAttachment();
  assert.equal(attachment.state, 'mounted', 'Could not identify the newly mounted private disk image.');
  // Record the persistent media UUID before copying the app. On Intel CI, querying
  // Disk Arbitration just after the copy can stall while the volume is busy.
  const probeStarted = performance.now();
  const partition = readPlist('/usr/sbin/diskutil', ['info', '-plist', attachment.partition], 120_000);
  const current = readAttachment();
  assert.ok(current.state === 'mounted' && current.device === attachment.device && current.partition === attachment.partition
    && partition.BusProtocol === 'Disk Image' && partition.WholeDisk === false
    && partition.ParentWholeDisk === basename(current.device) && partition.DeviceNode === current.partition
    && typeof partition.DiskUUID === 'string' && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(partition.DiskUUID),
    'Could not verify the private disk image partition UUID.');
  ownedPartition = { device: current.device, partition: current.partition, uuid: partition.DiskUUID };
  console.log(`Identified the image partition before copying files in ${((performance.now() - probeStarted) / 1000).toFixed(1)} seconds.`);
}

function readPlist(command, args, timeout = 30_000) {
  const input = execFileSync(command, args, { timeout });
  return JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', '-'],
    { input, encoding: 'utf8', timeout: 30_000 }));
}

function readAttachment() {
  const { images } = readPlist('/usr/bin/hdiutil', ['info', '-plist']);
  assert.ok(Array.isArray(images), 'Missing disk image attachment state.');
  return macOSImageAttachment(images, attachedImage, mount, statSync(mount).dev !== mountDevice);
}

function detach() {
  // Share the retry budget so a late ejection can still finish packaging.
  detachMacOSImage(() => macOSEjectTarget(readAttachment(), ownedPartition),
    target => {
      if (ejectAttemptsRemaining < MACOS_IMAGE_EJECT_ATTEMPTS) console.log('Retrying ejection of the private disk image.');
      ejectAttemptsRemaining -= 1;
      run('/usr/sbin/diskutil', ['eject', target]);
    }, ejectAttemptsRemaining);
  attachedImage = undefined;
  ownedPartition = undefined;
}

try {
  await Promise.all([mkdir(mount), mkdir(installation)]);
  mountDevice = (await stat(mount)).dev;
  const payloadKiB = Number.parseInt(execFileSync('/usr/bin/du', ['-sk', app], { encoding: 'utf8', timeout: 30_000 }), 10);
  assert.ok(Number.isSafeInteger(payloadKiB) && payloadKiB > 0, 'Could not size the app payload.');
  // Leave room for HFS+ metadata and allocation. The sparse image grows as needed.
  const volumeSize = `${Math.ceil(payloadKiB / 1024) + 128}m`;
  const imageStarted = performance.now();
  console.log(`Creating read-only ${name}.`);
  // Own the scratch mount explicitly so the copy and detach are independent operations.
  image('create', '-size', volumeSize, '-type', 'SPARSE', '-fs', 'HFS+', '-volname', 'Athena', volumeImage);
  attach(volumeImage);
  run('/usr/bin/ditto', [app, join(mount, 'Athena.app')], 600_000);
  detach();
  image('convert', volumeImage, '-format', 'UDRO', '-o', candidate);
  console.log(`Created ${name} in ${((performance.now() - imageStarted) / 1000).toFixed(1)} seconds.`);
  image('verify', candidate);
  attach(candidate, true);
  const installed = join(installation, 'Athena.app');
  run('/usr/bin/ditto', [join(mount, 'Athena.app'), installed]);
  detach();
  run(process.execPath, ['scripts/check-desktop-bundle.mjs', '--verify-only', installed]);
  run(process.execPath, ['scripts/smoke-installed-desktop.mjs', installed]);
} catch (error) {
  failures.push(error);
}

try {
  if (attachedImage) detach();
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
  if (!attachedImage) {
    try { await rm(work, { recursive: true, force: true }); }
    catch (error) { failures.push(error); }
  }
}
if (failures.length) throw new AggregateError(failures, 'macOS DMG verification or cleanup failed.');
