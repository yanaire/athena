import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export async function lockedSandboxIdentity() {
  const lock = await readFile(new URL('../sandbox/Cargo.lock', import.meta.url));
  const packages = lock.toString('utf8').split('[[package]]');
  const versions = ['wasmtime', 'wasmtime-wasi', 'wiggle'].map(name => {
    const entries = packages.filter(entry => entry.trimStart().split(/\r?\n/, 1)[0] === `name = "${name}"`);
    const version = entries[0]?.trimStart().split(/\r?\n/, 2)[1]?.match(/^version = "(\d+\.\d+\.\d+)"$/)?.[1];
    if (entries.length !== 1 || !version) throw new Error(`Expected one locked ${name} version in sandbox/Cargo.lock.`);
    return version;
  });
  if (versions.some(version => version !== versions[0])) throw new Error('The locked Wasmtime, WASI and Wiggle versions differ.');
  return {
    identity: `athena-sandbox/1 wasmtime/${versions[0]}`,
    lockSha256: createHash('sha256').update(lock).digest('hex'),
  };
}
