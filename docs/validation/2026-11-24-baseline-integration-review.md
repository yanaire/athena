# Baseline review before the common MCP integration

## Source and release boundary

This review starts from `a27d2df7924ee5b5d344e5d94d61e5ca6602d55c` on
`feature/athena-engineering-mcp-board`. The observed `main` is
`d2230300889bed7693b146c081bd64102762912d`; the feature is four commits ahead
and contains the measurement MCP, readable task labels, and manual child
recovery. The 193 tracked files in the local source snapshot were compared
with the remote Git blob IDs and all matched before review changes.

The review candidate is maintained on `integration/athena-baseline-review`. Its fixes concern
the existing functionality. They do not implement the second MCP or assume a
future registry contract.

The initial review preceded the cloud and Mac handoffs. Both are now available:
the common MCP contract is at `a5ddf42438daa5a4a31117dbda4e998505c77351`,
and the [Mac acceptance report](../mac-chatgpt-acceptance.md) is preserved from
`6c3e2698c4c4e892ca6a98200bfbfc708fd5c868`. That report covers the native
build at `22cda9171ef3ecd4f2201531eaaa9f3f39e0160d`, not this integration
candidate. Exact-candidate Mac acceptance remains a release prerequisite.

## Reproduced findings

### Tool outcomes changed when the owning task was retried

The conversation activity card used the task's current status for each
historical tool call. A successful CSV call appeared failed when the child
later failed, and appeared to run again when that child was retried. The
Workflow tool list used the call's own status, so the two views disagreed.

The runtime card now uses the tool call's own status for its title, icon, and
badge. The authored preview keeps its existing behavior. A DOM regression
retains successful, failed, and cancelled calls while the task transitions
through failure, a new running attempt, and success. It also checks preserved
logs, identifiers used by controls, artifact version, and download URL. The
regression failed on the original rendering code before the fix.

### Empty and populated conversations reused inconsistent artifact caches

The artifact panel used both a generic HTML cache and a separate populated
artifact signature. Switching from a populated conversation to an empty one
and back could leave the empty view in the populated conversation. Starting
with the empty conversation and returning to it after viewing a result could
instead leave the previous conversation's table and download link visible.

Both caches are invalidated when the corresponding rendering path changes.
Two DOM regressions use a historical CSV result and cover both conversation
orders, including the restored authenticated download URL and a fresh table
request. Both failed before the fix in the baseline and the common MCP UI.

### Reopening a run could silently select a replacement API key

A real TaskManager/Pi test using a controlled local provider created a run
with credential A, failed a child, closed the host, replaced the stored key
with B, and retried after restart. Both the child and its reconciliation
used B while the old provider-wide `authRef` still compared equal.

This finding applies to the saved API-key profile path. It does not demonstrate
a defect in ChatGPT's registration-specific account identity.

New API-key pins bind the effective credential using a private HMAC key.
The same credential can be selected again after restart; a different
credential is rejected before retry admission. Previously unbound API-key
records fail closed after restart. Existing in-memory pins retain their
original credential, and a new request may use a newly configured key. The
legacy environment-only route does not use profile credential binding; its
model/endpoint checks do not establish unchanged account identity.

### Failed result publication was reported as successful computation

Injecting a one-time failure into the artifact storage transaction produced
a successful run and child, a process still recorded as running, and no
stored artifact. The model had nevertheless received an artifact ID whose
download failed. On restart the process became interrupted.

Terminal process storage is now part of the completion boundary. A failed
publication cannot return an artifact as a success. A second failure while
recording the failed outcome stops new work and settles waiting requests.
Storage transaction failure is distinguished from a UI listener error after
the transaction has already committed.

## Existing evidence and verification limits

