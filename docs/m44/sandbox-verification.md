# M4.4 sandbox verification receipt

Date: 2026-11-22. Worktree: `athena-m4-4-final-integration`.
Baseline HEAD: `406b4d024b0e4d11e2c4139a591acd086f1ceb75`,
branch `feature/athena-m4-4-final-integration`.
This receipt covers uncommitted scoped changes; it is not a candidate-commit or
packaged-app acceptance receipt. Other integration tracks were changing the
shared worktree concurrently. No commit, publish, Docker, VM, real credential,
or real provider execution was used for this track.

Toolchain: Node `v24.22.3`, Rust
`rustc 1.99.1 (58cf8f9c3 2026-10-13)`, native target
`aarch64-apple-darwin`.

## Executed checks

Commands ran from the worktree above. Cargo commands used
`PATH="$HOME/.cargo/bin:$PATH"`.

| Command / check | Result | Evidence |
| --- | --- | --- |
| `node scripts/prepare-analysis.mjs && node --test tests/analysis-files.test.ts tests/jobs-analysis.test.ts` before implementation | PASS | Exit 0, original 15 tests passed, 0 failed. Own pinned runtime downloaded and built in this worktree. |
| `node --test tests/analysis-publication.test.ts` before publication fix | Expected regression failure | Both isolated fault cases failed because new blobs remained. The initial fixture path was corrected for macOS `/var` -> `/private/var` before recording this two-case result. |
| `cargo test --release --target aarch64-apple-darwin --manifest-path sandbox/Cargo.toml` | PASS / CONTROLLED | Exit 0, 2 tests passed, 0 failed. One test is the subprocess fixture; the other executes it in over/within modes. A touched synthetic 32 MiB native allocation exits 126 at a test-only baseline + 8 MiB threshold; the same allocation exits 0 with 64 MiB allowance. No production threshold override exists. |
| `node --test tests/analysis-files.test.ts tests/analysis-publication.test.ts` after fix | PASS / CONTROLLED | Exit 0, 9 tests passed, 0 failed. Synthetic write/index failures remove new blobs, leave previous workspace bytes unchanged, and retain old downloads. |
| `node scripts/prepare-analysis.mjs && node --test tests/jobs-analysis.test.ts` after native change | PASS | Exit 0, 11 tests passed, 0 failed, real pinned CPython WASI and QuickJS-ng on Wasmtime. Covers successful reuse, missing/invalid outputs, guest memory cap, cancellation, timeout, parent death, benign stream/file overflow, and reserved native exit-code handling. |
| `node --test tests/jobs.test.ts tests/manager-orchestration.test.ts` | PASS / CONTROLLED | Exit 0, 13 tests passed, 0 failed. Original fixed Node CSV worker and manager analysis/delegation/restart regressions; model responses come only from the existing loopback controlled fixture. |
| `node node_modules/typescript/bin/tsc --noEmit` | PASS | Exit 0; no TypeScript diagnostics. |
| `cargo clippy --release --locked --target aarch64-apple-darwin --manifest-path sandbox/Cargo.toml --all-targets -- -D warnings` | PASS | Exit 0; no warnings. |
| `git diff --check -- runtime/analysis-files.ts runtime/analysis-sandbox.ts sandbox/Cargo.toml sandbox/Cargo.lock sandbox/src/main.rs tests/jobs-analysis.test.ts docs/sandbox-security.md docs/known-limitations.md` | PASS | Exit 0. |

The post-change Node runs above contain 33 passing tests in total. Native
memory enforcement is tested at a small synthetic threshold, not by deliberately
consuming 768 MiB. The original suite's guest-memory test attempts a bounded
256 MiB guest allocation, which the existing 192 MiB guest limit rejects.
Successful, cancelled, timed out, stream-overflow and file-overflow attempts
were checked for an empty scratch attempt directory after settlement.

## Artifact identity

The real interpreter run used `.analysis-runtime/staged/provenance.json`:

| Artifact | SHA-256 |
| --- | --- |
| `athena-sandbox` | `35997000c3bf6312ac03005a88e549f7462d5925d197193132b4c3b8d3038959` |
| `python.wasm` | `dd076791fb6d1286a5dfe105852dfb3367e10562de68ca0a618e615625cdf636` |
| `qjs.wasm` | `2c218412cb8b17e46ee91bea7556ec38f5b9b6bd6312fddd3ceeed14aa71eaaa` |
| Sandbox lockfile | `67977625ce1bca981ce64e475eec9651431c529cc17930eadf5e53db17887574` |

Verified source identity:

| File | SHA-256 |
| --- | --- |
| `sandbox/Cargo.toml` | `73c134338e602bf79370748ce1fcf0aaa1c039710c6c66b27209760ead6a5304` |
| `sandbox/src/main.rs` | `d4726db6f3447c04f7cb029da2c25f685cc7fc4b0e55e89b6039833851b68935` |
| `sandbox/src/memory.rs` | `532b7109aa0a72ae7ae39bf5e72e801f380888483eb58a8b4a8cffa9bca9c6e5` |
| `runtime/analysis-files.ts` | `5a75a7b822599b37ce887f1af65cb0c136d41334dfd67b9c15bb08da51301bc1` |
| `runtime/analysis-sandbox.ts` | `282c0c97a46a6c0a77d36563de701f63cb1e5bf0b61d80b1bc7f14ee5d6d412f` |
| `tests/jobs-analysis.test.ts` | `7985535324b87eddc11e2f3ca9ec92757e40045998e2aa8cd36f8e6d8463abfc` |
| `tests/analysis-publication.test.ts` | `f78474a8568cb309f0b3146cb61ed1066db044da9d0d202503d9f0b789945fad` |

## Assumptions and remaining integration work

- The existing manager owns admission, authorized scopes, immutable input
  snapshots and event persistence. Neither `runtime/jobs.ts` nor
  `runtime/agent-tools.ts` changed.
- The 768 MiB threshold leaves room for both shipped interpreters and compilation
  in the executed regressions. It is a defensive default, not a benchmark of
  maximum safe concurrency or a kernel allocation quota.
- Existing single-host synchronous index publication remains the concurrency
  contract. This change adds caught-error rollback, not a transaction spanning
  filesystem state and SQLite.
- Linux memory accounting is implemented but NOT RUN on this macOS host.
  No packaged-app, signing, notarization, remote CI, power-loss, abrupt-death
  cleanup recovery, or full repository test-suite acceptance is claimed.
- TypeScript and Rust language servers were unavailable. Actual compiler and
  Clippy diagnostics were run instead; no toolchain dependency was installed
  outside the sandbox lockfile.
- Integration must regenerate sandbox third-party notices for `libproc 0.15.0`
  and its newly locked build dependencies. This was sent to the lead; this
  track does not edit the integration owner's notice inventory.
- See [sandbox hardening](sandbox-hardening.md) for sampled-memory limitations,
  crash residue, retention limits, and the fixed Node CSV/host tool boundary.
