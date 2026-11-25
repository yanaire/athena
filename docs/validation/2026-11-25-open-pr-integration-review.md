# Platform stabilization review — 2026-11-25

## Scope and source boundary

The repository owner requested inspection of all open pull requests and integration
of the changes that pass review. **This platform candidate is held in draft PR
[#14](https://github.com/yanaire/athena/pull/14); it is not ready to merge.**
Windows diagnostics exposed functional account-catalog and authentication
failures, not merely insufficient test budgets. PR #6 and its platform changes
are excluded from the separate stable candidate for main. This draft preserves
the reviewed corrections and their evidence for a focused follow-up.

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
| PR #6: Windows and Intel Mac | `5bb7a1a59ba99e2bf0890d8ea26627f93e3615cd` | Held; present only in this draft, excluded from the stable main candidate |
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
5. **New private directories on Windows.** Native Windows diagnostics showed
   that recursive `mkdir` returns an extended-length path while its requested
   destination can use an ordinary drive path. Mixing these namespaces made the
   descendant calculation append a drive name as a child directory. Normalize
   both inputs before calculating descendants; retain every ownership and ACL
   check. A regression creates nested storage with both Windows path forms and
   independently verifies permissions, then verifies that an unsafe existing
   directory is rejected without repair.
6. **Preserve reviewed skill bytes on Windows.** Git's automatic CRLF checkout
   changed the bundled catalog and skill hashes. Explicit LF attributes preserve
   the thirteen reviewed files. Catalog hashes, skill bodies, and integrity
   checks are unchanged. All thirteen hashes were verified with Git's
   `core.autocrlf=true` checkout filters after this correction.
7. **Deterministic fixture cleanup.** Windows cannot unlink an open SQLite
   database. Connection, desktop, recovery, and profile-switch fixtures now close
   owned databases, processes, and servers before removing their directories.
   The profile fixture releases its paused transport before waiting for shutdown.
   The publication rollback fault injector compares the actual parent directory's
   filesystem identity so Windows path aliases cannot bypass the failed-write
   scenario. Native Windows measurements also inform budgets for the three
   integration fixtures that perform repeated real ACL checks; their functional
   assertions and the product's execution limits are preserved.
8. **Bounded build-time Python preparation.** One Intel runner finished the
   pinned standard-library preparation in about 225 seconds; the slower
   integration runner reached the existing 300-second limit. The packaging-only
   subprocess now has a 600-second limit. This does not change the sandbox's
   user-job deadlines or resource limits. The final native build must still pass.
9. **Separate interpreter startup from guest execution.** Intel CI showed cold
   interpreter startup exceeding the original ten-second allowance. Startup now
   has a bounded thirty-second allowance. The independent native wall watchdog
   switches to the original guest timeout at readiness, so slow preparation
   neither consumes nor extends the guest's execution budget. The Node fallback
   follows the same phases with its existing one-second termination allowance.
   A native `SIGXCPU` termination is recorded as a timeout. Six launcher protocol
   regressions verify startup, guest deadlines, and signal classification; native
   compilation and confinement tests remain mandatory.

## Blocking platform findings

The initial combined commit `06e988b0c794493f57d61838ef545851358c4c11`
passed Apple Silicon, browser, and history checks in
[run 45576144327](https://github.com/yanaire/athena/actions/runs/45576144327).
Intel Python preparation exceeded its 300-second build budget. The Windows
suite exposed path/ACL, line-ending, fixture-cleanup, and account timing failures.
The corrections above address specific observed problems, but do not establish
that the supported-platform expansion is ready.

In [Windows diagnostic run 45583582741](https://github.com/yanaire/athena/actions/runs/45583582741),
the controlled ChatGPT-account catalog returned `auth: error` with
`account_catalog_failed` and no account reference. The first credential read
spent about 54 seconds in synchronous Windows permission work, then observed an
already-aborted signal. The test recorded 86 successful background credential
reads during this catalog phase. SDK provider registration starts an unawaited
global model refresh even with `refreshOnCreate: false`; each local credential
read performs fresh PowerShell permission checks. The concurrent scans block the
real catalog deadline. A separate controlled API-key retry failed with
`AUTH_REQUIRED` before its enlarged test budget in
[run 45582055177](https://github.com/yanaire/athena/actions/runs/45582055177).
Extending test timeouts does not correct these functional failures. The relevant
SDK model-runtime and authentication code is byte-identical between the reviewed
Pi 1.5.2 and 1.6.0 packages, so withholding PR #9 does not resolve this problem.

The desktop startup fixture also invokes PowerShell with an intentionally
restricted environment. ACL calls pass with the inherited runner environment
but reach the 15-second deadline with the restricted environment. Restoring
several standard Windows environment groups did not resolve the issue in the
diagnostic runs. `PSModuleAnalysisCachePath` is a follow-up hypothesis, not a
verified fix. The actual Tauri launcher inherits the process environment; these
fixture results do not prove a failure of the installed application's launcher.

Remaining acceptance work: resolve bounded credential/catalog processing without
weakening fresh ownership/ACL checks, make the isolated startup fixture reliable,
and pass the full Windows and Intel native suites on the final platform commit.
The new Rust startup/watchdog correction is locally reviewed but still requires
native compilation and real sandbox tests. Diagnostic workflow replacements and
credential-read instrumentation are kept on a separate diagnostic branch and are
not included in this draft's product or workflow files.

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

After the additional platform corrections, 44 focused host/storage/publication/
connection/account/recovery tests and six launcher protocol tests passed on
Linux with no skips. The desktop and connection cleanup suite also passed all
20 cases. These local results do not supersede the Windows authentication
failures above.

The review environment has Node 24.22.3 on Linux, without the native Rust/WASI
toolchain. The new Rust change and its real WASI regression therefore require
the final platform candidate's GitHub native jobs. This draft remains blocked.
Its eventual merge readiness requires successful
`history-secrets`, `apple-silicon`, `browser-chat`, `desktop-mac-intel`, and
`desktop-windows-x64` checks on the candidate, including the Windows installer
and installed-file checks. Record the actual candidate SHA and CI run in the
integration pull request rather than treating an earlier branch's result as
proof of this tree.

Controlled provider responses validate host, SDK, transport, and persistence
behavior. They do not establish actual model instruction-following quality or
real ChatGPT-account acceptance. The initial integration head's four CodeQL
language analyses completed successfully, and the aggregate check reported no
new alerts in changed code. This does not dismiss the repository's existing
alerts or substitute for checks on a later candidate.
