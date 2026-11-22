# Development

This document describes a local source build. Developer ID signing, notarization, and installation on another Mac are deferred desktop-release work, not requirements for the current source preview. No virtual machine is needed for this preview.

The Apple Silicon build uses Node 24.22.3, npm, Python 3 for UI assembly, Xcode Command Line Tools, `curl`, `tar`, `unzip`, and Rust 1.99.1 with the `aarch64-apple-darwin` target. npm and both Cargo graphs use lockfiles. Upstream Node and WASI archives are checksum pinned. The [workflow](../.github/workflows/verify.yml) runs these checks without Docker:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm run analysis:prepare
npm test
npm run desktop:build
```

Regenerate with `python3 athena-backend-handoff/athena-codex-ui/build.py`. The [UI contract commands](../athena-backend-handoff/START-HERE.md#기존-ui-확인-명령) run independently of Finder and real-model testing. Desktop preparation consumes the generated HTML. Keep local workspaces, credentials, bundled apps and raw QA evidence out of Git.

For a distribution review build, start in a clean source directory and run the desktop build with the path mappings below. Both Rust executables otherwise can contain the build account's home path in compiled source locations. Cargo passes each mapping as a single argument even if its path contains spaces. Use a clean shell for this recipe; it supplies the build's Rust flags.

```sh
(
  umask 022
  root=$(pwd -P)
  CARGO_ENCODED_RUSTFLAGS="--remap-path-prefix=$HOME=/build/home$(printf '\037')--remap-path-prefix=$root=/build/athena" npm run desktop:build
)
```

Keep the enclosing work directory private (`0700`), but allow read and traversal permissions on the distributable files at build time. A `077` build umask made the first remapped review app inaccessible to other users. Check the final ZIP's modes as well as its entry names and uncompressed contents for the original home and build directory prefixes. The remapped review build does not change previously archived candidates.

The local bundle check signs the WASI helper with Hardened Runtime and no entitlements, then exercises both guests through the bundled Node host. The helper uses Wasmtime's Pulley interpreter. The local Node executable retains its upstream signature. When preparing a Developer ID build, verify each nested executable separately: re-signing Node under Hardened Runtime without `com.apple.security.cs.allow-jit` prevents V8 from starting. Grant JIT only to Node; do not apply a bundle-wide entitlement file. Tauri CLI 2.12.6 uses the same configured entitlement file for every signing target, so a release with per-executable entitlements needs a separate signing step before notarization.

The bundled Pi TUI ARM64 `darwin-platform.node` prebuild has an ad-hoc signature. A JIT-only hardened Node test copy could start but could not load that module. For release, sign the native module with the app's Developer ID team before sealing the app, and verify it loads with library validation still enabled. This same-team path requires a Developer ID acceptance run. Check both WASI guests and the app after signing and before submitting for notarization. See the [release checklist](release-checklist.md).

To test an existing trusted bundle without re-signing it or requiring the original build directory, run `node scripts/check-desktop-bundle.mjs --verify-only "/path/to/Athena.app"`. On a Mac without development tools, use the app's own Node and a copy of the script:

```sh
app="/path/to/Athena.app"
"$app/Contents/MacOS/athena-node" /path/to/check-desktop-bundle.mjs --verify-only "$app"
```

Use only a bundle the Mac already permits you to run. The checker verifies the seal and bundled WASM digests and runs Python and QuickJS in a disposable workspace. After saving a profile with a generated credential, it closes the bundled Node host's startup pipe before delivering the vault key. It checks that startup fails without a readiness frame and that the vault bytes and `0600` mode survive. An authenticated restart then verifies the saved profile, streaming, and tool calls against a loopback fixture. The checker does not launch Finder or test the login Keychain.

Run `node scripts/check-desktop-bundle.mjs --pre-notarization "/path/to/Athena.app"` on an already signed candidate before submitting it. This checks Developer ID signatures, the signing team, Hardened Runtime, entitlements, and the ARM64 Pi module before running the same functional checks. It does not sign, submit, or staple the app. After notarization and stapling, run the command with `--release` instead, on a Mac with the Apple command line tools. This also checks the stapled ticket and Gatekeeper before executing bundled code. Only then run the [clean Mac acceptance](installation.md).
