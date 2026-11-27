import { randomUUID } from 'node:crypto';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DesktopError } from './desktop-control.ts';
import { applicationEnvironment, launchOwnedApp, localExecutable } from './desktop-process.ts';
import { createPrivateDirectory, writeNewPrivateFileSync } from './private-storage.ts';

const namePattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u;
const reservedName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;
const appNames = /^freecad(?:-python3)?(?:\.exe)?$/iu;
const pythonNames = /^python(?:\d+(?:\.\d+)?)?(?:\.exe)?$/iu;
const resultPrefix = 'ATHENA_CAD_RESULT ';
export const freeCadFileBytes = 16 * 1024 * 1024;
export const freeCadVerificationName = 'freecad-verification.json';
export const freeCadWorkerTimeout = 35_000;

export type FreeCadSpec = Readonly<{
  name: string; length: number; width: number; height: number; diameter: number;
  sourceArtifactId?: string;
}>;

type ProbeOptions = {
  readonly app?: string; readonly python?: string; readonly modules?: string;
  readonly authoringUnsupported?: boolean;
};

function dictionary(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function freeCadSpec(value: unknown): FreeCadSpec {
  if (!dictionary(value) || Object.keys(value).some(key => !['name', 'length', 'width', 'height', 'diameter', 'sourceArtifactId'].includes(key))) {
    throw new TypeError('Supply a FreeCAD part name, dimensions in mm and an optional source artifact.');
  }
  const { name, length, width, height, diameter, sourceArtifactId } = value;
  if (typeof name !== 'string' || !namePattern.test(name) || reservedName.test(name)) {
    throw new TypeError('Use a FreeCAD filename stem of up to 64 ASCII letters, numbers, hyphens or underscores.');
  }
  const dimension = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0.1 && n <= 1000;
  if (!dimension(length) || !dimension(width) || !dimension(height) || !dimension(diameter) ||
    Math.min(length, width) - diameter < 0.1 - 1e-8 ||
    ![length, width, height, diameter].every(n => Math.abs(n * 100 - Math.round(n * 100)) < 1e-8)) {
    throw new TypeError('Use 0.1–1000 mm in increments of 0.01 mm, with at least 0.1 mm between the diameter and each horizontal dimension.');
  }
  if (sourceArtifactId !== undefined && (typeof sourceArtifactId !== 'string' || !/^[a-f0-9-]{36}$/u.test(sourceArtifactId))) {
    throw new TypeError('Select a verified FCStd source artifact.');
  }
  return Object.freeze({ name, length, width, height, diameter, ...(sourceArtifactId ? { sourceArtifactId } : {}) });
}

export function freeCadNames(spec: FreeCadSpec) {
  return [spec.name + '.FCStd', spec.name + '.step'] as const;
}

export function freeCadMime(name: string) {
  if (name === freeCadVerificationName) return 'application/json';
  const dot = name.lastIndexOf('.');
  const stem = name.slice(0, dot);
  if (!namePattern.test(stem) || reservedName.test(stem)) return;
  if (name.endsWith('.FCStd')) return 'application/vnd.freecad';
  if (name.endsWith('.step')) return 'model/step';
}

function windowsCandidates() {
  if (process.platform !== 'win32' || !process.env.ProgramFiles) return [];
  const root = process.env.ProgramFiles;
  return readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() &&
    /^FreeCAD(?:[ -]\d+(?:\.\d+)*)?$/iu.test(entry.name))
    .map(entry => join(root, entry.name, 'bin', 'FreeCAD.exe')).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}

function appCandidates() {
  if (process.platform === 'darwin') return ['/Applications/FreeCAD.app/Contents/MacOS/FreeCAD'];
  if (process.platform === 'win32') return windowsCandidates();
  return ['/usr/bin/freecad', '/usr/local/bin/freecad'];
}

function directory(path: string): string {
  if (!isAbsolute(path)) throw new DesktopError('denied', 'FreeCAD modules must use an absolute installed path.');
  const real = realpathSync(path);
  if (!lstatSync(real).isDirectory()) throw new DesktopError('denied', 'The FreeCAD module location is not an installed directory.');
  return real;
}

export function freeCadAppProfile(profile: string, background = false) {
  createPrivateDirectory(profile);
  return {
    args: ['-u', join(profile, 'user.cfg'), '-s', join(profile, 'system.cfg')],
    env: { ...applicationEnvironment(), FREECAD_USER_HOME: profile, FREECAD_USER_DATA: profile,
      FREECAD_USER_TEMP: join(profile, 'temp'), XDG_CONFIG_HOME: join(profile, 'config'), XDG_DATA_HOME: join(profile, 'data'),
      XDG_CACHE_HOME: join(profile, 'cache'), ...(background ? { QT_QPA_PLATFORM: 'offscreen' } : {}) },
  };
}

export function freeCadInstallation(options: ProbeOptions = {}) {
  const app = localExecutable(options.app ? [options.app] : appCandidates(), appNames);
  const distro = process.platform === 'linux' && lstatSync('/usr/lib/freecad-python3/lib/FreeCAD.so', { throwIfNoEntry: false });
  const python = options.python ? localExecutable([options.python], pythonNames)
    : distro && !options.app ? localExecutable(['/usr/bin/python3'], pythonNames) : undefined;
  if (Boolean(options.python) !== Boolean(options.modules) || (options.python && !python)) {
    throw new DesktopError('denied', 'Configure an installed FreeCAD Python executable and its modules together.');
  }
  const modules = options.modules ? directory(options.modules) : python ? '/usr/lib/freecad-python3/lib' : undefined;
  return { app, python, modules, authoringUnsupported: options.authoringUnsupported === true };
}

