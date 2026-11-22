import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const cache = join(root, '.analysis-runtime');
const pythonRelease = 'https://github.com/brettcannon/cpython-wasi-build/releases/download/v3.15.2/python-3.15.2-wasi_sdk-33.zip';
const jsRelease = 'https://github.com/quickjs-ng/quickjs/releases/download/v0.18.0/qjs-wasi.wasm';
const jsLicense = 'https://raw.githubusercontent.com/quickjs-ng/quickjs/v0.18.0/LICENSE';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function pinned(work, name, url, digest) {
  const destination = join(cache, name);
  const prior = await readFile(destination).catch(error => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (prior && hash(prior) === digest) return destination;
  const temp = join(work, name);
  execFileSync('curl', ['-fLsS', '--retry', '2', '--proto', '=https', '--connect-timeout', '15', '--max-time', '180', '-o', temp, url]);
  if (hash(await readFile(temp)) !== digest) throw new Error(`Invalid upstream hash for ${name}`);
  await rename(temp, destination);
  return destination;
}

export async function prepareAnalysis(destination, binaryDestination) {
  await mkdir(cache, { recursive: true });
  const work = await mkdtemp(join(cache, 'stage-'));
  try {
    const upstream = {
      python: { version: '3.15.2', url: pythonRelease, sha256: 'b8a63559c56760bbdc310dedb74fd69d10bcbafae26b705bea0ad353ad256888' },
      javascript: { version: '0.18.0', url: jsRelease, sha256: '2c218412cb8b17e46ee91bea7556ec38f5b9b6bd6312fddd3ceeed14aa71eaaa' },
    };
    const [python, javascript, license] = await Promise.all([
      pinned(work, 'python-3.15.2.zip', upstream.python.url, upstream.python.sha256),
      pinned(work, 'qjs-0.18.0.wasm', upstream.javascript.url, upstream.javascript.sha256),
      pinned(work, 'quickjs-LICENSE.txt', jsLicense, '96f73f9d2a16c21a36b418f06073be26e7d6d5e7c1bc99756b21a4f2c74ef171'),
    ]);
    const platform = process.platform === 'darwin' ? 'apple-darwin' : process.platform === 'linux' ? 'unknown-linux-gnu' : '';
    const arch = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : '';
    if (!platform || !arch) throw new Error('Analysis requires a supported Unix build host.');
    const target = `${arch}-${platform}`;
    execFileSync('cargo', ['build', '--release', '--locked', '--target', target, '--manifest-path', join(root, 'sandbox/Cargo.toml')], { stdio: 'inherit' });
    const out = join(work, 'runtime');
    await mkdir(join(out, 'python'), { recursive: true });
    execFileSync('unzip', ['-q', python, '-d', join(out, 'python')]);
    await rename(join(out, 'python/python.wasm'), join(out, 'python.wasm'));
    await copyFile(javascript, join(out, 'qjs.wasm'));
    const helper = join(root, 'sandbox', 'target', target, 'release', 'athena-sandbox');
    const binary = binaryDestination ?? join(out, 'athena-sandbox');
    await copyFile(helper, binary);
    await chmod(binary, 0o755);
    await copyFile(license, join(out, 'quickjs-LICENSE.txt'));
    const files = Object.fromEntries(await Promise.all(Object.entries({ 'athena-sandbox': binary, 'python.wasm': join(out, 'python.wasm'),
      'qjs.wasm': join(out, 'qjs.wasm') }).map(async ([name, path]) => [name, hash(await readFile(path))])));
    await writeFile(join(out, 'provenance.json'), JSON.stringify({ upstream, helper: { target, lockSha256: hash(await readFile(join(root, 'sandbox/Cargo.lock'))) }, files }, null, 2) + '\n');
    await rm(destination, { recursive: true, force: true });
    await rename(out, destination);
  } finally { await rm(work, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await prepareAnalysis(join(cache, 'staged'));
  console.log('Prepared offline analysis runtime.');
}
