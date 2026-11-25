# Apple Silicon source integration review — 2026-11-25

## Scope and source boundary

The repository owner requested inspection of the open pull requests and
integration of the changes that pass review. After native platform checks
identified Windows and Intel Mac failures, the stable integration was
restricted to the Apple Silicon feature stack and compatible dependency updates.

This candidate combines main after repository setup PR #7 with PR #5 and its
PR #1–#4 ancestors. It preserves main's repository-maintenance configuration and
the original bodies of its eight translated READMEs, adding a dated scope note
to each translation. PR #6 and PR #14 commits are excluded from this candidate's
ancestry. Selected portable corrections from the earlier combined review are
applied as explicit file changes, as described below.

This is source integration, not actual-account acceptance or a public release.
The exact candidate still requires the actual Mac and ChatGPT-account acceptance
described in [the research acceptance handoff](../ecosystem/ACCEPTANCE.md).
No live-account test, fresh OAuth consent, second-account switch or native WebView
acceptance was performed in this Linux review environment. The earlier
[Mac report](../mac-chatgpt-acceptance.md) applies only to its recorded build.

| Source | Reviewed or observed head | Disposition |
| --- | --- | --- |
| Main after repository setup PR #7 | `7a6ea5c7b1a2187f955b4fbd4f7e4c7ee14bbe5a` | Included; preserve repository settings files and translations |
| PR #1: baseline, durable publication and retries | `c7434e8ad31d1a4657d57321b21f6c85e5cfac9c` | Included through PR #5 ancestry |
| PR #2: shared MCP and conversation activity | `427cc6eef1a45f945db04c456b8388bed4076014` | Included through PR #5 ancestry |
| PR #3: Mac corrections and acceptance report | `6c3e2698c4c4e892ca6a98200bfbfc708fd5c868` | Already an ancestor of PR #1; not applied twice |
| PR #4: research and approved extensions | `6d38a5c0def941b00fc98f2d9eabdeabe60ab72f` | Included through PR #5 ancestry, with the portable correction below |
| PR #5: workflow DAG and chat behavior | `337259cee5ce8c2c99a900106c273dfafda06029` | Included feature-stack parent |
| PR #6: Windows and Intel Mac | Initial review `5bb7a1a59ba99e2bf0890d8ea26627f93e3615cd`; follow-ups `5b2f01f9e769a27dc8d089c29ecfbc3a8aea0ac2` and `2f4f83809c773ed31b1dea6742c65740e70d76a9` | Held separately; latest account regressions pass, but the platform expansion needs its own complete review and native integration acceptance |
| PR #8: GitHub Actions | `9f3d066f87090efbd4c940d143cc9701a3f79cd9` | Reviewed checkout/setup-node pins applied to the three existing jobs |
| PR #9: Pi SDK 1.6.0 | `a96f0ad102d38c92bdb51139f5badb182e299e99` | Included with locked transitive dependencies |
| PR #10: TypeBox 1.4.7 | `4004ef9a87b595bbf33b435b7a475f068d3675f9` | Included; combined lockfile preserves Pi's own exact TypeBox dependency |
| PR #11: Wasmtime 51 | `460bc9b623bfc412b226fa5b148dc1b15e25533d` | Held; not included |
| PR #12: partial Tauri stack update | `6a1d966d8a40e9a02650634038070203e17f4624` | Held; not included |
| PR #13: getrandom 0.4.3 | `e76714bc8b1d8c50b14b16411808e739957d2a30` | Included; existing lockfile package, direct dependency edge updated |
| PR #14: earlier combined integration | Initial review head `06e988b0c794493f57d61838ef545851358c4c11`; preserved platform draft `6f3dee5aab0918c3b96b5fd6245d81fa0d010ce7` | Retained as a separate blocked platform stabilization draft; neither head is imported |
| PR #15: Windows storage diagnostic | Initial `61ffde32e7eedc1fbfdfedfd62c38cce38f96152`; latest observed `50b686d0872cc1f9e0889f1615fed36dcb61441f` | Diagnostic-only draft targeting the platform branch; excluded |

