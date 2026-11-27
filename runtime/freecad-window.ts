import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { acquireDesktopInput, DesktopControl, DesktopError } from './desktop-control.ts';
import { DesktopMailbox } from './desktop-mailbox.ts';
import { launchOwnedApp } from './desktop-process.ts';
import { freeCadAppProfile, type FreeCadSpec, type FreeCadWriter } from './freecad.ts';
import { writeNewPrivateFileSync } from './private-storage.ts';

type WindowJob = {
  readonly app: string; readonly workspace: string; readonly spec: FreeCadSpec; readonly signal: AbortSignal;
  readonly writer: FreeCadWriter;
  readonly started: (pid: number) => void; readonly log: (message: string) => void;
};

export function desktopSessionAvailable() {
  return process.platform !== 'linux' || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

export async function runFreeCadWindow({ app, workspace, spec, signal, writer, started, log }: WindowJob) {
  if (spec.sourceArtifactId) throw new DesktopError('unsupported', 'The FreeCAD window controls support a new block with a through-hole.');
  if (!desktopSessionAvailable()) throw new DesktopError('unsupported', 'FreeCAD window control needs an interactive desktop session.');
  signal.throwIfAborted();
  const release = acquireDesktopInput();
  let control: DesktopControl | undefined;
  const stop = () => { if (control) void control.stop().catch(() => {}); };
  signal.addEventListener('abort', stop, { once: true });
  try {
    const directory = join(workspace, 'window-' + randomUUID());
    const { args, env } = freeCadAppProfile(directory);
    const macro = join(directory, 'AthenaWindow.FCMacro');
    writeNewPrivateFileSync(join(directory, 'request-scope.json'), JSON.stringify({ workspace, spec, writer }));
    writeNewPrivateFileSync(macro, 'import os, pathlib\n'
      + 'exec(compile(pathlib.Path(os.environ["ATHENA_FREECAD_GUI_SCRIPT"]).read_bytes(), "freecad-gui.py", "exec"))\n');
    const child = launchOwnedApp(app, [...args, macro], { cwd: directory,
      env: { ...env, LANG: 'C', LC_ALL: 'C', ATHENA_DESKTOP_PARENT: String(process.pid),
        ATHENA_FREECAD_GUI_DIRECTORY: directory,
        ATHENA_FREECAD_QT_BRIDGE: fileURLToPath(new URL('./desktop-qt.py', import.meta.url)),
        ATHENA_FREECAD_GUI_SCRIPT: fileURLToPath(new URL('./freecad-gui.py', import.meta.url)) } });
    const pid = await child.started;
    child.detach();
    started(pid);
    control = new DesktopControl(new DesktopMailbox(directory, 'freecad', pid, child.exited), release);
    if (signal.aborted) stop();
    signal.throwIfAborted();
    writeNewPrivateFileSync(join(directory, 'owner'), String(pid));
    const ready = join(directory, 'ready.json');
    const until = Date.now() + 20_000;
    let version: string | undefined;
    while (Date.now() < until && !child.exited.aborted) {
      signal.throwIfAborted();
      const file = lstatSync(ready, { throwIfNoEntry: false });
      if (file?.isFile() && file.size <= 1024) {
        const reply = JSON.parse(readFileSync(ready, 'utf8')) as { pid?: unknown; version?: unknown };
        if (reply.pid === pid && typeof reply.version === 'string' && /^\d+\.\d+\.\d+$/u.test(reply.version)) {
          version = reply.version; break;
        }
        throw new DesktopError('failed', 'The launched FreeCAD process did not identify its window controls.');
      }
      await sleep(50, undefined, { signal });
    }
    if (!version) throw new DesktopError('failed', 'The owned FreeCAD window did not initialize.');
    const deadline = Date.now() + 75_000;
    let lastAction = 'FreeCAD startup';
    let lastProgress = Date.now();
    let inputs = 0;
    while (Date.now() < deadline && Date.now() - lastProgress < 10_000 && inputs < 32) {
      signal.throwIfAborted();
      try {
        const frame = await control.observe();
        const target = frame.targets.length === 1 ? frame.targets[0] : undefined;
        if (target === 'complete') return { version, png: frame.png };
        if (target) {
          await control.activate(frame.id, target);
          log('FreeCAD window · ' + target.replaceAll('_', ' '));
          lastAction = target;
          lastProgress = Date.now();
          inputs++;
          continue;
        }
      } catch (cause) {
        // A stale target confirms no input was dispatched. The next turn observes anew.
        if (!(cause instanceof DesktopError) || cause.code !== 'stale_observation') throw cause;
      }
      await sleep(80, undefined, { signal });
    }
    throw new DesktopError('indeterminate', 'The FreeCAD window did not reach the next approved control after ' +
      lastAction.replaceAll('_', ' ') + '. Inspect the existing outputs before another write.');
  } finally {
    signal.removeEventListener('abort', stop);
    if (control) await control.stop();
    else release();
  }
}
