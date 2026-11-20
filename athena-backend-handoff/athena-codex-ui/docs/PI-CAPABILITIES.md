# Pi capabilities exposed by Athena

Verified against **@earendil-works/pi-coding-agent 1.5.2**, repository commit **653f332b6fe22e2e927dd3d553d20234a3de27f0**, on November 19, 2026.

This implementation covers **33 official RPC commands**, **18 additional native-host commands**, and **9 extension UI request methods**. Availability comes from the connected host. The standalone preview does not create a Pi session, run a shell, discover credentials, or contact a model.

## Primary references

- [SDK integration](https://github.com/earendil-works/pi/blob/653f332b6fe22e2e927dd3d553d20234a3de27f0/packages/coding-agent/docs/sdk.md)
- [RPC commands](https://github.com/earendil-works/pi/blob/653f332b6fe22e2e927dd3d553d20234a3de27f0/packages/coding-agent/docs/rpc-commands.md)
- [Exact command and response unions](https://github.com/earendil-works/pi/blob/653f332b6fe22e2e927dd3d553d20234a3de27f0/packages/coding-agent/src/modes/rpc/rpc-types.ts)
- [Official native-to-RPC mapping](https://github.com/earendil-works/pi/blob/653f332b6fe22e2e927dd3d553d20234a3de27f0/packages/coding-agent/src/modes/rpc/rpc-mode.ts)
- [Session events](https://github.com/earendil-works/pi/blob/653f332b6fe22e2e927dd3d553d20234a3de27f0/packages/coding-agent/docs/json.md)
- [Extension UI protocol and limitations](https://github.com/earendil-works/pi/blob/653f332b6fe22e2e927dd3d553d20234a3de27f0/packages/coding-agent/docs/rpc-extension-ui.md)
- [Native AgentSession](https://github.com/earendil-works/pi/blob/653f332b6fe22e2e927dd3d553d20234a3de27f0/packages/coding-agent/src/core/agent-session.ts), [AgentSessionRuntime](https://github.com/earendil-works/pi/blob/653f332b6fe22e2e927dd3d553d20234a3de27f0/packages/coding-agent/src/core/agent-session-runtime.ts), and [SessionManager](https://github.com/earendil-works/pi/blob/653f332b6fe22e2e927dd3d553d20234a3de27f0/packages/coding-agent/src/core/session-manager.ts)

## Official RPC commands

Every command accepts an optional string id. Responses echo that id with type=response, command, success, and optional data/error. A successful prompt response acknowledges acceptance; events continue independently.

| Command | Request arguments | Response data / purpose |
|---|---|---|
| prompt | message, images?, streamingBehavior? | disposition: started, queued, or handled |
| steer | message, images? | disposition: queued or handled |
| follow_up | message, images? | disposition: queued or handled |
| abort | — | Waits for the active operation to become idle |
| clear_queue | — | steering[] and followUp[] draft text |
| new_session | parentSession? | cancelled |
| get_state | — | Model, thinking level, streaming/compaction/queue/session state |
| set_model | provider, modelId | Selected model |
| cycle_model | — | model, thinkingLevel, isScoped; null if unavailable |
| get_available_models | — | models[] |
| set_thinking_level | level | Set current reasoning level |
| cycle_thinking_level | — | level; null if unavailable |
| get_available_thinking_levels | — | levels[] supported by current model |
| set_steering_mode | mode | all or one-at-a-time |
| set_follow_up_mode | mode | all or one-at-a-time |
| compact | customInstructions? | CompactionResult |
| set_auto_compaction | enabled | Boolean |
| set_auto_retry | enabled | Boolean |
| abort_retry | — | Cancel active retry |
| bash | command, excludeFromContext? | BashResult; streamed updates carry request id |
| abort_bash | — | Cancel direct shell execution |
| get_session_stats | — | Counts, token usage, cost, optional contextUsage |
| export_html | outputPath? | path |
| switch_session | sessionPath | cancelled |
| fork | entryId | text?, cancelled |
| clone | — | cancelled |
| get_fork_messages | — | messages[] with entryId and text |
| get_entries | since? | entries[] and leafId |
| get_tree | — | tree[] and leafId |
| get_last_assistant_text | — | text or null |
| set_session_name | name | Set a nonempty trimmed name |
| get_messages | — | messages[] |
| get_commands | — | commands[] from extensions, prompt templates, and skills |

ImageContent is an object with type=image, base64 data, and mimeType. General Files/PDFs require the host's upload/path/context integration; they are not interchangeable with this image payload.

The thinking-level vocabulary is off, minimal, low, medium, high, xhigh, max. Show only the levels returned by the selected model. Model catalogue entries provide display metadata, supported input kinds, context window, maximum output tokens, and costs per million tokens.

## Native-host additions

These names belong to Athena's host adapter, not the public Pi RPC protocol. They are advertised only when their supporting SDK methods exist.

| Host command | Arguments | Native source |
|---|---|---|
| list_sessions | all?, cwd?, sessionDir? | SessionManager.list / listAll |
| get_context_usage | — | session.getContextUsage |
| get_tools | — | getAllTools / getActiveToolNames / getCallableToolNames |
| set_active_tools | toolNames[] | setActiveToolsByName |
| navigate_tree | targetId, summarize?, customInstructions?, replaceInstructions?, label? | session.navigateTree |
| reload | — | session.reload |
| get_resources | — | resourceLoader getters |
| import_session | inputPath, cwdOverride? | runtime.importFromJsonl |
| set_session_label | entryId, label? | sessionManager.appendLabelChange |
| export_jsonl | outputPath? | session.exportToJsonl |
| abort_compaction | — | session.abortCompaction |
| abort_branch_summary | — | session.abortBranchSummary |
| get_system_prompt | — | Read-only session.systemPrompt |
| get_scoped_models | — | session.scopedModels |
| set_scoped_models | models[{provider,modelId,thinkingLevel?}] | session.setScopedModels |
| get_cache_warming | — | cacheWarmingStatus / getCacheWarmingMode |
| set_cache_warming | mode | setCacheWarmingMode; off, streaming, idle |
| get_settings | — | Effective/global/project settings inspection |

The adapter does not offer a generic arbitrary-settings writer or credential-reading command. Provider login, arbitrary provider registration, package installation, project trust, process creation, and file upload remain explicit host integrations.

The configured tool registry and active tool set are different. Built-ins are read, bash, powershell, edit, write, grep, find, ls; the default active set is read, bash, edit, write. Deferred/codemode tools can be callable without being directly declared to the model. Refresh the returned actual tool state after changing it: the SDK ignores unknown or hidden tool names.

## Sessions, queues, and completion

AgentSessionRuntime owns new/switch/fork/import operations. They replace the current session and cwd-bound services, so subscriptions must follow runtime.session. Extensions may cancel replacement. The UI should wait for cancelled=false and use the new authoritative instance.

There is no native runtime.clone method. The official clone command forks the current leaf with position=at. A normal fork uses position=before on a previous user-message entry and returns its text. Navigating the tree stays in the same session file. Append-only history preserves abandoned branches; get_entries is broader than the current model-context messages, and its since cursor must identify an existing entry.

While streaming, prompt requires an explicit streamingBehavior of steer or followUp. Steering enters after the current assistant turn finishes its tool calls; follow-up enters when pending work ends. Both delivery modes support all and one-at-a-time.

Abort does not clear queued work. An explicit stop-everything action should clear_queue, preserve returned drafts, then abort. Pi has no built-in pause/resume protocol in this contract. Demo pause is not a live SDK capability.

Use agent_settled as the terminal boundary. Agent_end can precede automatic retries, compaction recovery, or queued work. Prompt success=true means accepted/queued/handled; a later failure arrives through the event stream.

## Context and accounting

Session statistics include user/assistant/tool counts, cumulative input/output/cache-read/cache-write tokens, total tokens, and cost. Totals can include tool-reported usage and compaction or branch-summary generation across the entire session.

Current context usage is a separate estimate: tokens, contextWindow, percent. After compaction, tokens and percent can be null until a new assistant response supplies valid usage. Render that as unknown, not 0%. An absent contextUsage means the host cannot provide a current window estimate. The compaction result's estimatedTokensAfter is heuristic, not an exact provider count.

Direct bash output is stored in session history. Unless excludeFromContext=true, it reaches the model on the next prompt. A successful shell request is separate from an assistant reply.

## Resources and extension UI

Get_commands combines extension commands, prompt templates and skill:name commands, with their source metadata. Invoke these through prompt using their exact slash name. CLI-only TUI commands such as /settings and /hotkeys are not callable prompt commands.

SDK sessions do not automatically load CLI built-in codemode, tool_search or MCP extensions. The host must configure their factories and bind extensions. MCP connects during session_start, so extension binding is an explicit host action. Source: [SDK configuration](https://github.com/earendil-works/pi/blob/653f332b6fe22e2e927dd3d553d20234a3de27f0/packages/coding-agent/docs/sdk.md#codemode-mcp).

| Extension UI method | Request fields | Response |
|---|---|---|
| select | title, options[], timeout? | value or cancelled |
| confirm | title, message, timeout? | confirmed or cancelled |
| input | title, placeholder?, timeout? | value or cancelled |
| editor | title, prefill? | value or cancelled |
| notify | message, notifyType? | None |
| setStatus | statusKey, statusText? | None; absent text clears |
| setWidget | widgetKey, widgetLines?, widgetPlacement? | None; absent lines clears |
| setTitle | title | None |
| set_editor_text | text | None |

Dialog responses must carry the original id. Select values must match an offered option. Dismissal, expiration and stale responses never imply approval. Backend dialog timeouts and native AbortSignal cancellation must clear the corresponding UI.

RPC mode supports these primitives, with ctx.mode=rpc and ctx.hasUI=true. It does not support native terminal components, raw terminal input, custom editor/header/footer factories, theme switching, terminal-specific autocomplete, working-indicator overrides, or tools-expanded control. Component factories cannot be treated as HTML.

Thinking is displayed as a phase, without raw internal reasoning. Tool rows use toolCallId and optional parentToolCallId; authoritative message endings replace reconstructed partial data. Partial-result merge behavior is tool-specific. Subagent orchestration and role-based model routing are Athena/extension capabilities, not a generic native Pi subagent API.

See [PI-HOST-ADAPTER.md](PI-HOST-ADAPTER.md) for construction, session rebinding, response normalization and verification scope.
