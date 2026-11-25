import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, lstat, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const windows = process.platform === 'win32';
export const posixSignalsOnly = windows ? 'SIGSTOP and process-group signals are POSIX-specific; owned live-worker cancellation is also tested without those signals.' : false;

// Only OS facilities are inherited by fixtures that deliberately exclude user
// provider configuration. The isolated fixture supplies HOME/USERPROFILE.
export function systemEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC']
    .flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
}

function powershell(path: string, body: string): string {
  const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // A PowerShell 7 parent advertises incompatible module paths to Windows
  // PowerShell 5.1. Inspect ACLs with the fixed OS installation's own modules.
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PSMODULEPATH'));
  return execFileSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; $path=$env:ATHENA_TEST_ACL_PATH; " + body], {
    encoding: 'utf8', windowsHide: true,
    env: { ...environment, PSModulePath: join(dirname(executable), 'Modules'), ATHENA_TEST_ACL_PATH: path },
  }).trim();
}

interface Acl {
  owner: string;
  current: string;
  protected: boolean;
  rules: { sid: string; allow: boolean; inherited: boolean; rights: number }[];
}

function acl(path: string): Acl {
  return JSON.parse(powershell(path, `
    $a=Get-Acl -LiteralPath $path;
    $sid=[System.Security.Principal.SecurityIdentifier];
    $rules=@($a.GetAccessRules($true,$true,$sid) | ForEach-Object {
      @{sid=$_.IdentityReference.Value;allow=($_.AccessControlType -eq 'Allow');inherited=$_.IsInherited;rights=[int]$_.FileSystemRights}
    });
    @{owner=$a.GetOwner($sid).Value;current=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
      protected=$a.AreAccessRulesProtected;rules=$rules} | ConvertTo-Json -Depth 4 -Compress
  `));
}

/** Independent OS-level privacy witness; does not call production validators. */
export async function assertPrivatePermissions(path: string, mode: number): Promise<void> {
  const info = await lstat(path);
  assert.equal(info.isSymbolicLink(), false);
  if (!windows) {
    assert.equal(info.mode & 0o777, mode);
    if (process.getuid) assert.equal(info.uid, process.getuid());
    return;
  }
  const observed = acl(path);
  assert.equal(observed.owner, observed.current, 'The fixture must be owned by the current account.');
  const allowed = new Set([observed.current, 'S-1-5-18', 'S-1-5-32-544']);
  // A child may inherit from a protected private directory. Inspect the effective
  // identities rather than mistaking inheritance itself for public access.
  const fullControl = 0x1f01ff;
  const ownerRights = observed.rules.filter(rule => rule.allow && rule.sid === observed.current)
    .reduce((rights, rule) => rights | rule.rights, 0);
  assert.equal(ownerRights & fullControl, fullControl);
  assert.ok(observed.rules.every(rule => !rule.allow || allowed.has(rule.sid)),
    'Only the current account, SYSTEM and Administrators may receive an allow ACE.');
  if (mode === 0o400) assert.equal(info.mode & 0o222, 0, 'Published artifact must remain read-only.');
}

/** Widen actual access, rather than pretending chmod emulates a Windows DACL. */
export async function makePublicPermissions(path: string, mode = 0o644): Promise<void> {
  await chmod(path, mode);
  if (windows) powershell(path, `
    $a=Get-Acl -LiteralPath $path;
    $world=[System.Security.Principal.SecurityIdentifier]::new('S-1-1-0');
    $rule=[System.Security.AccessControl.FileSystemAccessRule]::new($world,
      [System.Security.AccessControl.FileSystemRights]::Read,
      [System.Security.AccessControl.AccessControlType]::Allow);
    $a.AddAccessRule($rule); Set-Acl -LiteralPath $path -AclObject $a
  `);
}

export async function assertPublicPermissions(path: string, mode = 0o644): Promise<void> {
  if (!windows) assert.equal((await lstat(path)).mode & 0o777, mode);
  else assert.ok(acl(path).rules.some(rule => rule.allow && rule.sid === 'S-1-1-0'),
    'Production validation must leave the unsafe fixture permissions untouched.');
}

/** Repair synthetic test fixtures only, never an existing user object. */
export async function restorePrivatePermissions(path: string, mode: number): Promise<void> {
  if (windows) powershell(path, `
    $user=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;
    $directory=(Get-Item -LiteralPath $path).PSIsContainer;
    if($directory){$a=[System.Security.AccessControl.DirectorySecurity]::new()}
    else{$a=[System.Security.AccessControl.FileSecurity]::new()};
    $a.SetOwner($user); $a.SetAccessRuleProtection($true,$false);
    $inherit=if($directory){[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{[System.Security.AccessControl.InheritanceFlags]::None};
    $rule=[System.Security.AccessControl.FileSystemAccessRule]::new($user,
      [System.Security.AccessControl.FileSystemRights]::FullControl,$inherit,
      [System.Security.AccessControl.PropagationFlags]::None,
      [System.Security.AccessControl.AccessControlType]::Allow);
    $a.AddAccessRule($rule); Set-Acl -LiteralPath $path -AclObject $a
  `);
  await chmod(path, mode);
}

export async function directoryLink(target: string, path: string): Promise<void> {
  await symlink(target, path, windows ? 'junction' : 'dir');
}

export function assertKilled(code: number | null, signal: NodeJS.Signals | null, expected: NodeJS.Signals = 'SIGKILL', diagnostic?: string): void {
  if (windows && signal === null) assert.equal(code, 1, diagnostic);
  else assert.deepEqual([code, signal], [null, expected], diagnostic);
}
