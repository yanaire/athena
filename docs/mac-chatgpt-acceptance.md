# Mac acceptance of ChatGPT plan inference and CSV delegation

## Tested build

| Item | Observed value |
| --- | --- |
| Host | macOS 27.2 (26B123), Apple M5 Pro, arm64 |
| Repository | `https://github.com/yanaire/athena-1.git` |
| Feature / baseline build | `feature/athena-engineering-mcp-board` · `a27d2df7924ee5b5d344e5d94d61e5ca6602d55c` |
| Main at intake | `d2230300889bed7693b146c081bd64102762912d` |
| Fixed app build | `fix/athena-mac-acceptance` · `22cda9171ef3ecd4f2201531eaaa9f3f39e0160d` |
| Native executable SHA-256, baseline | `e4bfe724f99d27ca6cf9c821dbc8e2b8a3caeb6365b78ea3c506eb188448e240` |
| Native executable SHA-256, fixed | `d53e15f1682acaf8e447f987f9ad1a18003d1f0417aa640a517966ca73c3643f` |
| Bundle / actual launch path | `com.athena.desktop.local-chatgpt` · `$HOME/athena/mac-acceptance/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Athena.app` |
| Native account and models | Existing connected ChatGPT plan registration. Saved profiles for `gpt-6-luna` and `gpt-6.2-astra`, reasoning off. Luna was used for the CSV and retry tests. |

