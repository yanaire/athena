# Local CI readiness, 2026-11-22

This record covers the shared integration overlay inspected at HEAD `406b4d024b0e4d11e2c4139a591acd086f1ceb75`, including existing staged review changes. It is not a clean-clone result or a final candidate-commit certification. The integration owner must attach final checks to the chosen candidate after all lanes land.

The checked `package-lock.json` SHA-256 is `50a6918460b3741c4e4fb55999e1c3c9743c39768969596927891c36bf75e5ae`. The checked `.github/workflows/verify.yml` SHA-256 is `cc9313ba316d541934af060591323bb4b049854e75c8f78727d227afe116843a`.

| Check | Result and limit |
|---|---|
| Workflow validation | **PASS**. Official actionlint 1.7.12, `-shellcheck="" -pyflakes=""`, exit 0. Its Darwin arm64 release archive SHA-256 `aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f` matched both the official GitHub release asset digest and release checksum list. External ShellCheck and Pyflakes integrations were disabled; this is not a claim they ran. |
| YAML and shell checks | **PASS**. Bun YAML parse; all action references retain full 40-hex pins; permissions remain `contents: read`; both jobs require native Darwin arm64; every `run` block passed `bash -n -c`. |
| Production npm audit | **PASS**, exit 0, `found 0 vulnerabilities` from the official public npm registry with `--omit=dev`. Separate empty user and global configs excluded workstation npm config. This audit does not establish license rights or absence of all vulnerabilities. |
| Production npm declarations | **PASS**, 123 entries: 60 MIT, 38 Apache-2.0, 13 BSD-3-Clause, 6 ISC, 4 BlueOak-1.0.0, 1 Unlicense, 1 0BSD. The workflow's allowlist accepted them. This checks declarations only; [notice blockers remain](source-distribution.md). |
| Initial `npm run check` | **FAIL_CODE**, exit 2 on the in-flight shared overlay. `runtime/local-credential-files.ts:41` reported TS2322 (`string` versus `"\\" \| "/"`); `runtime/server.ts:36` reported TS2339 (missing `DesktopStartup.vaultKey`). The files belong to another lane; both diagnostics were sent to the integration owner. No errors were suppressed. A later fix needs its own recorded result. |
| Whitespace | **PASS**, `git diff --check`, exit 0 for the observed overlay. |
| Host, runner and desktop tests | **PENDING_TEST** in this lane. `npm test`, `analysis:prepare`, Cargo tests and desktop packaging were reserved for the integration owner's coordinated run. No sandbox adversarial or malicious tests, Keychain interaction, VM or OS-auth operation was initiated here. |
| Remote workflow | **PENDING_REMOTE**. No GitHub Actions run was started or observed. Runner availability, pinned tool downloads, Rust setup and the complete build sequence require an actual remote run on the final candidate. |
| Final source history scan | **PENDING_TEST / NEEDS_USER**. Existing history review results remain in the OSS status record. No fresh public root or history rewrite was created, and no history scan is claimed for a future source snapshot. |

The workflow retains the existing typecheck, offline runner preparation, host tests, npm audit, declared-license check, generated UI check, DOM tests, arm64 bundle build and Rust startup tests. It adds checksum-pinned actionlint and native architecture preflights. Typechecking, preparation and tests now have separate step results, so a failure does not get described as a completed runner test.

The YAML language server is unavailable locally. No dependency or global installation was made; the successful standalone actionlint and syntax checks above are the available workflow diagnostics.

No commits, pushes, visibility changes, publication, authenticated network operations or package-manifest edits were performed by this lane. The reporting route and Photon/proxy notice gates remain external prerequisites; see [SECURITY.md](../../../SECURITY.md), [OSS status](../../oss-preview-status.md), and the [release checklist](../../release-checklist.md).
