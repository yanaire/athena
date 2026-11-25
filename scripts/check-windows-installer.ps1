$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Installer acceptance requires Windows.' }

# This script is for a disposable CI runner. It never targets a user's existing
# Athena installation, publishes a release or changes Windows trust settings.
if ($env:CI -ne 'true' -or -not $env:RUNNER_TEMP) {
  throw 'Run installer acceptance on an isolated CI runner with RUNNER_TEMP.'
}
$repo = Split-Path -Parent $PSScriptRoot
$installers = @(Get-ChildItem -LiteralPath (Join-Path $repo 'src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis') -Filter '*-setup.exe')
if ($installers.Count -ne 1) { throw 'Expected exactly one freshly built NSIS installer.' }
$destination = Join-Path $env:RUNNER_TEMP ('athena-install-' + [Guid]::NewGuid().ToString('N'))
if (Test-Path -LiteralPath $destination) { throw 'Installer destination must not already exist.' }

# /D must be the last NSIS argument. NSIS reads the remaining command line as
# the path, including spaces, so do not surround that value in embedded quotes.
$installer = Start-Process -FilePath $installers[0].FullName -ArgumentList "/S /D=$destination" -Wait -PassThru
if ($installer.ExitCode -ne 0) { throw "NSIS installation failed: $($installer.ExitCode)." }
try {
  foreach ($relative in @('athena-desktop.exe', 'athena-node.exe', 'athena-sandbox.exe', 'host/runtime/server.ts')) {
    if (-not (Test-Path -LiteralPath (Join-Path $destination $relative) -PathType Leaf)) {
      throw "Installed component is missing: $relative."
    }
  }
  & node (Join-Path $repo 'scripts/check-desktop-bundle.mjs') --verify-only $destination
  if ($LASTEXITCODE -ne 0) { throw 'Installed application failed functional verification.' }
  $digest = (Get-FileHash -LiteralPath $installers[0].FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  Write-Host "Installed NSIS package verified. SHA-256: $digest"
} finally {
  # The runner owns this uniquely named installation. Let NSIS remove its own
  # registration and shortcuts; the VM is discarded at the end of the job.
  $uninstaller = Join-Path $destination 'uninstall.exe'
  if (Test-Path -LiteralPath $uninstaller) {
    $removed = Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait -PassThru
    if ($removed.ExitCode -ne 0) { Write-Warning "NSIS cleanup returned $($removed.ExitCode)." }
  }
}
