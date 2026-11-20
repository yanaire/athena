# Runtime integration handoff

For the current 15-requirement implementation matrix, exact host attachment APIs, session activation, four model scopes, versioned records, and verification limits, see [RUNTIME-READINESS.md](RUNTIME-READINESS.md). The execution-store API below is the retained development fixture, not the real scheduler.

This version implements the UI, a capability-aware Pi control bridge, reply/event presentation, an optional native host adapter, and deterministic local demos. The supplied preview has no live SDK session. It does not invoke Pi, OmO, Python, a shell, or a remote service unless a host explicitly binds a connection and the user invokes an action. Keep operation/tool UI driven by actual Pi events and command results.

The complete **33 RPC + 18 native host** operation map is in [PI-CAPABILITIES.md](PI-CAPABILITIES.md). Native SDK factory construction, extension binding and session replacement are documented in [PI-HOST-ADAPTER.md](PI-HOST-ADAPTER.md).

Runtime administration is routed through the six Settings categories: **Models & connections**, **Agents & execution**, **Tools & plugins**, **Files & history**, **Appearance & notifications**, and **About & diagnostics**. There is no standalone Pi runtime navigation button; the composer connection caption is read-only. The composer model and reasoning buttons open local selection menus, backed by the same runtime state as Settings. Their **Manage models** link opens Settings; contextual queue and resource controls still open the corresponding settings section. `openPi()` and the internal `pi` settings ID remain stable integration APIs.

## Public shell API

```js
AthenaApp.openWorkspace('execution', { taskId: 'analyze', toolId: 'python-analysis' }); // Reveals inline activity.
AthenaApp.openWorkspace('workflow', { taskId: 'review' });
AthenaApp.openWorkspace('artifacts', { artifactId: 'research-note' });
AthenaApp.openWorkspace('timeline', { taskId: 'analyze' });
AthenaApp.openWorkspace('knowledge');
AthenaApp.openSettings('models');
AthenaApp.openModelPicker('model'); // Or 'reasoning': inline composer menu.
AthenaApp.openPi('session'); // Also model, queue, context, tools, resources, usage, extensions.
AthenaApp.executePi('get_session_stats');
AthenaApp.refreshPi();
AthenaApp.startDemo();
AthenaApp.pauseDemo();
AthenaApp.resumeDemo();
AthenaApp.cancelDemo();
AthenaApp.retryTask('analyze');
AthenaApp.getState();
AthenaApp.destroy();
```

## Pi event and session adapter

The current primary-source contracts and operation icons are listed in `PI-EVENT-MAP.md`. The browser does not import a Node SDK or open a transport itself. A host can forward decoded events:

```js
AthenaApp.handlePiEvent(event);
AthenaApp.getState().piActivity;
AthenaApp.getState().reply;
AthenaApp.resetPiActivity(); // Presentation reset; not a backend cancellation.
```

Or bind a compatible in-process session or host proxy:

```js
const detach = AthenaApp.attachPiSession(session);
// session.subscribe(listener) is required.
// Optional session.prompt(text, options) receives explicit submissions.
// Optional session.abort() receives the composer's cancel request.
// No prompt is sent merely by attaching; available current state is read.
detach();
```

For full functionality, bind the supplied native host adapter or a host-provided RPC transport:

```js
AthenaApp.attachPiSession(nativeHostAdapter); // mode:'host', capability list, request/send/subscribe.
AthenaApp.attachPiTransport(rpcTransport);   // mode:'rpc', request or send, plus subscribe.
AthenaApp.respondPiUI(requestKey, { confirmed: false }); // Use the qualified key from the pending request.
AthenaApp.getState().piRuntime;
```

`request(command)` returns the official response envelope. With a send-only transport, the bridge correlates streamed responses by request ID and command. `send(response)` also forwards extension dialog responses using their original request IDs. A raw session binding exposes only detected methods; use the host adapter for replacement, resources, and extension-aware shell execution. A session's absence of an operation is an unavailable capability, never a simulated success.

Connection and session generations reject stale results. Successful branch navigation resets the displayed branch even if the session ID stays the same; cancelled navigation preserves it. Read-only state refreshes do not submit prompts or execute tools. Actual prompt acceptance (`started`, `queued`, `handled`) is separate from final `agent_settled`. Standalone manual compaction and its retries remain control activity rather than creating an answer that waits for a nonexistent settlement event.

