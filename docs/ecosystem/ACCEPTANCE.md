# Research extensions acceptance

## Source boundary

- Repository: `yanaire/athena` (repository ID `1464892250`).
- Confirmed main when this work began: `55c7e8fe786c4efa16ac9bc2cd3d6c578df5fc6b`.
- Parent integration candidate: `427cc6eef1a45f945db04c456b8388bed4076014`.
- Implementation branch: `feature/athena-research-extensions`.
- Skill catalog source: `987e61d8b922c609b0fda3794a06f835c9b36530`; individual
  imported file hashes and paths are in `skills/catalog.json`.

The previous Mac acceptance report built `22cda9171ef3ecd4f2201531eaaa9f3f39e0160d`.
That report does not accept this candidate or its new extension and research
paths. Neither a controlled provider response nor an Apple Silicon CI build is
an actual ChatGPT-account inference test. Main is not advanced on that basis.

## Implemented boundary

| Area | Candidate behavior |
|---|---|
| Research workflow | One existing TaskManager scheduler, a persisted objective/criteria/stage plan, actual evidence, separately bound child reviewer, structured verdict and Books records |
| Reuse | Explicit project/worker notes and reusable method records; observation, independently reproduced and human-confirmed levels with retained decision history |
| Skills | 12 bundled, integrity-checked procedures; metadata first; selected body loaded by host tool; per-attempt version/hash, reason and capability limits recorded |
| Automatic selection | Only research intake, source provenance and data quality are eligible; all other built-in and imported procedures require explicit selection |
| Plugins | Bounded declarative JSON import/update/enable/disable/remove; project scope, optimistic revisions and immutable archived versions |
| External MCP | Explicit endpoint and tool allowlist; MCP 2025-06-18 Streamable HTTP JSON/SSE; discovery/schema binding before enablement and before each execution |
| Credentials | Optional separate bearer credential, stored by the host, pinned per run; no inherited model-provider credential or environment |
| Results | Existing job queue, process states, cancellation/recovery and host SHA-256 publication; downloads use the original immutable receipt even after plugin removal |
| UI | Settings controls, selected skill usage, research board, readable activity and generic external MCP results alongside existing CSV/RC views |

Unsupported transports/results/schemas fail explicitly. External `stdio`, OAuth,
arbitrary plugin code/hooks, automatic package installation, autonomous timed
wakeups, a third agent runtime tier and automatically installed learned skills
are not implemented. A remote request may finish after a local cancellation;
the UI reports that uncertainty and no late result is published. A manual retry
can repeat a remote side effect and is never presented as exactly-once execution.

## Automated evidence

The following tests exercise real code and stored bytes. The model responses in
the Pi integration fixtures are controlled, with no actual ChatGPT account.

| Check | Evidence |
|---|---|
| Registry and catalog | `tests/extensions.test.ts`: catalog integrity, role/project boundaries, immutable versions, changed configuration, update/remove and retained use history |
| Wire protocol | `tests/external-mcp-client.test.ts`: actual loopback HTTP JSON/SSE, initialization and pagination, schema drift, credentials, limits, cancellation and no redirects |
| Common execution | `tests/jobs-external.test.ts`: external/CSV/RC queue, actual result bytes, hashes, late cancellation, persistence failure, timeout and restart |
| Pi extension binding | `tests/manager-extensions.test.ts`: actual Pi tools and HTTP MCP, run/child/retry pins and original credential selection |
| Research ledger | `tests/research.test.ts`: scope, exact evidence, independent reviewer ownership, structured verdicts, reproduction provenance, history and human decisions |
| Pi research study | `tests/manager-research.test.ts`: actual Pi delegation and Node CSV MCP, separate recalculation, verified Books, cancelled reviewer/manual retry and restart |
| UI | `qa/extensions-test.cjs` plus existing UI integration and DOM suites: real adapter methods, late response retirement, secret-field clearing, research states and result receipt joins |
| App bundle | `scripts/check-desktop-bundle.mjs`: bundled catalog/body hashes, external HTTP MCP result, CSV/RC and WASI calculations, extension RPC, settings and host restart |

On Linux without the prepared native WASI helper, the research study fixture
overrides only `JobRunner.analysisAccess` to enable Athena's existing artifact
transfer gate. Its Pi sessions, file grants, Node MCP calculation, artifacts,
ledger, SQLite persistence and restart are real; no WASI program runs in that
fixture. Full regression and app-bundle checks must run in the prepared Apple
Silicon CI environment.

Run the normal repository type, host, UI, security and bundle gates. Record the
final tested commit and CI run URL in the PR/handoff. An intermediate source
checkpoint awaiting generated HTML is not the acceptance candidate.

## Actual Mac handoff

The integrator supplies the final candidate SHA after CI. Build that exact SHA
in an isolated worktree using `npm run desktop:build:local-chatgpt`; record the
source SHA, any dirty files, app build command, OS/device and bundle ID. Use the
actual signed-in ChatGPT account for the parent and children. Never include
tokens, account cookies or private source data in the report.

1. Recheck the existing CSV and RC flows with actual attachments, delegation,
   expected calculated values, Workflow/Artifacts opening, downloads, hashes,
   restart restoration and failed/cancelled-child manual retry. Confirm the
   successful sibling's result stays successful and downloadable.
2. In Settings → Tools & plugins, inspect all 12 built-in skills. Disable one,
   start a new request and verify the selection. Ask explicitly for a procedure;
   check the actual loaded version/hash, selection reason and any missing
   capabilities. Switching settings must not change a previously admitted run.
3. Import an authorized declarative plugin with a known MCP HTTP endpoint and
   allowed tool. Before checking its connection it must remain disabled.
   Supply any dedicated bearer token only through the credential field, check
   discovery, then enable. Discovery alone must not claim a calculation ran.
4. Ask the real model to delegate the approved external tool to a child. Verify
   its process state and the downloaded `mcp-result.json`. The displayed content
   and download must refer to the same published result. Test invalid arguments
   and a real server error. For a cancellable fixture, cancel during tools/call;
   report local stop/remote uncertainty accurately and verify no late artifact.
5. Update or disable/remove the package during an admitted run, then manually
   retry that task. It must use the original admitted package/skill/credential
   pin or fail clearly if that original credential is unavailable. New runs use
   the new settings. Download a prior result after removal and after restart.
6. Ask for a full study on the attached measurement CSV: plan the objective and
   acceptance criteria, perform the calculation, record exact evidence, request
   a separate reviewer and independently recalculate from the same input. Check
   that a real review receipt and separately produced output exist. The method
   may become independently checked only after the reviewer actually succeeds.
7. Cancel a reviewer, close/reopen the app and inspect the interrupted record.
   Nothing should rerun automatically. Manual retry must create a new review
   attempt while preserving the old cancellation and successful calculation.
   A textual approval without reproduction must remain an observation.
8. Inspect the Books method, applicability and evidence. A human may confirm an
   already verified method as a convention with a reason. Revoke or supersede
   it and check retained history. Inspect ordinary chat, activity and Workflow
   for internal IDs; identifiers belong in closed technical details.

For each case record PASS, FAIL or NOT RUN, exact reproduction steps, source/app
SHA and result-file hashes. Keep actual account inference, controlled provider
tests and transport fixtures separate. Report fresh OAuth, two-account switching
and native running-worker cancellation as NOT RUN if they were not observed.

Do not merge main or overwrite another owner's branch. Return fixes on a new
owned Mac branch and give the integrator the exact commit and acceptance report.
