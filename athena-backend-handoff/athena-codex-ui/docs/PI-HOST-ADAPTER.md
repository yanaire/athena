# Native Pi host adapter

The framework-independent bridge lives in **integrations/pi-host-adapter.mjs**. It adapts an existing SDK session/runtime to Athena's request/event contract. It contains no SDK imports and never creates a backend process, calls a model, executes a shell, searches for credentials, or binds extensions during construction.

It targets **@earendil-works/pi-coding-agent 1.5.2**, commit **653f332b6fe22e2e927dd3d553d20234a3de27f0**. Exact source references and supported operations are in [PI-CAPABILITIES.md](PI-CAPABILITIES.md).

## Host construction

The host already owns runtime, the SDK SessionManager class, and any existing extension bindings/theme:

~~~js
import { createPiHostAdapter } from './integrations/pi-host-adapter.mjs';

const adapter = createPiHostAdapter({
  runtime,
  SessionManager,
  theme
});
~~~

For a single fixed conversation, pass session instead of runtime. Runtime-only lifecycle capabilities remain unavailable in that configuration.

Optional explicit fallbacks are sessionManager, modelRuntime, modelRegistry, resourceLoader, settingsManager and cwd. SessionManager with a capital S is the SDK class supplying static list/listAll; a manager instance alone does not provide session listing.

The stable returned object exposes:

~~~js
adapter.mode;                       // "host"
adapter.capabilities;               // live string[] getter
await adapter.request(command);    // response envelope
const off = adapter.subscribe(onEvent);
adapter.send(extensionUiResponse); // boolean: matched and accepted
adapter.refreshSession();
adapter.destroy();
~~~

Capabilities reflect actual available methods. A partial host can remain useful for streamed output without falsely advertising shell, model configuration, session switching, or exports.

## Connecting Athena

When UI and host share a privileged process, the adapter can be passed directly:

~~~js
const detach = AthenaApp.attachPiSession(adapter);
// Later:
detach();
adapter.destroy();
~~~

In Electron or another process-separated app, expose a narrow proxy for mode, capabilities, request, send and subscribe through the host's IPC/preload boundary. Pass that proxy to AthenaApp.attachPiSession. The browser does not import Node SDK objects or receive provider credentials.

For an existing explicit RPC transport, use Athena's transport entry point:

~~~js
const detach = AthenaApp.attachPiTransport({
  mode: 'rpc',
  request: command => transport.request(command),
  send: response => transport.send(response),
  subscribe: listener => transport.subscribe(listener)
});
~~~

Here transport is the host-provided JSON-lines/request bridge, not a server created by this preview. Request ids and response ids must survive the boundary unchanged. The send path forwards the complete extension_ui_response object; it must not replace the dialog id with a newly generated request id. A subscription must return an unsubscribe function.

## Following session replacement

The SDK runtime's setRebindSession setter owns one callback and has no public getter. The adapter does not overwrite an unknown callback by default.

After the adapter's own new_session, switch_session, fork, clone or import_session request, it rebinds to runtime.session. To cover external replacements and extension activity during replacement, choose one of these arrangements:

1. Call adapter.refreshSession(newSession) from the host's existing rebind hook.
2. Supply subscribeSessionChanges(callback), which registers with the host's own session-change notification and returns an unsubscribe function.
3. Set ownsRuntimeRebind=true only when this adapter exclusively owns the runtime hook.

For a new host that gives the adapter exclusive hook ownership:

~~~js
const adapter = createPiHostAdapter({
  runtime,
  SessionManager,
  theme,
  ownsRuntimeRebind: true,
  onRebind: async (session, bridge) => {
    await session.bindExtensions({
      ...existingBindings,
      ...bridge.extensionBindings
    });
  }
});
~~~

The host still explicitly performs its initial binding when ready:

~~~js
await runtime.session.bindExtensions({
  ...existingBindings,
  ...adapter.extensionBindings
});
~~~

Binding extensions can trigger session_start hooks and MCP connections. The factory never performs that action automatically. Preserve host-provided commandContextActions, abort/shutdown handling and lifecycle behavior in existingBindings.

Every session subscription is generation-guarded, so a stale callback from an outgoing session cannot alter the current UI. With exclusive ownership, destroy releases that hook. Without it, the host's hook remains untouched.

## Extension dialogs and notifications

Adapter uiContext implements the nine supported RPC-style UI methods. The host opts into it through adapter.extensionBindings, which supplies mode=rpc, uiContext and onError. Pass a real native Pi theme when extensions use the theme API.

Select, confirm and input accept the SDK's timeout and AbortSignal options. Editor accepts its title and prefill. A pending dialog is retained and replayed if a UI subscriber connects later.

The UI responds through send:

~~~js
adapter.send({
  type: 'extension_ui_response',
  id: request.id,
  value: selectedOption
});
~~~

