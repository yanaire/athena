import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareAnalysis } from './prepare-analysis.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const generated = join(root, 'src-tauri', 'desktop-generated');
const version = '24.22.3';
const target = 'aarch64-apple-darwin';
const release = `node-v${version}-darwin-arm64`;
const url = `https://nodejs.org/dist/v${version}/${release}.tar.gz`;
const archiveSha256 = 'ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd';
const ui = 'athena-backend-handoff/athena-codex-ui';

function run(command, args, cwd = root) {
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function stageNode(work, host) {
  const archive = join(generated, `${release}.tar.gz`);
  const digest = await sha256(archive).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (digest !== archiveSha256) {
    const download = join(work, 'node.tar.gz');
    run('curl', ['--fail', '--silent', '--show-error', '--location', '--proto', '=https',
      '--retry', '2', '--connect-timeout', '15', '--max-time', '300', '--output', download, url]);
    const received = await sha256(download);
    if (received !== archiveSha256) {
      throw new Error(`Node archive SHA-256 mismatch: expected ${archiveSha256}, got ${received}.`);
    }
    await rename(download, archive);
  }

  run('tar', ['-xzf', archive, '-C', work, `${release}/bin/node`, `${release}/LICENSE`]);
  const binary = join(work, release, 'bin', 'node');
  const nodeIdentity = execFileSync(binary, ['-p', '[process.version, process.platform, process.arch].join(" ")'],
    { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } }).trim();
  if (nodeIdentity !== `v${version} darwin arm64`) throw new Error(`Unexpected Node binary: ${nodeIdentity}.`);

  const licenses = join(host, 'licenses');
  await mkdir(licenses);
  // Node's upstream LICENSE includes the bundled dependency notices.
  await copyFile(join(work, release, 'LICENSE'), join(licenses, 'node-LICENSE.txt'));
  await chmod(binary, 0o755);
  return binary;
}

async function stageHost(host) {
  for (const name of ['package.json', 'package-lock.json']) {
    await copyFile(join(root, name), join(host, name));
  }
  // A clean install keeps workstation dependencies, npm bin symlinks and lifecycle scripts out of the app.
  run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-bin-links', '--no-audit', '--no-fund'], host);
  // The Pi SDK does not load this terminal demo; its embedded WASM has separate redistribution terms.
  await rm(join(host, 'node_modules', '@earendil-works', 'pi-coding-agent',
    'examples', 'extensions', 'doom-overlay'), { recursive: true, force: true });

  const lockSha256 = await sha256(join(host, 'package-lock.json'));
  const { name, version: hostVersion, type, engines, dependencies } =
    JSON.parse(await readFile(join(host, 'package.json'), 'utf8'));
  const manifest = { name, version: hostVersion, private: true, type, engines, dependencies };
  await writeFile(join(host, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await rm(join(host, 'package-lock.json'));
  await rm(join(host, 'node_modules', '.package-lock.json'), { force: true });

  // Only repository runtime source files and the existing generated browser assets are deployable.
  await mkdir(join(host, 'runtime'));
  for (const entry of await readdir(join(root, 'runtime'), { withFileTypes: true })) {
    if (entry.isFile() && /\.(?:ts|mjs)$/.test(entry.name)) {
      await copyFile(join(root, 'runtime', entry.name), join(host, 'runtime', entry.name));
    }
  }
  if (process.env.ATHENA_BUILD_CHATGPT_LOCAL === '1') {
    await writeFile(join(host, 'runtime', 'desktop-distribution.ts'), 'export const localChatGPTPlanUsage: boolean = true;\n');
  }
  await mkdir(join(host, ui, 'integrations'), { recursive: true });
  for (const asset of ['athena-preview.html', 'integrations/athena-host.js', 'integrations/pi-host-adapter.mjs']) {
    await copyFile(join(root, ui, asset), join(host, ui, asset));
  }
  return lockSha256;
}

async function assertRegularResources(directory) {
  // Tauri copies resource entries as files, rather than preserving symbolic links.
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await assertRegularResources(path);
    else if (!entry.isFile()) throw new Error(`Unsupported bundled resource: ${path}.`);
  }
}

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('Athena desktop packaging requires a native arm64 Node.js on Apple Silicon macOS.');
}

await mkdir(generated, { recursive: true });
const work = await mkdtemp(join(generated, 'prepare-'));
try {
  const host = join(work, 'host');
  await mkdir(host);
  const binary = await stageNode(work, host);
  const packageLockSha256 = await stageHost(host);
  const sandbox = join(work, `athena-sandbox-${target}`);
  await prepareAnalysis(join(host, 'analysis-runtime'), sandbox);
  const provenance = {
    node: { version, target, url, archiveSha256, executableSha256: await sha256(binary) },
    npm: { packageLockSha256, omit: ['dev'], ignoreScripts: true },
  };
  await writeFile(join(host, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);
  await assertRegularResources(host);

  const bin = join(generated, 'bin');
  await mkdir(bin, { recursive: true });
  const hostOutput = join(generated, 'host');
  const existingHost = await lstat(hostOutput).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existingHost && !existingHost.isDirectory()) throw new Error(`Expected a staging directory at ${hostOutput}.`);
  await rm(hostOutput, { recursive: true, force: true });
  await rename(host, hostOutput);
  await rename(binary, join(bin, `athena-node-${target}`));
  await rename(sandbox, join(bin, `athena-sandbox-${target}`));
  console.log(`Prepared Athena desktop host and verified Node v${version} (${target}).`);
} finally {
  await rm(work, { recursive: true, force: true });
}