At intake, the app inspection script found no running Athena desktop. Existing checkouts included an older fix and a separate working tree with uncommitted changes. A fresh feature checkout at `$HOME/athena/mac-acceptance` isolated the acceptance branch. The verified baseline already had a successful [CI run](https://github.com/yanaire/athena-1/actions/runs/45377473947).

For both builds we prepared locked dependencies with `npm ci --offline --ignore-scripts --no-audit --no-fund`, regenerated the UI with `python3 athena-backend-handoff/athena-codex-ui/build.py`, and ran `npm run desktop:build:local-chatgpt`. We checked the resulting bundle identifier, code signature, executable and running bundled host. The two builds occupied the same output path in sequence. The later acceptance-report commit adds documentation only.

For normal GUI tests we launched the built bundle by its absolute path with macOS `open` (LaunchServices), using the existing default workspace at `$HOME/.athena/workspace`. The dedicated project was `Mac acceptance a27d2df`. The existing account was already connected and enabled for plan usage, so a fresh OAuth sign-in/consent was not exercised. The earlier `Athena verification` project was retained. Its `Luna delegation check` history independently shows exactly one successful child and a successful parent with identical 19-character results. That historical run is outside the fixed-build results below.

## Results on the fixed app

| Case | Verdict | Observed result |
| --- | --- | --- |
| A · Live connection | PASS | Settings → Models & connections → Verify showed `Streaming verified` and `Tools verified` on the saved Luna profile. The following CSV jobs exercised real plan inference, parent delegation and worker tool calls. |
| B · Original CSV | PASS | The native file chooser attached `docs/measurements.csv`. The parent delegated its file grant to the named child. The child called `calculate_csv`, Workflow recorded the MCP execution, and the result table showed four numeric values, one missing, zero nonnumeric, mean 19 mV, minimum 7 mV and maximum 35 mV. |
| C · Changed input | PASS | A separately attached copy changed only `A,7` to `A,0`. A fresh grant and child process produced mean 17.25 mV and range 0–35 mV, with the same counts. The original attachment remained intact. |
| D · Reopen and download | PASS | After a normal quit and a fresh launch, the original task, process and artifact were present. Selecting the original version and downloading it again produced byte-identical JSON. The independently captured B/D record projections also matched. |
| E · Invalid CSV | PASS | The unclosed quoted field produced `Unclosed quoted CSV field.`. Workflow recorded a failed MCP process and failed tool call. No artifact was published. The worker's successful explanation of the failure was separately recorded. |
| E · Cancel before process startup | PASS | A valid-input child was cancelled before invoking a tool and published no result in its cancelled attempt. |
| E · Cancel inside a running MCP calculation | NOT RUN | The observed original, changed and invalid calculations ran for 47, 45 and 48 ms. No cancellation landed within the process lifetime. |
| F · Manual retry and sibling preservation | PASS | In the parallel-child run, `CSV Stable` completed and `File Review Retry` was cancelled. After a normal reopen, clicking Retry task created a new attempt on the same task and run with the original grants. The old cancelled attempt remained. The parent updated its answer to report the successful retry. The successful sibling's task, attempt, tool, process and artifact records were unchanged. |
| G · Progress and details | PASS | Ordinary chat displayed Waiting/Running with the child name, including `Original sample — measurement_mV statistics`. Workflow displayed named tasks and `Measurement calculation`; detailed process information remained available under Technical details. Live messages and restored history omitted internal attachment instructions. |
| H · Change model/profile during execution | PASS | Using the packaged host and the real plan account, the project default changed from Luna to Astra between workspace revisions 400 and 401. The parent was running on both observations. Its original attempt and both child attempts retained Luna. In the native app, Retry task on `Pin witness B` succeeded and the parent reported `PIN_B=120`. All five attempts, including reconciliation, shared the original model, profile, revision, endpoint and account binding. |
| H · Original registration unavailable | PASS | In an isolated copy of the pre-retry conversation with no account registration, the native app displayed `Retry was not confirmed. Reconnect the ChatGPT registration saved with this profile.` The original three attempts remained, with zero retry receipts, new attempts, processes or artifacts. |
| H · Two different real accounts | NOT RUN | Only one real ChatGPT registration was available. Luna and Astra were two profiles on that registration. |
| I · Host interruption and recovery | PASS | With only the dedicated test run active and a child running, we terminated its bundled Node host. The native window reported that the backend stopped. On reopening, both attempts showed Paused, with no automatic retry in successive snapshots 27 seconds apart. Clicking Retry task once preserved both paused attempts and produced a successful child attempt and parent reconciliation. |

## Result bytes and reproduction

| Fixture | Input SHA-256 | Downloaded statistics.json SHA-256 |
| --- | --- | --- |
| Original, including download after reopen | `73d5f6239405d5c8c981d9cf4837b5748841c1be5931ddceb4ff5c087e191964` | `14d3d2b9b85d09f79c9c8802660cebcd86aeb3fff63f2466b272dac225a081a3` |
| First measurement changed to zero | `e5c661e1c6389de59c2ab4253a76e9382eff99c561a29d34e41c316b5024ee12` | `2364f8e83ce24bdb810f99586308e495def5b490b100ee3b53c2c199df16deac` |
| Malformed input | `ad8c97588273a2ca031d49bf3589ba8ae6112aa72d3ca74822daadb2cda49a9f` | No artifact |

1. In a dedicated chat using Luna, attach each fixture via the file chooser. Ask the parent to delegate the attached file to a named child, have the child call `calculate_csv` on `measurement_mV`, then report the statistics. Create the changed fixture as a new file. For the malformed fixture, use the bytes `sample,measurement_mV\nA,"7\nB,13\n` (LF line endings).
2. In Workflow, inspect the matching child's MCP process, tool call and result. The packaged `athena-measurements` server reported version 1.0.0 and protocol 2025-06-18. Use View measurement results and Download result file. The table fetches the same session/artifact URL as the download. Compare the version hash with `shasum -a 256` on the downloaded bytes. The original and changed artifact IDs were `2b7bdeec-2e2a-4053-8933-d2f7427f0dde` and `c93c548a-7cf6-43c1-b53a-f542c4a8ec55`. After reopening, select the original artifact again and repeat.
3. For retry, request two parallel spawns before the first wait. Let one child calculate the CSV and have the parent cancel the other, which was assigned to inspect the same valid attachment. Click Retry task on the cancelled child. In the observed run `4d39712f-e0e4-4254-8b50-d99114974d9d`, task `dd768fff-9420-4960-9fac-fa4133d38786` kept both attempts. The sibling retained artifact `afcd599a-682a-4dce-99e1-3726ea397481` and the original statistics hash. A preliminary sequential request produced only one child and was excluded.
4. For interrupted-host recovery, confirm that only the test run is active and identify the matching bundled host using `scripts/inspect-running-desktop.sh`. Stop that host with a child active, reopen the same app, examine the paused history, then click Retry task once. The observed run ID was `c84076ae-9161-4b1c-9dcf-ddc2441dc6ce`.

### Reproducing the registration checks

The timing-sensitive project-default change used the exact packaged Node host with its desktop startup protocol and a local client. The native app was closed for that step. The client used its own ephemeral desktop handshake and the normal workspace API to change the project default during a real ChatGPT run. It had an unnecessary exact-text assertion for the first worker: the worker returned `42` and the client stopped before issuing any retry. The recorded workspace state established the in-flight switch and both child states. We reopened the native app against the normal workspace, clicked Retry task there and verified the complete attempt history and parent answer. The regular native Settings test in F also changed the project default after the original run had settled and before retry.

For the negative case, keep the real registration intact. Copy only the dedicated project and single conversation's pre-retry records and scoped Pi session files into a new private workspace. Remap their paths, create the empty project working directory, and omit connection and credential stores. Directly launch the native executable with an absolute `ATHENA_DATA_DIR`; we used `$HOME/athena/mac-acceptance-evidence/no-account-workspace`. We verified the bundled Node process held that directory's `workspace.sqlite` open and matched its listener to the native window. Click Retry task on the cancelled child and compare attempt and retry counts. This is a separate environment from normal LaunchServices launches. An initial copy lacked the empty project directory and stopped before loading; the successful test used the corrected copy.

## Baseline defects and regression coverage

- `659d111133b4dad90d52027918045cd4e74bd14d` fixes visible attachment transport text. On the baseline, sending an attachment displayed the internal grant/instructions in the user's message and stored chat view. The fix preserves the original Pi payload and the user's literal message text while cleaning the public chat/history projection. Type checking and all 28 targeted history, manager, orchestration and recovery tests passed.
- `22cda9171ef3ecd4f2201531eaaa9f3f39e0160d` fixes misleading successful activity for a failed measurement. On the baseline, malformed CSV produced a failed process while the chat activity said the CSV statistics were calculated and complete. The corrected view showed `CSV calculation failed` and `Needs attention`. The process row displayed a readable name. Five focused UI regression tests passed and the generated UI was rebuilt. The fixed bundle repeated the real original, modified and malformed cases.

The separate controlled-provider check, `node scripts/check-desktop-bundle.mjs --verify-local-chatgpt "<app path>"`, passed for each bundle. It exercised signed bundle integrity, readiness for local ChatGPT PKCE, measurement MCP, Python/JavaScript artifacts, local credential and profile preservation, token-only startup interruption, and streaming/tools after restart using its controlled provider and isolated home. Sections A–I identify the separate real-account observations.

Raw native-window captures, downloaded files and project-scoped comparisons remain on the test Mac under `$HOME/athena/mac-acceptance-evidence` and Downloads. The local captures include the original and changed artifact views (`final-original-table.png` and `final-changed-table.png`), the malformed CSV Workflow (`final-invalid-workflow.png`), paused recovery (`final-interrupted.png`), and missing registration (`final-no-registration.png`). The Git handoff carries the sanitized results. Round two awaits the integration owner's final candidate SHA for the shared MCP layer and RC tool. It will require a new native build and live CSV and RC delegation, execution, download, and persistence checks on that revision.