## Portable review corrections included

1. **Research recording after a child finishes.** The parent prompt for projects
   with offline execution disabled prohibited further tools after joining,
   while the research instructions required evidence and observation storage.
   The prompt now permits requested recording using available tools. Its
   controlled-provider regression exercises real CSV calculation, evidence and
   observation persistence, and restart, while confirming that independent
   review and artifact transfer remain denied. No permission check changed.
2. **Current skill provenance links.** The loader description matches the
   metadata-first and selected-body implementation; the runtime and catalog
   links point to existing files. Historical license notes and skill bodies are
   preserved.
3. **Dependency inventory.** The npm notice row records Pi 1.6.0 and the combined
   lockfile's 124 production entries. The seven bundled Pi WASM payloads and
   their existing QuickJS/Photon package notices were byte-identical to the
   reviewed Pi 1.5.2 installation. Historical distribution limitations remain
   recorded in the [third-party notices](../../THIRD_PARTY_NOTICES.md).
4. **Stable skill bytes at checkout.** Git attributes retain LF line endings for
   `skills/catalog.json` and bundled `SKILL.md` files, whose reviewed bytes are
   checked by hashes. The catalog hashes and skill bodies are unchanged.

These portable corrections are independent of the Windows/Intel implementation.
The platform-specific preparation executable,
packaging scripts, runtime deadline changes, Windows storage/ACL fixes and
diagnostic tests are not part of this candidate.

## Follow-up review: saved MCP credentials after a failed recheck