type WorkerReceipt = Readonly<{ version: string; files?: Readonly<Record<string, unknown>> }>;
export type FreeCadWriter = Readonly<{ lock: string; marker: string; attemptId: string }>;

export class FreeCadAdapter {
  readonly #options: ProbeOptions;

  constructor(options: ProbeOptions = {
    app: process.env.ATHENA_FREECAD_APP, python: process.env.ATHENA_FREECAD_PYTHON,
    modules: process.env.ATHENA_FREECAD_MODULES,
    authoringUnsupported: process.env.ATHENA_FREECAD_API_AUTHORING === 'unsupported',
  }) { this.#options = options; }

  installation() { return freeCadInstallation(this.#options); }

  async #worker(mode: 'author' | 'verify', workspace: string, spec: FreeCadSpec, signal: AbortSignal,
    started: (pid: number) => void, runtimeDirectory = workspace, writer?: FreeCadWriter) {
    signal.throwIfAborted();
    const { app, python, modules, authoringUnsupported } = this.installation();
    if (mode === 'author' && authoringUnsupported) {
      throw new DesktopError('unsupported', 'The FreeCAD authoring adapter reports this operation unsupported.');
    }
    if (!app && !python) throw new DesktopError('unsupported', 'A supported FreeCAD installation was not found.');
    const profile = join(runtimeDirectory, mode + '-' + randomUUID());
    const { args, env } = freeCadAppProfile(profile, !python);
    const request = join(profile, 'request.json');
    writeNewPrivateFileSync(request, JSON.stringify({ mode, workspace, spec, modules, writer }));
    const script = fileURLToPath(new URL('./freecad-api.py', import.meta.url));
    const executable = python ?? app!;
    const owner = join(profile, 'owner');
    const macro = join(profile, 'AthenaFreeCAD.FCMacro');
    if (!python) {
      writeNewPrivateFileSync(macro, 'import os, pathlib\n'
        + 'if pathlib.Path(os.environ["ATHENA_FREECAD_OWNER_FILE"]).read_text(encoding="ascii") == str(os.getpid()):\n'
        + '    exec(compile(pathlib.Path(os.environ["ATHENA_FREECAD_API_SCRIPT"]).read_bytes(), "freecad-api.py", "exec"), {"__name__": "__main__"})\n');
    }
    const child = launchOwnedApp(executable, python ? ['-I', script] : [...args, macro], {
      cwd: profile, captureOutput: true, background: true,
      env: { ...env, ATHENA_FREECAD_REQUEST: request, ...(!python ? { ATHENA_FREECAD_OWNER_FILE: owner,
        ATHENA_FREECAD_API_SCRIPT: script } : {}) },
    });
    const timeout = AbortSignal.timeout(freeCadWorkerTimeout);
    const abort = AbortSignal.any([signal, timeout]);
    const stop = () => { child.terminate(); };
    abort.addEventListener('abort', stop, { once: true });
    try {
      const pid = await child.started;
      started(pid);
      if (!python) writeNewPrivateFileSync(owner, String(pid));
      if (abort.aborted) stop();
      const result = await child.closed;
      if (abort.aborted || result.code !== 0) {
        throw new DesktopError(mode === 'author' ? 'indeterminate' : 'failed',
          mode === 'author' ? 'FreeCAD did not confirm the write. Check the existing outputs before another write.'
            : 'FreeCAD did not complete the read-only check.');
      }
      const report = result.stdout.split(/\r?\n/u).findLast(line => line.startsWith(resultPrefix));
      const receipt: unknown = report ? JSON.parse(report.slice(resultPrefix.length)) : null;
      if (!dictionary(receipt)) throw new DesktopError(mode === 'author' ? 'indeterminate' : 'failed', 'FreeCAD did not return a result receipt.');
      if (receipt.status !== 'ok') {
        const code = receipt.status === 'denied' || receipt.status === 'unsupported' || receipt.status === 'indeterminate' ||
          receipt.status === 'invalid_result'
          ? receipt.status : 'failed';
        throw new DesktopError(code, typeof receipt.message === 'string' ? receipt.message : 'The FreeCAD operation failed.');
      }
      if (typeof receipt.version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(receipt.version) ||
        (mode === 'verify' && !dictionary(receipt.files))) {
        throw new DesktopError(mode === 'author' ? 'indeterminate' : 'failed', 'FreeCAD returned a malformed result receipt.');
      }
      return { version: receipt.version, files: receipt.files } as WorkerReceipt;
    } finally {
      abort.removeEventListener('abort', stop);
      if (!child.exited.aborted) { stop(); await child.closed; }
    }
  }

  author(workspace: string, spec: FreeCadSpec, signal: AbortSignal, started: (pid: number) => void, writer?: FreeCadWriter) {
    return this.#worker('author', workspace, spec, signal, started, workspace, writer);
  }

  verify(workspace: string, spec: FreeCadSpec, signal: AbortSignal, started: (pid: number) => void, runtimeDirectory?: string) {
    return this.#worker('verify', workspace, spec, signal, started, runtimeDirectory);
  }
}