The returned cleanup and event callback are guarded by the binding generation. A stale callback or cleanup from an earlier session cannot affect its replacement. Detach and UI destroy unsubscribe without claiming to stop the external session. Cancellation waits for `agent_settled`; a resolved abort request alone does not mark the UI complete. Event-only sessions without an abort adapter show a disabled cancel control. A failed abort request restores retryability.

Connected composer submissions support text and, when the connection/model permits them, PNG/JPEG/WebP/GIF `ImageContent` objects. Text/code attachments up to 1 MiB are included intact as explicit attached-file text, then the whole combined prompt is checked against the connection input limit. Oversize input is rejected without truncation. Other binary formats require a host file-reference service; sample project context requires actual host resolution. Unsupported content remains in the draft. The native adapter can stage/resolve opaque file references through an explicitly supplied fileService; see [pi-bridge-contracts.d.ts](../integrations/pi-bridge-contracts.d.ts). Actual `File` objects are retained until acceptance; failures and newer queued drafts remain recoverable. The unbound sample composer retains its attachment preview behavior.

The + menu reflects `get_commands`: extensions, skills and prompt templates. Selecting one stages its exact slash command and preserves the user's instructions. It never auto-submits. While a response runs, explicit composer controls can steer or queue a follow-up. `clear_queue` preserves the returned removed text; the composed Stop and clear action invokes clear before abort.

Direct shell requests use a separate, inline command record keyed by the actual request ID. Partial `bash_execution_update` chunks and the final response update the same row. A manual shell result does not pretend that a model answer has finished. Native shell execution goes through the host adapter's extension interception.

Pi tool rows are keyed by `toolCallId` and update in place, preserving expanded details and focus. File/command inputs and results are safe plain text. Partial output follows the tool contract in the event map. Assistant text is appended when possible and reconciled with authoritative block/message endings; thinking payload text is not rendered. Completion uses `agent_settled`, not a potentially intermediate `agent_end`.

`AthenaApp.previewPiActivity()` and **Demo options → Preview response** emit authored events for all eight current built-in tool names and a final streamed answer. This does not create a Pi session or perform operations. The small preview label remains visible during generation. Demo transport timers are cleared on cancel, reset, replacement, and destroy.

The ordinary reply renderer exposes `begin`, `append`, `replaceText`, `setPhase`, and `end`. Its `AthenaAgentSteps` component uses only observed Waiting/Thinking/Replying milestones; tool/compaction/retry detail does not duplicate the existing tool rows. Actual successful completion immediately folds the list into a reopenable summary; stop/error never becomes success. Motion follows received phase and chunks; reduced motion never invents the remainder of an external response or ends the stream early.

Extension select/confirm/input/editor requests are keyed by connection/session generation. All unanswered requests remain in the pending collection; the workbench paginates 20 at a time. Cancel/expiry forwards a cancellation response to the original runtime. A rejected send leaves the request pending with its error; no cancellation acknowledgement or approval is fabricated. Notify/status/widget/title/editor-text updates are rendered as safe text. A proposed editor value is offered for explicit insertion so it cannot overwrite the current draft. Modal focus/inertness is owned by the shell and workbench together. Arbitrary terminal UI factories are unsupported; see the capability document for the exact boundary.

The shell owns layout, focus, modal inertness, and lifecycle. Views own selection and presentation preferences. Changing views does not start, pause, or reset execution.

`execution` is a compatibility navigation route, not a side-panel view. It closes the right panel and calls `AthenaWorkspaceChrome.revealTool({ taskId, toolId })`, opening the Thinking and matching tool disclosures, scrolling to the summary, and focusing it only when the conversation is available. It never changes the user's project-sidebar preference. Legacy `openSurface('terminal')` and `openSurface('execution')` use the same route. The right panel has one canonical toggle in the main header.

Inline details keep command, working directory, exit code, log/output format, copy/download actions, approvals, retries, and result links beside the activity. Copy failure reveals a readonly text field in that same location. Unspawned tools may be inspected as pending text rows without showing an agent mark; their expanded state transfers when the agent starts.

## Development execution contract

Real execution uses `AthenaWorkspaceSession` and the [TaskManager adapter contract](../integrations/task-manager.d.ts). TaskManager schedules work; the browser subscribes and forwards supported commands. A Pi-only connection supplies messages/tools but does not supply a task graph. Runtime artifact records and exact versions never fall back to this development catalog.

`AthenaWorkspaceStore.create()` returns:

```js
getState()
subscribe(listener) // Immediate frozen snapshot; returns unsubscribe.
start()
pause()
resume()
cancel()
retryTask(taskId)
decideApproval(approvalId, 'approved' | 'rejected')
setScenario('success' | 'analysis-error') // Only while ready.
configure({ parallelLimit })
reset()
destroy()
```

