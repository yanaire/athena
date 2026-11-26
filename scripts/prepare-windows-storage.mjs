import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const executableName = 'windows-private-storage.exe';
const configurationName = `${executableName}.config`;
const expectedVersion = 'athena-windows-private-storage/1 .NETFramework/4.8';
const sha256 = async path => createHash('sha256').update(await readFile(path)).digest('hex');

/** Build only on native Windows; no compiler or source is distributed with the host. */
export async function prepareWindowsStorage(outputDirectory = join(root, 'runtime')) {
  if (process.platform !== 'win32') return undefined;
  if (process.arch !== 'x64') throw new Error('Athena Windows storage requires a native x64 build host.');
  const systemKey = Object.keys(process.env).find(key => key.toUpperCase() === 'SYSTEMROOT')
    ?? Object.keys(process.env).find(key => key.toUpperCase() === 'WINDIR');
  const systemRoot = systemKey && process.env[systemKey];
  if (!systemRoot || !win32.isAbsolute(systemRoot)) throw new Error('The Windows system directory is unavailable.');
  const framework = win32.join(systemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  const compiler = win32.join(framework, 'csc.exe');
  const compilerInfo = await lstat(compiler);
  if (!compilerInfo.isFile() || compilerInfo.isSymbolicLink()) throw new Error('The fixed Windows C# compiler is unavailable.');
  const source = join(root, 'native', 'windows-private-storage.cs');
  const configuration = join(root, 'native', configurationName);
  const output = resolve(outputDirectory);
  await mkdir(output, { recursive: true });
  const work = await mkdtemp(join(dirname(output), 'windows-storage-prepare-'));
  try {
    const executable = join(work, executableName);
    // Ignore compiler response files and arbitrary assembly search paths. This
    // helper uses only the OS framework's mscorlib and no external dependencies.
    execFileSync(compiler, ['/nologo', '/noconfig', '/nostdlib+', '/target:exe', '/platform:x64',
      '/optimize+', '/checked+', '/warn:4', '/warnaserror+', `/reference:${win32.join(framework, 'mscorlib.dll')}`,
      `/out:${executable}`, source], { cwd: root, windowsHide: true, timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
    await copyFile(configuration, join(work, configurationName));
    const version = execFileSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true,
      timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] });
    if (version !== expectedVersion) throw new Error('Unexpected Windows storage helper identity.');
    const provenance = { sourceSha256: await sha256(source), executableSha256: await sha256(executable),
      configurationSha256: await sha256(configuration), framework: '4.8', target: 'x86_64-pc-windows-msvc' };
    for (const name of [configurationName, executableName]) {
      await rm(join(output, name), { force: true });
      await rename(join(work, name), join(output, name));
    }
    return provenance;
  } finally { await rm(work, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await prepareWindowsStorage();
  if (result) console.log('Prepared the fixed Windows private-storage helper (.NET Framework 4.8).');
}
