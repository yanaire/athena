import { spawn } from 'node:child_process';
import { windowsPowerShell } from './private-storage.ts';

export const nativeBrowserAvailable = () => ['darwin', 'win32'].includes(process.platform);

/** Dedicated account launcher; never a general Browser-panel capability. */
export async function openAccountBrowser(raw: string): Promise<boolean> {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password ||
    !['auth.openai.com', 'chatgpt.com', 'openrouter.ai'].includes(url.hostname)) return false;
  let command: string;
  let args: string[];
  let input: string;
  if (process.platform === 'darwin') {
    command = '/usr/bin/osascript'; args = ['-l', 'JavaScript', '-'];
    input = `ObjC.import('AppKit'); if (!$.NSWorkspace.sharedWorkspace.openURL($.NSURL.URLWithString(${JSON.stringify(raw)}))) throw Error('Browser unavailable');\n`;
  } else if (process.platform === 'win32') {
    command = windowsPowerShell();
    const script = `$ErrorActionPreference='Stop'; [Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false); $request=[Console]::In.ReadToEnd() | ConvertFrom-Json; $target=[Uri]$request.url; if ($target.Scheme -ne 'https' -or @('auth.openai.com','chatgpt.com','openrouter.ai') -notcontains $target.Host) { throw 'Invalid account URL' }; Start-Process -FilePath $target.AbsoluteUri -ErrorAction Stop`;
    args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
    input = JSON.stringify({ url: raw });
  } else return false;
  // OAuth hints travel over stdin, not this launcher's argv, renderer, logs,
  // or shell source. The system's browser handler controls its own process args.
  return new Promise(resolve => {
    const browser = spawn(command, args, { timeout: 10_000, windowsHide: true, shell: false, stdio: ['pipe', 'ignore', 'ignore'] });
    browser.once('error', () => resolve(false));
    browser.once('close', code => resolve(code === 0));
    browser.stdin.on('error', () => resolve(false));
    browser.stdin.end(input);
  });
}
