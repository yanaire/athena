# Code-mode validation

The feature starts from `origin/main` at `80e81444fcec750109a3c1c985fdd6b3ab41dc14`, which includes #27. Athena remains at version 0.0.1.

## Reproduce

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run analysis:prepare
npm run check
node --test tests/code-mode.test.ts tests/manager-code-mode.test.mjs
node --test --test-concurrency=2 tests/*.test.*
node scripts/benchmark-code-mode.mjs 3 /tmp/athena-code-mode-benchmark.json
```

The benchmark and host integration tests use the actual Pi SDK, QuickJS Wasm, Worker IPC, TaskManager, research ledger, Node CSV MCP subprocesses, SHA-256 readers, SQLite journal and artifact downloads. The local provider supplies prewritten model responses. Where native WASI preparation is absent, the isolated test child can substitute only the offline-analysis availability signal. The permission setting, exact grants, published files, and file verification still run through the host. In the recorded Linux benchmark the native WASI availability check passed.

```sh
npm ci --prefix athena-backend-handoff/athena-codex-ui/qa --ignore-scripts
(cd athena-backend-handoff/athena-codex-ui/qa && npx playwright install chromium)
python3 athena-backend-handoff/athena-codex-ui/build.py
node athena-backend-handoff/athena-codex-ui/qa/code-mode-browser-test.mjs
```

Set `ATHENA_CHROMIUM` to use an installed Chromium and `ATHENA_BROWSER_EVIDENCE` to choose the screenshot and report directory. The browser test uses three published results for the comparison to focus on application states. Its delay control holds a real, verified host read response long enough to exercise Stop. The restart integration test kills the host after a live read and a waiting read are durably recorded. The permission-loss test injects a change at the storage boundary because the settings API serializes permission changes with running work.

Chromium 156.0.8078.79 on Linux exercised the composer, comparison and syntax failure, Workflow process links, and exact Artifacts links. The browser displayed one completed, one active and four waiting reads. The test clicked **Stop response** and confirmed preserved results and requests that never started. It then reconnected to a restarted host and compared the restored receipts. The responder waits until the discovered contracts are visible before starting the timed Stop scenario. The analysis availability check used the locally compiled WASI runtime. [Browser report](code-mode-readonly-browser.json)

## Acceptance and compatibility

- The coordinator created a research plan, waited for real CSV jobs, and linked their output versions to evidence. It transferred four exact artifacts to each comparison worker. The 20 °C baseline, 40 °C hot run and 20 °C repeat measured 10, 20 and 12 mV. The 60 °C result lacked `voltage_mV.mean`. The two 20 °C means differed by 2 mV.
- Each of the three paths returned four source IDs, versions and SHA-256 values. The test checks each referenced file through the HTTP download route and computes its hash again. Code-mode recorded the board read and four file reads along with its generated summary. The additional untransferred artifact was available only to the coordinator. A separate scope run denied that file, a real file from the same project in another conversation, and a real file from another project.
- The engine and host suites exercise actual await, branches, loops, parallel reads, and completion with read and JobRunner concurrency 1. They cover source, CPU, wall, memory, argument, result, queue and call limits. Additional cases cover a syntax error before any read, stale contracts, unknown tools, out-of-scope arguments, role denial, permission loss, caught failures, partial results, unawaited requests, Stop, late replies and crash recovery.
- The #26 stack at `03cfbee` (also includes #25) merged into a detached integration checkout. Its generated UI, type check, Paper source test and five code-mode host tests passed. The #30 stack at `206f634` (also includes #28 and #29) required combining the Pi loadout options and process metadata in a detached checkout. Its generated UI, type check and 40 selected host tests passed. A separate live FreeCAD GUI run on Linux authored and verified both files and sent actual PNG image blocks through Pi to the controlled provider. The feature branch stays independent of both stacks.

The Linux full host suite reported 298 passes, one failure and four skips. The WASI liveness test `killing the Node host closes the sandbox liveness pipe` failed on both this branch and the same `main` SHA with the same compiled helper. A defunct `athena-sandbox` process remained visible to the test's PID probe in the cloud container. The new code-mode tests passed, as did both targeted HTTP recovery tests and 47 workflow, activity and workspace UI contract tests.

## Platform and model scope

| Target | Status |
| --- | --- |
| Linux x64 | Real QuickJS and Node Worker plus real scoped artifact reads and Linux Chromium. |
| macOS Apple Silicon | NOT RUN in this workspace. The existing native CI host job runs the new engine and host tests with the staged offline runtime. |
| macOS Intel | NOT RUN in this workspace. The existing native CI matrix runs the engine and host tests. |
| Windows x64 | NOT RUN in this workspace. The existing native CI matrix runs the engine and host tests. |
| Native desktop package builds | NOT RUN in this workspace. CI has separate runtime and package checks. |
| Configured real model | NOT RUN. The configured compatible endpoint returned HTTP 404 for `/models` and a minimal `/chat/completions` probe. |
| Model-generated code quality, usage and billing | NOT RUN. The local responder has no tokenizer, cache usage, pricing, or independent code generation. |

## Benchmark

A uses the existing direct tools. B requests the two exact contracts and then uses ordinary single-read calls. C requests those same contracts and uses one code tool. The three workers receive the same published IDs and permissions within each trial, use the same model connection and ground truth, and run with tool concurrency 1. The direct workers issue multiple tool calls in one model reply. The existing TaskManager executes that batch in order. C submits bounded batches inside QuickJS and its host trace verifies the same active-read concurrency.

The benchmark records the model round trips, actual encoded request sizes, worker and tool wall times, Worker CPU time, code bytes, retries, integrity and exact sources per trial. The ordinary tool interval comes from the first start to the last completion in the journal and includes host queue time. The C receipt also reports each inner read duration. The shared run time includes authoring and publication. The checkout SHA in the JSON identifies the implementation under measurement.

Three Linux x64 trials used Node 24.22.3 and the same engine, artifacts and connection within each trial. These values are medians.

| Measured field | A · Direct tools | B · Discover and call | C · Discover and execute |
| --- | ---: | ---: | ---: |
| Model round trips per comparison | 2 | 3 | 3 |
| Initial encoded request bytes | 16,012 | 17,891 | 17,891 |
| Total encoded request bytes | 41,596 | 69,063 | 66,625 |
| Comparison worker wall time | 262 ms | 279 ms | 542 ms |
| Discovery batch time | — | 16 ms | 18 ms |
| Ordinary read batch time | 128 ms | 93 ms | — |
| Code tool wall time | — | — | 329 ms |
| Nested read time, summed | — | — | 79 ms |
| Worker CPU time | — | — | 104.2 ms |
| Submitted JavaScript bytes | — | — | 2,266 |
| Verified sources | 4 | 4 | 4 |

The median end-to-end wall time was 4,063 ms for the shared run that generated the artifacts and exercised all three comparison workers. All nine comparison outputs matched the expected values, missing field, discrepancy, and source IDs, versions and hashes. There were zero retries and zero code revisions. The ordinary batch already fit within one model reply. In this case C took the same number of round trips as B, and starting and running the isolate added elapsed time. The request sizes include the actual prompts and tool responses on the wire. Token usage, cache accounting, model-generated code quality and cost remain unmeasured. [Raw samples](code-mode-readonly-benchmark.json)
