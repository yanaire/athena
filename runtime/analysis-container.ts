import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { promisify } from 'node:util';
import { ANALYSIS_FILE_LIMITS, type AnalysisSnapshot } from './analysis-files.ts';

const exec = promisify(execFile);
export const ANALYSIS_LIMITS = Object.freeze({ cpu: 1, memoryMiB: 192, pids: 48, tmpMiB: 8, openFiles: 128,
  fileBytes: ANALYSIS_FILE_LIMITS.fileBytes, streamBytes: 16384, maxArgs: 16, argBytes: 256, snapshotBytes: 2 * 1024 * 1024,
  maxFiles: ANALYSIS_FILE_LIMITS.batchFiles, maxTimeoutMs: 30000 });
const paths = { node: '/usr/local/bin/node', python: '/usr/bin/python3' } as const;
export type Language = keyof typeof paths;
export type AnalysisAccess = { readonly available: false; readonly reason: string } | { readonly available: true;
  readonly imageId: string; readonly node: Program; readonly python: Program };
type Program = { readonly path: string; readonly version: string };
export const analysisEnv = Object.freeze({ PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', HOME: '/tmp', TZ: 'UTC' });
const envArgs = Object.entries(analysisEnv).map(([k,v]) => k + '=' + v);
const cliEnv = { PATH: process.env.PATH, LANG: 'C' };
// Never inherit a remote context, registry credentials, or Docker client proxy settings.
function client() {
  const socket = process.env.ATHENA_DOCKER_SOCKET ?? (process.platform === 'darwin' ? join(homedir(), '.docker/run/docker.sock') : '/var/run/docker.sock');
  if (!socket.startsWith('/') || socket.includes('\0')) throw new Error('Expected a local Docker Unix socket.');
  return ['--config', '/etc/athena/no-client-config', '--host', 'unix://' + socket];
}
const cli = (args: readonly string[]) => exec('docker', [...client(), ...args], {env: cliEnv, timeout: 15000, killSignal: 'SIGKILL', maxBuffer: 16384});
const l = ANALYSIS_LIMITS;
const isolation = ['--pull=never', '--rm', '--init=false', '--runtime=runc', '--network=none', '--ipc=none', '--cgroupns=private',
  '--user=65534:65534', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--read-only', '--no-healthcheck', '--log-driver=none',
  '--pids-limit='+l.pids, '--cpus='+l.cpu, '--memory='+l.memoryMiB+'m', '--memory-swap='+l.memoryMiB+'m',
  '--ulimit=nofile='+l.openFiles+':'+l.openFiles, '--ulimit=core=0:0', '--ulimit=fsize='+l.fileBytes+':'+l.fileBytes,
  '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size='+l.tmpMiB+'m,mode=1777', '--workdir=/workspace'];
const detail = (error: unknown) => error instanceof Error ? error.message.slice(-1000) : 'Docker command failed';

export async function analysisAccess(imageId: string | undefined): Promise<AnalysisAccess> {
  if (!imageId || !/^sha256:[0-9a-f]{64}$/.test(imageId)) return {available:false,reason:'Set ATHENA_ANALYSIS_IMAGE to a trusted, local immutable sha256 image ID.'};
  try {
    const {stdout} = await cli(['image','inspect','--format','{{.Id}} {{json (index .Config "Volumes")}}',imageId]);
    if (stdout.trim() !== imageId+' null' && stdout.trim() !== imageId+' {}') throw new Error('Image must have no declared anonymous volumes.');
    const {stdout: security} = await cli(['info','--format','{{json .SecurityOptions}}']);
    if (!security.includes('name=seccomp,profile=builtin')) throw new Error('Docker built-in seccomp profile required.');
    const probe = async (path: string): Promise<Program> => {
      try {
        const {stdout} = await cli(['run', ...isolation, '--entrypoint=/usr/bin/timeout',imageId,'-s','KILL','2',path,'--version']);
        const version = stdout.trim();
        if (!version || version.includes('\n')) throw new Error('No valid version reported.');
        return {path,version};
      } catch (error) { throw new Error(path + ' unavailable: ' + detail(error)); }
    };
    const [node, python] = await Promise.all([probe(paths.node),probe(paths.python)]);
    return {available:true,imageId,node,python};
  } catch (error) { return {available:false,reason:detail(error)}; }
}

export class ContainerCleanupError extends Error {}
export type ContainerJob = { readonly script: AnalysisSnapshot; readonly inputs: readonly AnalysisSnapshot[];
  readonly outputs: readonly string[]; readonly language: Language; readonly args?: readonly string[] };
type ContainerRun = { readonly cwd: string; readonly timeoutMs: number; readonly signal: AbortSignal;
  readonly access: Extract<AnalysisAccess,{available:true}>; readonly job: ContainerJob;
  started(id: string):void; output(stream: 'stdout'|'stderr', text:string):void; stop(reason:'timed_out'|'output_limit'):void };

// Each mount is exactly one host-owned staged file or the read-only snapshot directory.
// Neither a grant store nor an attempt directory is visible in the guest.
export async function runContainer(run: ContainerRun) {
  const {job,cwd,signal,timeoutMs,access} = run;
  if (/[\x00-\x1f,"\\]/.test(cwd)) throw new Error('Staging path cannot be expressed as a Docker mount.');
  const input = join(cwd,'workspace'), output = join(cwd,'outputs');
  await mkdir(input,{mode:0o755}); await mkdir(output,{mode:0o700});
  try {
    for (const f of [job.script,...job.inputs]) {
      const path = join(input,f.name);
      await writeFile(path,f.bytes,{flag:'wx',mode:0o444}); await chmod(path,0o444);
    }
    // The mount enforces guest immutability. Keep the host owner able to remove crash residue.
    await chmod(input,0o755);
    const mounts = ['--mount','type=bind,source='+input+',target=/workspace,readonly,bind-recursive=disabled'];
    for (const name of job.outputs) {
      const path = join(output,name);
      await writeFile(path,Buffer.from([0]),{flag:'wx',mode:0o600});
      await chmod(path,0o666); // Private ancestor; guest UID must be able to write this single file.
      mounts.push('--mount','type=bind,source='+path+',target=/outputs/'+name);
    }
    signal.throwIfAborted();
    const ready = randomUUID();
    const program = access[job.language].path;
    const args = [...(job.language === 'python' ? ['-I','-B'] : ['--']),'/workspace/'+job.script.name,...job.args ?? []];
    // PID 1 enforces a second, autonomous deadline even if the host or its CLI disappears.
    // On PID 1 exit, Linux terminates all other processes in its private PID namespace.
    const {stdout} = await cli(['create',...isolation,...mounts,'--entrypoint=/bin/sh',access.imageId,'-c',
      'printf "%s\n" "$1" >&2; shift; exec /usr/bin/timeout --foreground -s KILL "$@"','athena',ready,
      String(timeoutMs/1000+1),'/usr/bin/env','-i',...envArgs,program,...args]);
    const id = stdout.trim();
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Docker did not issue a container ID.');
    try {
      signal.throwIfAborted();
      const child = spawn('docker',[...client(),'start','-a',id],{env:cliEnv,signal,killSignal:'SIGKILL',stdio:['ignore','pipe','pipe']});
      // Charge the script deadline to execution, not Docker Desktop startup latency.
      let timer = setTimeout(() => run.stop('timed_out'), 15000);
      try {
        let started = false, preamble = Buffer.alloc(0);
        const decoders = {stdout:new StringDecoder('utf8'),stderr:new StringDecoder('utf8')};
        const sizes = {stdout:0,stderr:0};
        for (const stream of ['stdout','stderr'] as const) child[stream].on('data',(data:Buffer) => {
          let bytes = data;
          if (!started && stream === 'stderr' && preamble.length <= ready.length) {
            const prefix = Buffer.concat([preamble,data]);
            if (prefix.length <= ready.length) { preamble=prefix; return; }
            if (prefix.subarray(0,ready.length+1).toString() === ready+'\n') {
              started=true; clearTimeout(timer); timer=setTimeout(()=>run.stop('timed_out'),timeoutMs);
              run.started(id); bytes=prefix.subarray(ready.length+1);
            } else bytes=prefix;
            preamble=Buffer.alloc(ready.length+1);
          }
          const accepted=bytes.subarray(0,l.streamBytes-sizes[stream]); sizes[stream]+=accepted.length;
          const fragment=decoders[stream].write(accepted); if (fragment) run.output(stream,fragment);
          if (accepted.length < bytes.length) run.stop('output_limit');
        });
        const code = await new Promise<number|null>((resolve,reject) => {
          let failure: Error | undefined;
          child.on('error',error => {failure=error;});
          child.once('close',code => failure && !signal.aborted ? reject(failure) : resolve(code));
        });
        for (const stream of ['stdout','stderr'] as const) {
          const rest=decoders[stream].end(); if(rest) run.output(stream,rest);
        }
        if (!started && !signal.aborted) throw new Error('Container failed before interpreter launch.');
        return {exitCode:code};
      } finally { clearTimeout(timer); }
    } finally {
      // Only this invocation's freshly returned immutable container ID. Never act on journal data.
      try { await cli(['rm','--force','--volumes',id]); }
      catch (error) { throw new ContainerCleanupError('Could not confirm container removal: '+detail(error)); }
    }
  } finally { await rm(input,{recursive:true,force:true}); }
}