[The baseline workflow](https://github.com/yanaire/athena-1/actions/runs/45377473947)
passed both its history secret scan and Apple Silicon job at the original
baseline SHA. Its logs report 190 host tests, 106 UI integration assertions,
4 label tests, and 88 DOM/adapter contract tests. Production dependency and
license checks passed. The bundled measurement MCP and WASI calculations
were exercised through the bundled Node executable.

That workflow explicitly tested the ChatGPT-disabled bundle and a controlled
loopback model. Its final Rust startup test command reported zero tests;
the successful command is not evidence of additional Rust test coverage.
The bundle checker separately exercised startup and credential-preservation
scenarios. None of these checks establishes actual-account inference or
Finder interaction.

The independent review also exercised the existing CSV runner suite, the
measurement orchestration/restart cases, and selected recovery races. The
candidate adds focused regressions for the four findings above. Use the
workflow associated with the candidate commit for its final test counts;
the baseline counts above are not the candidate's result.

Before publication, the candidate passed TypeScript checking, 106 UI
integration assertions, 4 label tests, and 89 DOM/adapter contract tests before
the cache correction; the two additional cache regressions then passed in
both worktrees. The final candidate workflow includes those regressions.
The focused backend review passed 31 process/recovery checks and 43
credential/profile/recovery checks; these groups overlap and are not an
additive test count. The new WASI publication-failure regression remains in
the normal suite and requires the prepared native CI runtime.

## Mac corrections and acceptance intake

The Mac source fixes were reviewed against the actual remote commits.
Attachment instructions remain in the model dispatch and Pi JSONL, while
live user messages and public history show the original user input. The
projection matches the owning attempt and the exact host-appended suffix;
a user's literal copy, whitespace and Unicode are preserved. Public history
continues to redact credentials. Invalid `get_entries.since` requests retain
the SDK error instead of returning an unfiltered history.

The Mac display fix was adapted to retain each recorded tool call's own
status. A worker can finish successfully before its tool wrapper fails, so
process success must not override a recorded failed tool. The regression
covers that case as well as a completed child whose CSV tool failed.
The existing CSV process row now has a readable measurement name.

The supplied report establishes real ChatGPT Luna inference, parent-to-child
CSV delegation, original and changed calculations, equal downloaded bytes
after reopening, malformed-input failure, cancellation before a tool call,
manual retry with sibling preservation and parent reconciliation, profile
pinning on one registration, rejection when that registration is absent, and
paused recovery after host interruption. Timing-sensitive profile switching
used the exact packaged host followed by native-app retry, as the report
explains. It does not establish cancellation inside a running MCP worker,
switching between two real accounts, or a fresh OAuth consent flow.

The last previously published review candidate,
`599427d04f82c40fc04720345548095a09eed788`, passed
[its Apple Silicon workflow](https://github.com/yanaire/athena-1/actions/runs/45415950169):
201 host tests, 106 UI integration assertions, 4 label tests and 91
DOM/adapter tests, plus security and bundle checks. The Mac corrections above
were then checked locally with 11 history/manager tests, selected recovery
checks, type checking, 106 UI integration assertions, 5 label tests and the
existing DOM suite. These overlapping checks are not an additive total.

An execution-environment interruption occurred before the local combined
revision was published. The source was recovered from the exact remote bases
and successful patch records. The display files also match blob prefixes
printed before the interruption; regenerated HTML was reproduced from a
builder first checked against both previously published HTML blob hashes.
The recovered candidate must pass its own workflow and actual Mac acceptance.
Neither the older CI nor the Mac report is relabelled as that evidence.

## Separate UI integration of the published MCP contract

During the review the cloud branch published
`a5ddf42438daa5a4a31117dbda4e998505c77351`, including `docs/builtin-mcp.md`,
the shared registry/client/runner, and the separate RC worker. UI work against
that actual contract proceeds on `feature/athena-mcp-ui` in a separate worktree.
Those changes are not part of this baseline candidate.

The existing implementation has these integration points:

| Area | Existing behavior | Input needed from the common MCP implementation |
| --- | --- | --- |
| `integrations/task-manager.d.ts` | Process projection does not yet declare the future common MCP metadata | Actual serialized server/tool metadata and result records |
| `ui/pi-activity.js` | CSV tool name, icon, and detail strings | Registered tool identity and human-readable description |
| `ui/workspace-views.js` Workflow | MCP process cards use measurement-specific result wording | Actual result kinds and links |
| `ui/workspace-views.js` Artifacts | CSV renderer reads `schemaVersion`, `rowCount`, and `statistics` | Validated RC output schema, units, and sample structure |
| Result file links | Table and download use the authenticated artifact URL | Preserve this authorization and version contract |

No speculative RC fields, demo data, or new API endpoints are part of this baseline.
The new renderer must consume the saved result file and must not recompute
the engineering result in the UI. Late result responses must remain bound
to the element and artifact version that requested them.

## Handoff and integration order

1. Publish the reviewed baseline candidate and verify its exact-commit CI.
2. Build that candidate on the Mac with `desktop:build:local-chatgpt` and
   provide actual account, delegation, result, restart, and recovery evidence.
   A separate bundle identifier does not by itself isolate workspace data.
3. Merge the accepted baseline into `main` under the repository's rules.
4. Read the cloud registry/result contract, implement the CSV/RC UI connection,
   and integrate on top of the accepted baseline.
5. Verify the integrated commit in CI and on the Mac with both actual tools
   before its own `main` update.

The next milestone after that acceptance is the skill loader and research
workflow. A general external plugin installer is outside this review.
