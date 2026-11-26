import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { desktopBuildPlan } from '../scripts/build-desktop.mjs';
import { detachMacOSImage, isolatedRuntimeEnvironment, macOSEjectTarget, macOSImageAttachment, resolveDesktopPlatform } from '../scripts/desktop-platform.mjs';

test('macOS packaging confirms detachment despite a late DiskArbitration response', async () => {
  const calls = [];
  const probeImmediately = async () => {};
  const target = '10B24A7B-C507-413D-BB71-284231981351';
  const mounted = { state: 'mounted', target };
  const detached = { state: 'detached' };
  let attachment = mounted;
  await detachMacOSImage(() => attachment, device => {
    calls.push(device);
    if (calls.length === 1) throw new Error('timeout for DiskArbitration expired');
    attachment = detached;
    throw new Error('No such file or directory');
  });
  assert.deepEqual(calls, [target, target]);

  attachment = mounted;
  calls.length = 0;
  await detachMacOSImage(() => attachment, device => {
    calls.push(device);
    attachment = detached;
    throw new Error('timeout for DiskArbitration expired');
  });
  assert.deepEqual(calls, [target]);

  attachment = mounted;
  calls.length = 0;
  await detachMacOSImage(() => attachment, uuid => {
    calls.push(uuid);
    if (calls.length < 3) throw new Error('Disk Arbitration has not finished ejecting the image');
    attachment = detached;
  });
  assert.deepEqual(calls, [target, target, target]);

  calls.length = 0;
  const transitions = [mounted, { state: 'ambiguous' }, mounted, detached];
  await detachMacOSImage(() => transitions.shift(), uuid => calls.push(uuid), undefined, probeImmediately);
  assert.deepEqual(calls, [target, target]);

  attachment = mounted;
  calls.length = 0;
  await assert.rejects(() => detachMacOSImage(() => attachment, device => {
    calls.push(device);
    attachment = { state: 'ambiguous' };
    throw new Error('drive not detached');
  }, undefined, probeImmediately), /still attached/);
  assert.deepEqual(calls, [target]);

  attachment = mounted;
  calls.length = 0;
  await assert.rejects(() => detachMacOSImage(() => attachment, device => calls.push(device)), /still attached/);
  assert.deepEqual(calls, [target, target, target, target]);
  await assert.rejects(() => detachMacOSImage(() => attachment, () => assert.fail('Ejection budget exhausted'), 0), /still attached/);
});

test('macOS packaging finds the owned partition after unmount and retries with its media UUID', async () => {
  const path = '/private/tmp/athena/Athena.sparseimage';
  const mount = '/private/tmp/athena/mount';
  const target = '10B24A7B-C507-413D-BB71-284231981351';
  const device = '/dev/disk6';
  const partition = `${device}s2`;
  const whole = { 'content-hint': 'GUID_partition_scheme', 'dev-entry': device };
  const hfs = { 'dev-entry': partition };
  const report = (entities, imagePath = path) => [{ 'image-path': imagePath, 'system-entities': entities }];
  const mounted = report([whole, { ...hfs, 'mount-point': mount }]);
  const unmounted = report([whole, hfs]);
  const mountedAttachment = macOSImageAttachment(mounted, path, mount, true);
  const unmountedAttachment = macOSImageAttachment(unmounted, path, mount, false);
  assert.deepEqual(mountedAttachment, { state: 'mounted', device, partition });
  assert.deepEqual(unmountedAttachment, { state: 'unmounted', device, partition });
  assert.deepEqual(macOSImageAttachment(report([whole, hfs], '/another-image'), path, mount, false), { state: 'detached' });
  assert.deepEqual(macOSImageAttachment(report([whole, { ...hfs, 'mount-point': '/different-mount' }]), path, mount, false),
    { state: 'ambiguous' });
  assert.deepEqual(macOSImageAttachment(mounted, path, mount, false), { state: 'ambiguous' });
  assert.deepEqual(macOSEjectTarget(mountedAttachment, undefined), { state: 'ambiguous' });
  assert.deepEqual(macOSEjectTarget(unmountedAttachment, undefined), { state: 'ambiguous' });
  assert.deepEqual(macOSEjectTarget(unmountedAttachment, { device, partition: `${device}s3`, uuid: target }),
    { state: 'ambiguous' });

  const calls = [];
  const ownership = { device, partition, uuid: target };
  let images = mounted;
  await detachMacOSImage(() => {
    const attachment = macOSImageAttachment(images, path, mount, images === mounted);
    return macOSEjectTarget(attachment, ownership);
  }, uuid => {
    calls.push(uuid);
    if (images === mounted) {
      images = unmounted;
      throw new Error('timeout for DiskArbitration expired');
    }
    images = [];
  });
  assert.deepEqual(calls, [target, target]);
});

