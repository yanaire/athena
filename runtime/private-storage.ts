import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, type Stats } from 'node:fs';
import { isAbsolute, join, resolve, sep, win32 } from 'node:path';

// Node's Windows mode bits do not express ownership or a DACL. This fixed,
// host-owned script uses SIDs, not localized account names, and receives paths
// only as JSON on stdin. No user text is interpreted as PowerShell source.
const aclScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$path = [string]$request.path
if (-not [IO.Path]::IsPathRooted($path)) { throw 'Expected an absolute path' }
$item = Get-Item -LiteralPath $path -Force
if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse points are not private storage' }
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
if ($request.operation -eq 'protect') {
  if ($item.PSIsContainer) {
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
  } else {
    $acl = New-Object Security.AccessControl.FileSecurity
    $inheritance = [Security.AccessControl.InheritanceFlags]::None
  }
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($principal in @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')) {
    $identity = New-Object Security.Principal.SecurityIdentifier($principal)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $path -AclObject $acl
} elseif ($request.operation -ne 'check') { throw 'Invalid operation' }
$acl = Get-Acl -LiteralPath $path
if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Unexpected owner' }
$allowed = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
$ownerAccess = 0
foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow) {
    if ($allowed -notcontains $rule.IdentityReference.Value) { throw 'Access is granted outside the private owner and OS administrators' }
    if ($rule.IdentityReference.Value -eq $sid.Value) { $ownerAccess = $ownerAccess -bor [int]$rule.FileSystemRights }
  } elseif ($rule.IdentityReference.Value -eq $sid.Value) { throw 'Owner access is denied' }
}
if (($ownerAccess -band [int][Security.AccessControl.FileSystemRights]::FullControl) -ne [int][Security.AccessControl.FileSystemRights]::FullControl) { throw 'Missing owner access' }
[Console]::Out.Write('ATHENA_PRIVATE_STORAGE_OK')
`;

export function windowsPowerShell(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot || !win32.isAbsolute(systemRoot)) throw new Error('Windows system directory is unavailable.');
  return win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function windowsAcl(path: string, operation: 'check' | 'protect'): void {
  if (process.platform !== 'win32') throw new Error('Windows ACL operations require Windows.');
  if (!isAbsolute(path) || path.includes('\0')) throw new Error('Expected an absolute storage path.');
  const response = execFileSync(windowsPowerShell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(aclScript, 'utf16le').toString('base64')], {
    input: JSON.stringify({ path, operation }), encoding: 'utf8', timeout: 15_000,
    windowsHide: true, maxBuffer: 16 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (response !== 'ATHENA_PRIVATE_STORAGE_OK') throw new Error('Private Windows storage could not be verified.');
}

export function assertWindowsPrivate(path: string): void { windowsAcl(path, 'check'); }

/** Only for a newly created empty directory or unpublished file. Never repair an existing store. */
export function setWindowsPrivate(path: string): void { windowsAcl(path, 'protect'); }

export function hasPrivatePermissions(path: string, info: Stats, exactMode?: number): boolean {
  if (info.isSymbolicLink()) return false;
  if (process.platform !== 'win32') {
    return info.uid === process.getuid?.() && (exactMode === undefined ? (info.mode & 0o077) === 0 : (info.mode & 0o7777) === exactMode);
  }
  try { assertWindowsPrivate(path); } catch { return false; }
  // Read-only immutable grants retain the Windows read-only file attribute.
  return info.isDirectory() || exactMode === undefined || Boolean(info.mode & 0o200) === Boolean(exactMode & 0o200);
}

export function createPrivateDirectory(path: string): void {
  const absolute = resolve(path);
  const created = mkdirSync(absolute, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32' && created) {
    setWindowsPrivate(created);
    let next = created;
    // mkdir may return a \\?\-prefixed path. Compare both paths in the same
    // namespace so the drive is never mistaken for a newly created child.
    const descendants = win32.relative(win32.toNamespacedPath(created), win32.toNamespacedPath(absolute));
    for (const part of descendants.split(sep).filter(Boolean)) {
      next = join(next, part);
      setWindowsPrivate(next);
    }
  }
  const info = lstatSync(absolute);
  if (!info.isDirectory() || !hasPrivatePermissions(absolute, info)) throw new Error('Expected private storage owned by the current user.');
}
