# Athena · Research workspace

A self-contained research-workspace UI that preserves the existing English interface, Athena beta icon, warm ivory appearance, resizable panels, geometric agent marks, and quiet inline tool activity. This revision fixes input/request integrity and prepares explicit runtime, model, project, and document contracts.

Open **athena-preview.html** in a browser. It embeds the application scripts, styles, Lucide icons, brand assets, and the original authored sample PDF; no server is needed to inspect the preview.

**The downloaded preview is disconnected.** It does not create a Pi provider, Athena TaskManager, connection service, file store, extraction service, or PDF exporter. An embedding host must supply those adapters. Unsupported actions remain unavailable, and local preferences or sample outputs are not labeled as successful backend operations.

The complete implementation/remaining-backend mapping for all 15 requested requirements is in [Runtime readiness](docs/RUNTIME-READINESS.md).

## Where to see the changes

1. Open **Settings** with the gear or Ctrl/⌘,. The six categories are **Models & connections**, **Agents & execution**, **Tools & plugins**, **Files & history**, **Appearance & notifications**, and **About & diagnostics**. Existing controls are reused inside those categories.
2. In **Models & connections**, inspect the four model scopes and separate **Validate format**, **Save settings**, and **Check connection** actions. A disconnected save is labeled a local preference; a host check is unavailable without a compatible adapter.
3. Open **Artifacts → Research note**. The current text, document ID, revision, review status, and storage scope come from the same record as **Manuscript**. Use **Open in Manuscript**, edit the text, and **Keep revision** to create a new unreviewed session revision while retaining the earlier version. Project saving and PDF export require a real research service.
4. Expand **Original sample PDF/reference** to inspect the preserved authored three-page report, its text pagination, zoom, evidence links, or native PDF view. This asset is separate from the current or edited document's PDF export.
5. Open **Knowledge** to import supported local files, search, pin sources, or write a note. Source metadata distinguishes project, version, original location, storage, extraction, and review. Native PDF display does not imply content extraction or understanding.
6. Use **Add project** for project creation and **New research** for a new conversation. Without the required host, creation is unavailable. **Write in the current conversation instead** focuses the existing draft without creating or renaming a project/session.
7. Resize the sidebars, use the icon toggles, and inspect the existing composer **+**, model, and **Reasoning** controls. Model choices come from an attached runtime; the preview does not invent a model catalog.

### Optional development examples

Enable **Settings → About & diagnostics → Development examples**. Then use **Demo options → Run demo** or **Preview response** in the conversation.

The finite sample workflow is source review and dataset inspection, followed by analysis, validation, and writing. It exercises inline agents, approvals, retries, output links, and timeline events using authored data and timers. **Preview response** shows Waiting → Thinking → tool operations → Replying without running a tool or model. Nothing starts on page load. Connecting an actual runtime disables these development scenarios.

The old timer scheduler remains in `ui/workspace-store.js` for development. Actual execution belongs to **Athena TaskManager**; the UI subscribes to its state and forwards supported explicit commands.

## Runtime, input, and inline activity

The optional Pi host adapter and browser bridge retain the operation mapping documented in [Pi capabilities](docs/PI-CAPABILITIES.md) and [native host integration](docs/PI-HOST-ADAPTER.md). Runtime administration is integrated into Settings. The composer connection caption is informational; model and reasoning selection remain directly available inside the composer.

The reply-generation indicator reuses the MIT-licensed Kokonut UI Agent steps adaptation. Its phase/wave/ring/check motion follows observed Waiting, Thinking, and Replying events; successful completion folds the list into a reopenable summary. Tool activity remains in frameless inline disclosures. Raw model thinking text is not used as activity prose. Reduced motion retains state and received text. See [Agent steps](docs/AGENT-STEPS.md), [event/icon mapping](docs/PI-EVENT-MAP.md), and [motion provenance](MOTION.md).

Input handling is explicit:

- Messages are not silently truncated. The default transport limit is **262144 UTF-16 code units**, configurable by the connection. Excess input is rejected with its actual size and limit, preserving the draft.
- Supported image attachments use actual Pi image payloads when the connection/model accepts images. Without a file service, text/code files up to **1 MiB** are read intact, combined with the prompt, and checked against the total input limit. Unsupported binaries and oversize files remain in the draft.
- A host can instead supply file staging and reference resolution. References must identify actual stored files and their scope/version. Every attachment must be confirmed; the full resolved context is checked again by the native adapter. Filenames alone are not proof that content reached the model.
- Extension requests are retained in a full pending queue; the workbench paginates at 20 visible requests. Cancel is sent to the original runtime request. Failed cancellation stays pending with an error.
- Companion `done`/`message_end` events finalize one message. Stable IDs and message boundaries prevent duplicates without merging separate identical answers.

