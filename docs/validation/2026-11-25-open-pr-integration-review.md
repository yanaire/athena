# Open pull request integration review — 2026-11-25

## Scope and source boundary

The repository owner requested inspection of all open pull requests and integration
of the changes that pass review. This candidate preserves the source ancestry of
the feature stack and the current main branch, including its multilingual README
editions and repository-maintenance configuration.

This is source integration. The exact candidate still requires the actual Mac and
ChatGPT-account acceptance described in [the research acceptance handoff](../ecosystem/ACCEPTANCE.md)
before it can be treated as accepted for real-account use or distribution. No
live-account test, fresh OAuth consent, second-account switch, or native WebView
acceptance was performed in this Linux review environment. The earlier
[Mac report](../mac-chatgpt-acceptance.md) applies only to its recorded build.

| Source | Reviewed head | Disposition |
| --- | --- | --- |
| Main after repository setup PR #7 | `7a6ea5c7b1a2187f955b4fbd4f7e4c7ee14bbe5a` | Preserve all changes |
| PR #1: baseline, durable publication and retries | `c7434e8ad31d1a4657d57321b21f6c85e5cfac9c` | Included through feature ancestry |
| PR #2: shared MCP and conversation activity | `427cc6eef1a45f945db04c456b8388bed4076014` | Included through feature ancestry |
| PR #3: Mac corrections and acceptance report | `6c3e2698c4c4e892ca6a98200bfbfc708fd5c868` | Already an ancestor of PR #1; not applied twice |
| PR #4: research and approved extensions | `6d38a5c0def941b00fc98f2d9eabdeabe60ab72f` | Included with review corrections below |
| PR #5: workflow DAG and chat behavior | `337259cee5ce8c2c99a900106c273dfafda06029` | Included through feature ancestry |
| PR #6: Windows and Intel Mac | `5bb7a1a59ba99e2bf0890d8ea26627f93e3615cd` | Included with WASI correction; native CI must pass |
| PR #8: GitHub Actions | `9f3d066f87090efbd4c940d143cc9701a3f79cd9` | Reviewed checkout/setup-node pins also applied to new platform jobs |
| PR #9: Pi SDK 1.6.0 | `a96f0ad102d38c92bdb51139f5badb182e299e99` | Included with locked transitive dependencies |
| PR #10: TypeBox 1.4.7 | `4004ef9a87b595bbf33b435b7a475f068d3675f9` | Combined lockfile preserves Pi's own exact TypeBox dependency |
| PR #11: Wasmtime 51 | `460bc9b623bfc412b226fa5b148dc1b15e25533d` | Held; not included |
| PR #12: partial Tauri stack update | `6a1d966d8a40e9a02650634038070203e17f4624` | Held; not included |
| PR #13: getrandom 0.4.3 | `e76714bc8b1d8c50b14b16411808e739957d2a30` | Included; existing lockfile package, direct dependency edge updated |

## Review corrections

1. **Recoverable WASI errors must remain recoverable.** PR #6's bounded-write
   preflight converted Preview 1 errors such as `BADF` into host traps. Preserve
   `types::Error` and lower it to the WASI errno using the pinned Wiggle adapter's
   `downcast()` behavior. Actual host traps still propagate. A real Python/WASI
   regression checks invalid and closed descriptors for both `write` and `pwrite`,
   then requires successful artifact publication. File growth, offset, append,
   descriptor, and memory limits remain in place.
2. **Research recording after a child finishes.** The parent prompt for projects
   with offline execution disabled prohibited further tools after joining, while
   the research instructions required evidence and observation storage. The
   prompt now permits requested recording using available tools. A controlled
   provider test exercises real CSV calculation, evidence and observation
   persistence, and restart, while confirming that independent review and
   artifact transfer remain denied. No permission check changed.
3. **Current skill provenance links.** The loader description now matches the
   metadata-first and selected-body implementation; the runtime and catalog
   links point to existing files. Historical license notes and skill bodies are
   unchanged.
4. **Dependency inventory.** The npm notice row records Pi 1.6.0 and the combined
   lockfile's 124 production entries. The seven bundled Pi WASM payloads and their
   existing QuickJS/Photon package notices are byte-identical to the reviewed
   Pi 1.5.2 installation. Historical distribution limitations remain recorded.

## Dependency updates held for a separate correction

PR #11 updates Cargo to Wasmtime 51.0.0 but leaves 50.0.3 in the host's reported
engine version, the sandbox `--version` output, and the bundle verification
expectation. Its manifest also conflicts with PR #6's platform-specific
dependencies. A coordinated upgrade must update these records and validate the
Preview 1 wrappers and sandbox limits on every supported platform.

PR #12 updates `tauri-codegen` to 2.7.6 while keeping `tauri` at 2.11.6. The new
codegen emits `tauri::image::default_window_icon_from_app_icon_resource()` on
Windows, but that function is absent from the pinned runtime's image module.
This is an upstream source compatibility finding; it was not locally compiled
in this environment. Keep the existing compatible pins until the whole selected
Tauri combination passes the Windows build and installed-app verification.

## Verification record and limits

The individual feature heads were inspected through source, relevant call sites,
existing regression tests, ancestry, and their exact-head GitHub checks. Their
earlier Apple Silicon checks passed; the PR #6 Windows credential test failed
twice before its latest cancellation-reason correction. The latest individual
PR #6 run passed that credential step, but this does not accept the combined
candidate or claim completion of its remaining native steps.

The initial combined dependency and feature tree passed TypeScript checking,
171 selected host/provider/permission/recovery tests, 107 UI integration cases,
and 38 activity/conversation/research/workflow cases, with no failures or skips.
Rebuilding the generated UI produced identical tracked HTML. After applying the
research correction, TypeScript and all six focused research/Pi tests passed,
with no failures or skips. The production npm audit reported zero vulnerabilities
for the combined lockfile at review time.

The review environment has Node 24.22.3 on Linux, without the native Rust/WASI
toolchain. The new Rust change and its real WASI regression therefore require
the final candidate's GitHub native jobs. Merge readiness requires successful
`history-secrets`, `apple-silicon`, `browser-chat`, `desktop-mac-intel`, and
`desktop-windows-x64` checks on the candidate, including the Windows installer
and installed-file checks. Record the actual candidate SHA and CI run in the
integration pull request rather than treating an earlier branch's result as
proof of this tree.

Controlled provider responses validate host, SDK, transport, and persistence
behavior. They do not establish actual model instruction-following quality or
real ChatGPT-account acceptance. CodeQL's temporary “configurations not found”
neutral result is also not a successful security scan.