Confirm uses confirmed:boolean instead of value. Any dialog can use cancelled:true. Invalid selected values, malformed response shapes, unknown ids and late responses return false without resolving a different request.

Timeout, signal abort, session replacement and destroy dismiss pending dialogs. Confirm resolves false; select/input/editor resolve undefined. Cancellation and teardown cannot become approval. Timers and abort listeners are removed, and reentrant teardown cannot leave a new approval pending.

Notify, setStatus, setWidget, setTitle and set_editor_text are one-way notices. Undefined status text or widget lines clear their keyed UI entry. Function-based widgets and native TUI component factories are not executed by this browser bridge.

## Events specific to this bridge

| Event | Meaning / UI response |
|---|---|
| host_session_changed | Contains sessionId and capabilities; reset/reload current session data |
| extension_ui_resolved | Contains id, method, reason and cancelled; close that exact pending dialog |
| host_error | A prompt failed after its acceptance response; display the error without a second response id |
| extension_error | Standard extensionPath/event/error report from the extension binding |

Extension resolution reasons are response, timeout, abort, destroy and session-changed. Ordinary Pi session and tool events continue through the same subscription.

## Response shapes for native extras

Official RPC response names remain unchanged. Native additions normalize their data for the browser:

| Command | data |
|---|---|
| get_context_usage | {contextUsage: object or null} |
| get_tools | {tools, activeTools?, callableTools?} |
| set_active_tools | Actual tool state when the host can read it back |
| get_resources | {skills:[], prompts:[], extensions:[], themes:[], contextFiles:[], diagnostics:[], systemPromptSource?, appendSystemPromptSources?} |
| get_scoped_models / set_scoped_models | {models:[{provider, modelId, thinkingLevel?, model}]} |
| get_cache_warming | {mode?, status?} |
| get_settings | {effective, global?, project?} |
| list_sessions | {sessions:[]} with ISO date strings |
| set_session_label | {entryId} for the newly appended label entry |
| export_jsonl | {path} |
| get_system_prompt | {systemPrompt} |

Extension resource records expose paths, source metadata and tool/command/flag/event names. Executable factories and the extension runtime object are omitted.

Native get_state includes actual extra getters isIdle, isRetrying, autoRetryEnabled, isBashRunning and retryAttempt when present. Missing state is not replaced with guessed defaults.

Set_model and set_thinking_level accept optional persist:boolean in native mode; the default is session-only. Cycle_model additionally accepts direction=forward/backward and optional persist. Unsupported thinking levels are rejected against the current model's supported list.

## Prompt and execution semantics

Official 1.5.2 prompt uses preflightResult to acknowledge started/queued/handled before completion. This lets abort and steering arrive while generation continues. A legacy facade that resolves without calling the hook returns completed=true instead of inventing a disposition.

The adapter does not mark a run complete on prompt acknowledgement. Continue observing events through agent_settled. Errors after acceptance become host_error events.

Bash follows the official RPC sequence: consult extensionRunner.emitUserBash, then record an extension-supplied result or call executeBash with any supplied operations. This preserves extension interception and remote shell implementations.

Clear_queue and abort are separate actions. An explicit stop-everything UI invokes them in that order and retains returned draft text. The adapter does not silently discard the queue.

## Public-data boundary

The adapter never calls credential-reading methods. Returned model objects use a display-field whitelist. Known credential-bearing fields, headers and environment maps are omitted from returned objects; URL fields omit embedded credentials and query fragments.

Plain user message text is preserved, including meaningful URL query parameters. Raw thinking blocks and thinking-delta text are removed from public events/history; phase, contentIndex and character count can remain. Projection does not mutate the SDK's original messages, model objects, or request arguments.

Attachment storage/reference resolution can be supplied explicitly through `fileService`; its required shape and full-input limits are in [pi-bridge-contracts.d.ts](../integrations/pi-bridge-contracts.d.ts). The adapter itself provides no storage backend. Arbitrary provider registration, package installation and secret entry require dedicated host integrations. The adapter does not infer them from the presence of subscribe.

## Cleanup and verification

Destroy unsubscribes the bridge, clears pending dialog work and releases only a runtime hook it explicitly owns. It does not abort, dispose or shut down the caller's session.

Verification commands:

~~~sh
node --check integrations/pi-host-adapter.mjs
node --test qa/pi-host-adapter-test.mjs
~~~

The mocked Node contract suite covers observation-only attachment, capability gating, accepted prompts versus completion, concurrent cancellation, queues, model lookup, secret-safe projection, session replacement and hook ownership, durable history cursors, extension shell interception, normalized resources, dialog correlation, timeouts, aborts, teardown and raw-thinking removal.

These tests do not start the real SDK or a provider and do not verify a browser. The host must supply a real initialized SDK runtime and its event/transport/filesystem boundaries before the UI controls operate on live work.
