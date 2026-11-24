# Common MCP UI and independent integration review

## Source boundary

The implemented interface is the actual v1 contract at cloud commit
`a5ddf42438daa5a4a31117dbda4e998505c77351` on
`feature/athena-mcp-registry`, based on the original feature
`a27d2df7924ee5b5d344e5d94d61e5ca6602d55c`.
UI work is published separately on `feature/athena-mcp-ui`.

Existing-feature corrections are independently staged at
`65e2f2ba567eed3cdbb204488d35b111faa5c181` on
`integration/athena-baseline-review`. Main was still
`d2230300889bed7693b146c081bd64102762912d` when this report was written.
No Mac acceptance branch or actual-account report was available. A combined
review candidate does not satisfy either main-release gate by itself.

## UI behavior

The host adapter preserves registered metadata from the existing snapshot;
the UI types declare it without adding a new API. Workflow and inline process
activity use human-readable names, the process's authoritative state, and
the current connection/discovery/calculation phase only while work is active.
Raw identifiers, MCP identity and protocol remain in technical details.
User-authored message text is unchanged.

Artifacts join the successful process and its published artifact by exact
IDs. Registered CSV and RC outputs use the same authenticated URL for table
loading and download. New receipts without a matching successful process
cannot expose a download or an original-link fallback. Older CSV and WASI
receipts keep their existing scoped downloads. Unknown registered versions
remain downloadable when authorized, but do not receive a guessed schema.

The RC view displays saved `timeConstantSeconds`, `cutoffHz`, and the ordered
`samples` array, with seconds, hertz and volts. It identifies the input units
(ohms, farads, volts and seconds) and the worker's zero-initial-voltage,
ideal-low-pass assumptions. The current result does not contain R, C or the
step amplitude, so the UI does not invent those values or calculate them.
Zero values and repeated sample times are preserved.

The CSV table remains based on the saved v1 result. Malformed result schemas
show an unsupported-format message, and failed fetches show a load error.
No authored example result is substituted. Late fetches only own their
original DOM element and cannot replace another selected result.

Two existing UI corrections are included: historical tool cards retain the
tool call's outcome when its task is retried, and empty/populated conversation
switches invalidate both artifact render caches.

## Independent backend review

Both tools use the same trusted registry, Pi admission path, input-version
resolution, grant/receipt handling, MCP client, queue, timeout and termination
logic. Each worker has a fixed entry point and arguments. New registration
does not introduce arbitrary command, network, shell or file access.

The review independently exercised a historical CSV grant and receipt
created with the original runner, then reopened and downloaded it with the
new runner and reused the historical grant. It also injected cancellation
after successful worker exit and receipt creation for each tool: cancellation
withheld the artifact and removed the receipt. Mixed CSV/RC recovery, actual
Pi tool exposure, duplicate handling and input/result digest checks are
covered by the existing and added backend suites.

The baseline publication correction must be retained during integration:
failure to commit a terminal process/artifact cannot be reported as success.
The cloud cancellation-before-publication path must also remain intact.
The saved-profile credential correction is likewise required; its legacy
environment-only limitation is documented in the baseline review.

## Verification and limits

The UI source candidate passed TypeScript checking, 106 UI integration
assertions, 5 label tests and 100 DOM/adapter tests. These include process
metadata hydration, CSV/RC saved values and units, failed/cancelled and
mislinked outputs, unknown schemas, delayed replies, cross-conversation
cache behavior, and legacy CSV/WASI downloads. Generated HTML was rebuilt.
DOM tests mock layout, animation and focus; these are not screenshot tests.

The cloud workflow at the source SHA completed successfully:
https://github.com/yanaire/athena-1/actions/runs/45409714543.
The independent backend review separately passed registry/job, mixed-tool
recovery and Pi orchestration checks. These overlapping runs are not an
additive host-test count. The final combined candidate still needs its own
workflow, including the native WASI runner, security checks and arm64 bundle.

A local Chromium smoke attempt could not launch because the environment
denied its process-singleton socket. No visual pass or actual Mac run is
claimed. The native build, real ChatGPT inference, account pinning during a
live retry, and actual-app result/download/restart flows require Mac evidence
for the exact tested candidate. CI's controlled provider is not that evidence.

## Mac acceptance boundary

Accept the existing-feature candidate separately before its main update.
For the common MCP candidate, record the full source SHA, clean worktree,
app build provenance, ChatGPT-enabled local build, and actual account use.
Exercise both attachments through parent-to-child delegation and the actual
registered tool; compare the table and downloaded JSON, verify their SHA-256,
restart and retrieve the same IDs and bytes, and cover failure/cancellation
and recovery without repeating a successful sibling. Check narrow result
panels and conversation switching in the actual app.

Any source correction changes the acceptance candidate and requires the
relevant exact-commit CI and Mac retest. Only after these gates should main
advance. The following milestone is the skill loader and research workflow;
no implementation of that milestone or plugin installation UI is included.