test('each native platform selects a distinct pinned Node archive and matching sidecar ABI', () => {
  const variants = [
    [{ platform: 'darwin', arch: 'arm64' }, 'aarch64-apple-darwin', 'darwin-arm64.tar.gz', '', 'app'],
    [{ platform: 'darwin', arch: 'x64' }, 'x86_64-apple-darwin', 'darwin-x64.tar.gz', '', 'app'],
    [{ platform: 'win32', arch: 'x64' }, 'x86_64-pc-windows-msvc', 'win-x64.zip', '.exe', 'nsis'],
  ];
  const hashes = new Set();
  for (const [host, target, archive, exe, bundle] of variants) {
    const platform = resolveDesktopPlatform({ ...host, target });
    assert.equal(platform.target, target);
    assert.ok(platform.archive.endsWith(archive));
    assert.ok(platform.url.startsWith('https://nodejs.org/dist/v24.22.3/'));
    assert.equal(platform.exe, exe);
    assert.equal(platform.bundle, bundle);
    assert.match(platform.archiveSha256, /^[a-f0-9]{64}$/);
    hashes.add(platform.archiveSha256);
    assert.ok(platform.nodeInArchive.endsWith(exe ? 'node.exe' : 'bin/node'));
  }
  assert.equal(hashes.size, 3);
});

test('packaging rejects a mismatched or unsupported host instead of mixing executable architectures', () => {
  assert.throws(() => resolveDesktopPlatform({ platform: 'darwin', arch: 'arm64', target: 'x86_64-apple-darwin' }), /does not match/);
  assert.throws(() => resolveDesktopPlatform({ platform: 'win32', arch: 'arm64' }), /requires native/);
  assert.throws(() => resolveDesktopPlatform({ platform: 'linux', arch: 'x64' }), /requires native/);
});

test('native build plans preserve locked compilation and explicitly opt in to the local ChatGPT build', () => {
  const mac = desktopBuildPlan([], { platform: 'darwin', arch: 'x64', target: 'x86_64-apple-darwin' });
  assert.deepEqual(mac.tauriArgs, ['build', '--target', 'x86_64-apple-darwin', '--bundles', 'app', '--', '--locked']);
  const windows = desktopBuildPlan(['--local-chatgpt'], { platform: 'win32', arch: 'x64', target: 'x86_64-pc-windows-msvc' });
  assert.deepEqual(windows.tauriArgs, ['build', '--target', 'x86_64-pc-windows-msvc', '--bundles', 'nsis',
    '--config', 'src-tauri/tauri.local-chatgpt.conf.json', '--no-sign', '--', '--locked']);
  assert.equal(mac.localChatGPT, false);
  assert.equal(windows.localChatGPT, true);
  assert.throws(() => desktopBuildPlan(['--target'], { platform: 'win32', arch: 'x64' }), /Usage/);
  assert.throws(() => desktopBuildPlan(['--bundles', 'msi'], { platform: 'win32', arch: 'x64' }), /Usage/);
});

test('verification isolates secrets and Node overrides while preserving Windows loader locations', () => {
  const home = 'C:\\Temp\\Athena test account';
  const environment = isolatedRuntimeEnvironment(home, {
    SYSTEMROOT: 'C:\\Windows', windir: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    Path: 'C:\\untrusted', NODE_OPTIONS: '--require untrusted.js', OPENAI_API_KEY: 'synthetic-secret',
    USERPROFILE: 'C:\\Users\\Original', APPDATA: 'C:\\Users\\Original\\AppData\\Roaming', TEMP: 'C:\\Temp',
  }, 'win32');
  assert.equal(environment.SystemRoot, 'C:\\Windows');
  assert.equal(environment.PATH, 'C:\\Windows\\System32;C:\\Windows');
  assert.equal(environment.USERPROFILE, home);
  assert.equal(environment.APPDATA, `${home}\\AppData\\Roaming`);
  assert.equal(environment.NODE_OPTIONS, undefined);
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.Path, undefined);
  assert.throws(() => isolatedRuntimeEnvironment(home, { SystemRoot: 'relative' }, 'win32'), /system directory/);
  assert.deepEqual(isolatedRuntimeEnvironment('/tmp/athena', { NODE_OPTIONS: 'invalid' }, 'darwin'), { PATH: '/usr/bin:/bin', HOME: '/tmp/athena' });
});

test('Windows installer keeps per-user installation and an actual WebView2 installation path', async () => {
  const base = JSON.parse(await readFile(new URL('../src-tauri/tauri.conf.json', import.meta.url)));
  const windows = JSON.parse(await readFile(new URL('../src-tauri/tauri.windows.conf.json', import.meta.url)));
  assert.deepEqual(base.bundle.externalBin, ['desktop-generated/bin/athena-node', 'desktop-generated/bin/athena-sandbox']);
  assert.deepEqual(windows.bundle.targets, ['nsis']);
  assert.equal(windows.bundle.windows.nsis.installMode, 'currentUser');
  assert.equal(windows.bundle.windows.minimumWebview2Version, '101.0.1210.39');
  assert.equal(windows.bundle.windows.nsis.installerHooks, 'windows-installer-hooks.nsh');
  assert.equal(windows.bundle.windows.webviewInstallMode.type, 'downloadBootstrapper');
  assert.equal(windows.app, undefined, 'Platform packaging must not broaden application capabilities.');
  const icon = await readFile(new URL('../src-tauri/icons/icon.ico', import.meta.url));
  assert.equal(icon.readUInt16LE(0), 0);
  assert.equal(icon.readUInt16LE(2), 1);
  assert.ok(icon.readUInt16LE(4) >= 6);
});