These contracts are specified in [pi-bridge-contracts.d.ts](integrations/pi-bridge-contracts.d.ts). The host still owns provider token limits, actual file access, transport delivery, durable pending work, and cancellation acknowledgement.

## Shared runtime state and model scopes

`ui/workspace-session.js` projects TaskManager snapshots and observed Pi activity into the existing views. Runtime mode uses actual project, session, run, task, agent, tool, and artifact identifiers. Artifact selection carries its version; missing real artifacts are never replaced with static RC examples. Unknown progress remains unknown. A Pi-only connection can show messages/tools while Workflow explains that TaskManager is not connected.

A confirmed session ID and an attached model transport are separate states. The UI can show the host-created conversation with a connect-model notice while sends and model changes remain blocked until the actual Pi session ID matches. The host must coordinate session activation and snapshots; the UI does not send a new conversation's prompt to an older transport.

| Model scope | Owner and effect |
| --- | --- |
| App default | The connection configuration supplies the confirmed application default for future session resolution. A local-only preference is labeled separately. |
| Project default | TaskManager/project service owns the project override or inheritance. |
| Current conversation | The active Pi session reports its confirmed model and supported reasoning levels. Composer choices are serialized and capability-checked. |
| Execution-start model | TaskManager/run state records the model used when the run starts. Changing defaults or later conversation preferences does not rewrite it. |

Endpoint **Validate format** does no I/O. **Save settings** either stores an explicitly labeled local preference or awaits a valid `saveConfig` receipt. **Check connection** asks an attached host to contact the endpoint and does not save those fields. New-session requests use the confirmed configuration ID and model resolution. Credentials and network access stay in the host.

## Documents, source versions, and storage

The preview's canonical document is `research-note` in `project-rc`. Manuscript, Research note, copy/Markdown actions, and PDF export refer to that same record and an exact version. Editing does not mutate previous text/evidence or carry its review forward. A new kept revision is unreviewed. Runtime canonical previews require a matching host-confirmed document version.

The original `assets/sample-research-note.pdf` remains an immutable authored reference. Its RC calculation is a synthetic ideal-circuit example, not measured performance, an external research paper, or the exported PDF of edited text. The original beta brand provenance remains in `assets/provenance.json`.

| Data | Behavior without a host |
| --- | --- |
| UI preferences and panel widths | Immediately saved on the device where storage is available; session-only fallback is reported. |
| Model/role preferences | Require **Save settings**; local saves do not claim endpoint connection or shared configuration storage. |
| Knowledge notes and pins | Stored under project-specific device keys where supported. |
| Imported files | Kept as actual `File` objects in session memory; never uploaded automatically. |
| Document versions and drafts | Kept in session memory. **Keep revision** preserves local history; it is not a project-storage receipt. |
| PDF export, file persistence, extraction | Unavailable until the relevant service capability is attached and returns an exact receipt. |

Knowledge retains PDF/TXT/MD/CSV import, local text search, notes, pins, and explicit excerpt insertion. Project changes isolate state and unfinished notes. **Use excerpt in chat** inserts a labeled excerpt without submitting it; larger source/display excerpts are explicitly identified. A new source version retains earlier metadata and gets its own review/extraction state. A local PDF's bytes are never reused as the preview of a different source version.

The research service contract is [research-records.d.ts](integrations/research-records.d.ts). It defines document load/save/export and source list/store/extract operations, exact IDs/versions, original locations, review events, and atomic save preconditions. No storage transport, OCR engine, embedding index, or PDF generation backend is included.

## Host integration

The shell exposes the following attachment pairs:

| Entry point | Supplied host object |
| --- | --- |
| `AthenaApp.attachPiSession(adapter)` / `detachPiSession()` | Existing session or native host proxy; see [Pi host adapter](docs/PI-HOST-ADAPTER.md). |
| `AthenaApp.attachPiTransport(transport, options?)` | Existing RPC/request/send/subscribe transport. |
| `AthenaApp.attachTaskManager(adapter)` / `detachTaskManager()` | Ordered snapshots and supported lifecycle/run commands from [task-manager.d.ts](integrations/task-manager.d.ts). |
| `AthenaApp.attachConnectionManager(adapter)` / `detachConnectionManager()` | Configuration save/check and session construction from [connections.d.ts](integrations/connections.d.ts). |
| `AthenaApp.attachResearchService(adapter)` / `detachResearchService()` | One research service or separate `documents`/`knowledge` adapters from [research-records.d.ts](integrations/research-records.d.ts). |