The automatic review of the first stable commit identified
[a connection-recheck regression](https://github.com/yanaire/athena/pull/16#discussion_r4693075481):
the saved bearer credential reference was stored only inside a successful
verification. A transient probe failure removed that verification and its
reference, so later checks without a newly entered token could not find the
credential that was still present in the host store.

The correction keeps per-server credential references separately from current
verification status. A failed probe still invalidates verification and disables
the plugin, while a later probe of the same configuration can reuse its saved
credential. Existing verification-only saved states retain their reference when
read. This is not a recovery mechanism for references already lost before the
upgrade: unrelated or orphaned vault entries are never guessed or rebound.

The public snapshot exposes only the `credentialConfigured` boolean, not the
reference or token. Replacing a plugin configuration clears its current saved
references. Historical run pins retain their original immutable credential
binding, and a deleted credential remains unavailable rather than silently
switching to another one. Regression coverage exercises a real loopback MCP
transport failure, restart and token-free recheck, together with stored-state
compatibility and configuration-isolation boundaries.

Both new regressions failed on the original production code and passed after
the correction. All eleven tests in the extension store and manager-extension
files passed, including existing immutable-pin, manual-retry, namespace and
cross-project isolation cases. TypeScript and independent source reviews passed.

## Workflow trigger correction

The corrected source commit `48e66d223ab2355cf8635e3d69232de2988f01bc` passed
every required PR job in
[run 45590711397](https://github.com/yanaire/athena/actions/runs/45590711397),
including **259/259 host tests with zero failures or skips**, all UI groups and
the arm64 app bundle. Its four CodeQL analyses also passed in
[run 45590700510](https://github.com/yanaire/athena/actions/runs/45590700510),
with no new alerts in changed code. Nevertheless, GitHub rejected the merge
because all three required check names also had cancelled results from the
duplicate [push run 45590698489](https://github.com/yanaire/athena/actions/runs/45590698489).
The branch-only concurrency group had allowed the PR run to cancel the push run.

The workflow now verifies pushes to `main` and every normally triggered pull
request, without branch/path filters or conditional skips on the PR jobs.
Concurrency groups include the event name and PR number or ref, so PR work and
main-push work cannot cancel each other. Feature-branch pushes no longer create
a duplicate Verify run before the PR event. All three jobs, their steps, action
pins, permissions and required branch-protection checks are unchanged. The
official actionlint 1.7.12 release was checksum-verified and the corrected
workflow passed it; the job definitions were also compared byte-for-byte.
This workflow correction needs successful checks on its own new candidate SHA.

## Why the platform work remains separate

### Windows

The [Windows profile diagnostic](https://github.com/yanaire/athena/actions/runs/45583582741/job/139099414783)
recorded a first credential read taking about 54.17 seconds against a 10-second
product request deadline. A subsequent account read encountered the already
expired signal and the operation returned `account_catalog_failed` without an
account. The same diagnostic observed 86 background credential reads during
provider registration. The Windows store's per-read PowerShell ACL checks
amplified the SDK's provider-registration refresh activity.

The relevant installed Pi model-runtime, model registration and auth-resolution
files were byte-identical between 1.5.2 and 1.6.0. This diagnosis therefore does
not establish a new regression introduced by PR #9. Separate desktop startup
diagnostics also found PowerShell behavior differed with the restricted child
environment; the proposed environment-cache explanation remains unverified.
Platform fixes and unfinished diagnosis stay with PR #6, draft PR #14 and the
diagnostic draft PR #15.

The failure was reproduced in the intermediate PR #6 and PR #15 revisions, but
later concurrent work in PR #6 changed the implementation. Head
`2f4f83809c773ed31b1dea6742c65740e70d76a9` replaces repeated PowerShell ACL
processes with a fixed helper compiled at build time, retaining fresh owner/DACL
checks, and removes an unused global OAuth registration that initiated broad
credential scans. The original authentication deadlines remain unchanged.
In [diagnostic run 45590297692](https://github.com/yanaire/athena/actions/runs/45590297692),
the account profile/restart regression passed under both Bash and PowerShell
(about 22.90 and 20.58 seconds for the whole test), as did the twelve storage and
credential checks. **The earlier account failure must not be reported as an
unresolved failure of that newer source.**

The latest [PR #15 diagnostic run 45591462608](https://github.com/yanaire/athena/actions/runs/45591462608)
also passed both shells, but covers only the forced-parent-termination and
workspace-recovery regression. The latest full PR #6
[native run 45590964160](https://github.com/yanaire/athena/actions/runs/45590964160)
was still in progress at this follow-up review checkpoint. The new helper,
packaging and platform expansion remain outside this Apple Silicon integration
and need their own complete source and native/installed-app acceptance.

The earlier platform corrections and failure evidence remain in
[draft PR #14](https://github.com/yanaire/athena/pull/14) at
`6f3dee5aab0918c3b96b5fd6245d81fa0d010ce7`. That draft is a separate historical
review/fix candidate, not proof of acceptance for the newer PR #6 source.

### Intel Mac

The [earlier combined Intel job](https://github.com/yanaire/athena/actions/runs/45576144327/job/139074484621)
finished its Rust release build but hit the five-minute timeout in the build-only
Python standard-library preparation executable. The
[original PR #6 Intel job](https://github.com/yanaire/athena/actions/runs/45573780437/job/139066566519)
completed that preparation stage, then failed host tests: normal Python work and
an output-overflow test reached a time limit, and a native `SIGXCPU` termination
was recorded as `failed` instead of `timed_out`.

The platform review identified startup taking longer than the runtime's
ten-second allowance and a missing CPU-limit signal classification. Draft
corrections separate bounded startup from the unchanged guest execution
deadline; they do not constitute completed Intel acceptance. Neither those
corrections nor the PR #6 WASI portability changes are copied into this Apple
Silicon candidate.

## Dependency updates held for a separate correction

PR #11 updates Cargo to Wasmtime 51.0.0 but leaves 50.0.3 in the host's reported
engine version, the sandbox `--version` output and the bundle verification
expectation. A coordinated upgrade must update these records and validate the
sandbox ABI and limits. This candidate retains the existing Wasmtime pins.

PR #12 updates `tauri-codegen` to 2.7.6 while keeping `tauri` at 2.11.6. The new
codegen emits `tauri::image::default_window_icon_from_app_icon_resource()` on
Windows, but that function is absent from the pinned runtime's image module.
This is an upstream source compatibility finding, not a locally compiled
Windows result. Keep the compatible selected stack until a coordinated update
passes the relevant native build and installed-app verification.

## Verification record and limits

The earlier feature-head reviews inspected source, relevant call sites, existing
regressions, ancestry and exact-head GitHub checks. Their results and the earlier
combined candidate's local test counts are historical evidence; they are not a
successful verification run for this newly separated tree.

The separated candidate was verified locally with Node 24.22.3 on Linux:

| Check | Result |
| --- | --- |
| Locked npm install, with lifecycle scripts disabled | Passed; 127 packages installed |
| `npm run check` | Passed |
| Generated UI rebuild | Passed; 1,579,581 bytes, identical to PR #5's tracked HTML |
| Selected host/provider/permission/recovery coverage across 32 files | 223/223 passed; no reported failures or skips, about 31.2 seconds |
| UI integration suite | 107/107 passed |
| UI activity, conversation, extensions, surfaces and workflow suite | 38/38 passed |
| Seven additional UI contract files selected by CI | 101/101 passed |
| `npm audit --omit=dev` | Zero reported vulnerabilities at review time |

The local host selection excluded `jobs-analysis.test.ts`,
`workflow-settling.test.mjs`, `desktop-host.test.ts` and `host-feed.test.ts`.
It also excluded two cases in `manager-orchestration.test.ts` using a local
`--test-skip-pattern`: "offline analysis joins source and both outputs with
immutable input provenance after restart" and "grant transfer admits one sibling
artifact only after explicit follow-up; parent reads verified bytes". The test
source and CI selection are unchanged; these exclusions are not successful
native validation.

An initial broader Linux host selection ran 226 cases, with 223 passes and three
failures in `host-feed` and those two manager cases. The app-owned WASI runtime
had not been prepared, so the required analysis capability/tools were absent.
After correcting the local selection, the 223 selected cases passed cleanly.
The three earlier failures are retained here rather than being represented as
passing tests.

The environment has no native Rust/WASI toolchain. Native sandbox execution,
the Mac app, WebView behavior and live-account acceptance were not run locally;
TypeScript, controlled-provider and DOM results do not establish those outcomes.

The first stable commit, `b35cf79d3ace0a7d438b81b776ef11a2606d4141`, subsequently
passed all three required jobs in
[GitHub CI run 45586875373](https://github.com/yanaire/athena/actions/runs/45586875373).
The actual Apple Silicon host suite passed **257/257 tests with zero skips**, the
production dependency audit reported zero vulnerabilities, the generated UI and
its 107/38/101 test groups passed, and the arm64 app bundle built and passed its
file verification. The final Cargo desktop test-target command reported **zero
Rust tests**; it must not be treated as native startup behavioral acceptance.
Host startup regressions are part of the Node suite, and actual app/WebView
acceptance remains separate.

All four CodeQL language jobs passed for that first stable commit in
[run 45586870515](https://github.com/yanaire/athena/actions/runs/45586870515), and
the aggregate reported no new alerts in changed code. The subsequent MCP and CI
trigger corrections are recorded above. These earlier successful runs are
historical evidence, not a substitute for the final candidate's own checks.

Merge readiness requires successful `history-secrets`, `apple-silicon` and
`browser-chat` checks on this exact candidate. The workflow retains the three
PR #5 jobs with the reviewed PR #8 action pins, verifies main pushes and PRs,
and uses separate event-scoped concurrency groups. Windows and Intel Mac jobs are outside this
candidate. Record the actual final candidate SHA and CI run in its pull request.
Do not use an earlier feature head or PR #14 result as proof of the new tree.

Controlled responses and synthetic browser inputs validate host, SDK, transport,
persistence and UI behavior. They do not establish actual model
instruction-following quality, real ChatGPT-account acceptance or public-release
clearance. A neutral CodeQL result is not a successful security scan.
