import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildEnvironment, resolveDesktopPlatform } from './desktop-platform.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

export function desktopBuildPlan(args, host = {}) {
  let target;
  let localChatGPT = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--local-chatgpt' && !localChatGPT) localChatGPT = true;
    else if (arg === '--target' && target === undefined && args[index + 1] && !args[index + 1].startsWith('--')) target = args[++index];
    else throw new Error('Usage: npm run desktop:build -- [--target <native Rust triple>] [--local-chatgpt]');
  }
  const platform = resolveDesktopPlatform({ ...host, ...(target ? { target } : {}) });
  const tauriArgs = ['build', '--target', platform.target, '--bundles', platform.bundle];
  if (localChatGPT) tauriArgs.push('--config', 'src-tauri/tauri.local-chatgpt.conf.json', '--no-sign');
  tauriArgs.push('--', '--locked');
  return { platform, localChatGPT, tauriArgs };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const plan = desktopBuildPlan(process.argv.slice(2));
  const env = { ...buildEnvironment(), ATHENA_DESKTOP_TARGET: plan.platform.target,
    ATHENA_BUILD_CHATGPT_LOCAL: plan.localChatGPT ? '1' : '0' };
  execFileSync(process.execPath, [fileURLToPath(new URL('../node_modules/@tauri-apps/cli/tauri.js', import.meta.url)), ...plan.tauriArgs],
    { cwd: root, env, stdio: 'inherit' });
  execFileSync(process.execPath, [fileURLToPath(new URL('./check-desktop-bundle.mjs', import.meta.url))],
    { cwd: root, env, stdio: 'inherit' });
}