Attaching an adapter does not manufacture connected, saved, extracted, or exported state. The host must return the actual result or report the unavailable/failure state. The [readiness report](docs/RUNTIME-READINESS.md#exact-host-entry-points) lists the complete current navigation, creation, draft, and document entry points. The [integration handoff](docs/RUNTIME-INTEGRATION.md) covers Pi event/session presentation and host lifecycle boundaries.

## Keyboard and responsive behavior

Projects remain visible by default and can be folded with the existing icon. Sidebar/panel resize handles support arrows, Shift for larger steps, Home/End limits, double-click reset, and Escape cancellation. The right side view has one canonical header toggle and changes to an overlay when space is limited.

The fixed root 520px minimum height is removed. Shrinkable content regions, scrollable modal bodies, and low-height settings rules keep controls available in the layout contract. Focus is reconciled when an area becomes hidden/inert. The model list uses a single roving tab stop, arrow/Home/End navigation, normal search-field editing, and explicit menu exit behavior. These are source/DOM-tested changes; actual browser and assistive-technology behavior still needs target-environment verification.

## Source layout

- `app.html`, `app.css`, `app.js` — existing shell, composer integration, navigation, lifecycle/draft handling, and document binding.
- `ui/pi-runtime.js`, `ui/pi-activity.js`, `ui/pi-session-view.*` — capability-aware bridge, input/request integrity, normalized events, and inline tool presentation.
- `integrations/pi-host-adapter.mjs` — optional adapter for existing SDK objects; no backend process or transport is constructed.
- `ui/workspace-session.js` — actual runtime projection and TaskManager command routing.
- `ui/workspace-store.js` — isolated finite development scheduler and authored sample state.
- `ui/workspace-chrome.*`, `ui/workspace-views.*` — reused inline agents/tools, approvals, workflow, artifacts, and timeline.
- `ui/connection-manager.js`, `ui/model-settings.*`, `ui/chat-model-picker.*` — configuration/connection contracts, four model scopes, composer choices, and keyboard handling.
- `ui/research-records.*`, `ui/knowledge.*` — document versions, research-service contracts, project source state, imports, notes, and extraction/review metadata.
- `ui/settings.*`, `ui/layout.css`, `ui/resize.*`, `ui/surfaces.*` — six settings categories and existing responsive workspace controls.
- `motion/`, `vendor/`, `assets/` — licensed motion source, Lucide, beta provenance, and original sample PDF.
- `integrations/*.d.ts` — explicit host boundary types; `docs/` explains their semantics and remaining work.
- `qa/` — deterministic Node/DOM and adapter-contract suites, with generated result files.

`DESIGN.md`, `export/`, `athena-authored-scenes.json`, and scene scripts preserve earlier design references. They are not captures of this updated application. Earlier standalone agent-manager/cute-avatar files are retained as source history and are not loaded by the build.

## Build and verify

```sh
python3 build.py
cd qa
npm ci
npm test
node --test pi-host-adapter-test.mjs runtime-integrity-test.cjs workspace-session-test.cjs connection-manager-test.cjs research-records-test.cjs workspace-views-test.cjs
```

The app is dependency-free at runtime. LinkeDOM is a development-only test dependency. The focused WorkspaceViews suite also accepts `ATHENA_QA_DEPENDENCIES` as an optional dependency-search directory when a shared development installation is used.

Use the current command output and `qa/integration-results.json` source hashes for pass/fail evidence; old fixed counts are not carried forward as proof for this revision. Bundle validation only checks the generated artifact and included sources.

For an M2 browser regression check, run `bun qa/m2-browser-test.js` from this directory after building. It launches the generated preview on a local wire fixture in Bun WebView, then checks agent history isolation, Workflow and Execution, task/run cancellation, result file links, replay, and reset. Set `ATHENA_BROWSER_WIDTH=390` for a narrow viewport and `ATHENA_BROWSER_EVIDENCE` to save screenshots to an existing directory. This fixture does not start a model or run a real job. See [Runtime readiness](docs/RUNTIME-READINESS.md#verification-evidence-and-remaining-acceptance-work) for separate backend acceptance.
