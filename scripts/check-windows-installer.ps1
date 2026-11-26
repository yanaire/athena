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
$requiredFiles = @('athena-desktop.exe', 'athena-node.exe', 'athena-sandbox.exe', 'host/runtime/server.ts',
  'host/runtime/windows-private-storage.exe', 'host/runtime/windows-private-storage.exe.config', 'uninstall.exe')
$verificationFailure = $null
$cleanupFailure = $null
try {
  foreach ($relative in $requiredFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $destination $relative) -PathType Leaf)) {
      throw "Installed component is missing: $relative."
    }
  }
  & node (Join-Path $repo 'scripts/check-desktop-bundle.mjs') --verify-only $destination
  if ($LASTEXITCODE -ne 0) { throw 'Installed application failed functional verification.' }
  & node (Join-Path $repo 'scripts/smoke-installed-desktop.mjs') $destination
  if ($LASTEXITCODE -ne 0) { throw 'Installed application failed native WebView verification.' }
  $digest = (Get-FileHash -LiteralPath $installers[0].FullName -Algorithm SHA256).Hash.ToLowerInvariant()
} catch {
  $verificationFailure = $_
} finally {
  try {
    # Only the runner's uniquely named installation is in scope. NSIS performs
    # removal itself; never delete leftover files to turn a failed check green.
    $uninstaller = Join-Path $destination 'uninstall.exe'
    if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
      throw 'The installed NSIS uninstaller is missing.'
    }
    $cleanupTimer = [System.Diagnostics.Stopwatch]::StartNew()
    $removed = Start-Process -FilePath $uninstaller -ArgumentList '/S' -PassThru
    if (-not $removed.WaitForExit(60000)) { throw 'NSIS uninstaller did not exit within 60 seconds.' }
    if ($removed.ExitCode -ne 0) { throw "NSIS uninstaller failed: $($removed.ExitCode)." }

    # NSIS may copy its uninstaller to TEMP and finish removal in a child
    # process. Observe the actual installed files, including its own executable.
    # The host directory check covers all bundled resources, not just entrypoints.
    do {
      $remaining = @(@($requiredFiles + 'host') | Where-Object {
        Test-Path -LiteralPath (Join-Path $destination $_)
      })
      if ($remaining.Count -eq 0) { break }
      if ($cleanupTimer.Elapsed.TotalSeconds -ge 60) {
        throw "NSIS removal exceeded 60 seconds; installed paths remain: $($remaining -join ', ')."
      }
      Start-Sleep -Milliseconds 250
    } while ($true)
  } catch {
    $cleanupFailure = $_
  }
}
if ($verificationFailure -and $cleanupFailure) {
  throw [System.AggregateException]::new(
    "Installed application verification failed: $($verificationFailure.Exception.Message) Removal also failed: $($cleanupFailure.Exception.Message)",
    [System.Exception[]]@($verificationFailure.Exception, $cleanupFailure.Exception))
}
if ($verificationFailure) { throw $verificationFailure }
if ($cleanupFailure) { throw $cleanupFailure }
Write-Host "Verified $($installers[0].Name) and installed payload removal. SHA-256: $digest"