Snapshots include `run`, `configuration`, `tasks`, `tools`, `agents`, `approvals`, `events`, and `artifacts`. Cross-view navigation uses IDs, not display labels or array positions. Artifact-available events include exact `artifactId` values.

Task/tool states are `queued`, `running`, `paused`, `blocked`, `succeeded`, `failed`, and `cancelled`. New runs are `ready`. Approval states are `pending`, `approved`, and `rejected`.

The agents collection starts empty. Add an agent only when the harness confirms a task started. Queued tasks may show their planned role but no summoned agent mark. Retries can reuse the task agent while recording a new attempt event.

Pass the stable runtime `agent.id` as `agentId` to `AthenaAvatars.html({ agentId, role, status, size })`. A deterministic identity hash selects a geometric shape, orientation, and muted tone; it does not rerandomize on progress, role, or status changes. The mark is decorative and adjacent controls/text supply its accessible name and status. Grouped conversation marks, workflow rows, and timeline events use the same identity.

Only completed outputs belong in the run's artifacts. The separate example catalog is explicitly marked. Do not relabel an example as a real output before the adapter supplies that result.

Timestamps are epoch milliseconds. Demo elapsed time excludes pauses and approval waits. Histories are bounded; a production adapter should provide paginated history for large runs.

## Adapter responsibilities

Keep the demo scheduler isolated. Attach the Athena TaskManager adapter to the runtime projection instead; it publishes actual scoped snapshots and owns all scheduling. Commands and task text remain data; renderers must not execute strings. The adapter owns process lifetime, stream ordering, cancellation acknowledgments, reconnection, approval enforcement, tool limits, and artifact provenance.

Each approval identifies its task, tool, command, working directory, allowed scope, and expected effect. Closing leaves it pending; rejection prevents that action starting. New attempts may require fresh requests. UI consent is not blanket approval for unrelated operations.

Model preferences are in `AthenaApp.getState().models.saved`; their storage mode distinguishes local preferences from a host-confirmed configuration. Settings shows app default, project default, conversation model, and the execution-start model separately. Only development mode applies the local parallel limit to the timer fixture; real scheduling limits belong to TaskManager. Connected Pi model selection, supported thinking levels, usage, and context data come from `AthenaApp.getState().piRuntime` and actual responses. Credentials and process setup stay in the host.

The composer calls `set_model` with an exact provider/model pair returned by `get_available_models`, or `set_thinking_level` with a value returned by `get_available_thinking_levels`. Model and reasoning changes are serialized. Model changes immediately invalidate the old supported-level list; `thinkingLevelsPending` stays true until a fresh list arrives (or the current read fails). Revision guards prevent an older state or levels read from undoing a later selection. The two menus do not submit a message or change provider credentials. Failed selections retain the previous confirmed model and the user's draft.

## Knowledge and attachments

Knowledge keeps imported Files and PDF blob URLs privately in session memory. Its public snapshot contains metadata. The explicit excerpt callback returns a short source excerpt that is appended to the draft without submission.

Composer submission receives actual attachment Files and selected context items. With no host, only explicitly enabled development mode can emit a labeled sample response; normal preview submission preserves the draft and asks for a connection. With a host it serializes supported images/text as described above; arbitrary file upload/storage and PDF extraction still require a host-specific adapter. Selecting or importing a file never claims it has been analyzed.

Keep authored RC examples distinct from measurements. Real artifact records should carry schema, content, units, creation attempt, input references, and validation evidence.

## Verification scope

Node + LinkeDOM tests cover state, events, modal focus, safe rendering, and cleanup using explicit environment shims. They are not browser or screen-reader tests. The original sample PDF has historical inspection notes; those do not verify this revision’s native PDF view or a connected exact-version exporter. Native file dialogs, clipboard, downloads, and PDF embedding still need validation in the target desktop app.

## Versioned project research

Manuscript and Research note share the `AthenaResearchRecords` store, document ID and selected revision. New revisions preserve old evidence/review and begin unreviewed. Project storage and PDF export require exact host receipts. The original authored PDF is an explicit reference, separate from the current document export. Knowledge state is scoped by project and distinguishes device notes, session files, host originals, extraction, and review. See [research-records.d.ts](../integrations/research-records.d.ts) and the [storage/version handoff](RUNTIME-READINESS.md#storage-and-version-boundaries).
