# Pi activity presentation

Verified against the Pi repository on 2026-11-19. This module consumes event objects and returns UI state. It does not import the SDK, create a session, run tools, open a transport, or send a prompt.

## Primary references

- [SDK integration and subscriptions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
- [Session, message, tool, retry, and compaction events](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/json.md), source blob `ca76d632665d8878a4388437f8df0b6991e23365`
- [Agent event types](https://github.com/earendil-works/pi/blob/main/packages/agent/src/types.ts), source blob `24bdd7531caf7035653255acab9c04e0ef5f485f`
- [Built-in tool registry](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/tools/index.ts), source blob `5e8fd5b36912371c1e54878356bf40356d619aeb`

The current coding-agent session API distinguishes the end of one agent run from session settlement. `agent_settled` is the terminal signal used here; `agent_end` can precede recovery or queued work. A host using an older low-level agent API must explicitly adapt its own terminal boundary.

## State icons

| UI state | Lucide icon | Event mapping |
| --- | --- | --- |
| Waiting | `hourglass` | Agent/assistant start before content; between operations |
| Thinking | `brain-circuit` | `thinking_start`, `thinking_delta` |
| Replying | `message-square-text` | `text_start`, `text_delta`, `text_end` |
| Preparing tool call | `braces` | `toolcall_start`, `toolcall_delta`, `toolcall_end` |
| Running | `wrench` | Active tool execution; individual rows use their tool icon |
| Retrying | `rotate-cw` | Retry scheduling or an agent end with `willRetry` |
| Compacting context | `archive` | Compaction begins |
| Complete | `check` | Successful `agent_settled` |
| Needs attention | `circle-alert` | Response, final retry, or extension error |
| Stopped | `square` | Aborted settlement |
| Awaiting approval | `shield-check` | Host permission UI; not a generic SDK tool event |

`ui_prompt_start/end` compatibility input represents a host/extension UI boundary. It is distinct from the core session stream. `idle` and `paused` are presentation helpers for the local interface.

## Tool icons

| Tool | Icon | Detail |
| --- | --- | --- |
| `read` | `file-text` | File path |
| `write` | `file-plus-2` | File path |
| `edit` | `file-pen-line` | File path |
| `bash` | `square-terminal` | Command |
| `powershell` | `terminal` | Command |
| `grep` | `search-code` | Pattern and path |
| `find` | `files` | Pattern and path |
| `ls` | `folder-open` | Directory |
| Optional `codemode` | `braces` | Supplied description |
| Other extension tools | `plug` | Tool name and available path/query |

The first eight names are the current built-in registry. `codemode` and arbitrary extension names are presentation fallbacks and are not advertised as enabled SDK tools. Every icon is available in the existing bundled Lucide version; no external asset is requested.

## Browser module API

```js
const activity = AthenaPiActivity.create({
  toolOutputModes: { custom_delta_tool: 'append' }
});
const unsubscribe = activity.subscribe(snapshot => render(snapshot));
activity.receive(event);
activity.getState();
activity.reset();
unsubscribe();
activity.destroy();

AthenaPiActivity.phase('thinking');
AthenaPiActivity.phaseIcon('thinking');
AthenaPiActivity.toolPresentation('read', { path: 'README.md' }, 'running');
AthenaPiActivity.iconHTML('file-text', { active: true, motion: 'pulse' });
```

Subscriptions immediately receive an immutable snapshot. Each accepted event publishes once; an optional `onText(text, snapshot)` callback follows publication when text changes. Unknown events and non-assistant message events do not alter the model phase or answer. After terminal settlement, late stream events are ignored until a new `agent_start` or reset.

Snapshots expose `phase`, `label`, `icon`, `active`, `settled`, `sequence`, `runId`, `text`, `textRevision`, `messageId`, `messages`, `tools`, `activity`, `thinkingCharacters`, `queue`, and `error`. Text from separate assistant messages is joined with a blank line. Individual records retain their generated stable ID, index, final flag, and stop reason.

Tool records use `toolCallId` as identity (`id` is an alias) and include `toolName`, `args`, `status`, `output`, `outputRevision`, presentation fields, timestamps, optional parent ID, and reported duration. Names and paths are plain strings; callers must use `textContent` or HTML escaping when rendering them.

## Stream correctness

Content blocks are reconstructed by `contentIndex`. Final block/message data replaces reconstructed text, preventing duplicate final replies. Thinking payloads are not retained or rendered; the presentation records only their character count and phase. User and tool-result messages never become assistant answer text.

The current Pi documentation makes partial-output merge semantics tool-specific. This adapter replaces tool output by default. Configure `toolOutputModes[name] = 'append'` only for a tool that explicitly sends deltas. A final tool result always replaces the partial output. Direct RPC `bash_execution_update.delta` uses append semantics and a separate `rpc-bash:` identity.

The module bounds tool/event history and displayed output, stores no image/base64 results, and never evaluates tool arguments. It has no timers or network side effects. Reset and destroy discard presentation state/subscriptions; those methods do not cancel backend work.

## Motion

`.ap-icon[data-pi-active="true"]` animates only active states. Most icons breathe gently; retry uses a slow rotation. `.ap-phase[data-pi-active="true"] .ap-live-label` adds a restrained moving highlight. Completion/error/stop removes these active states. Both OS reduced motion and the workspace preference disable all these animations while keeping the icon and label visible. These indicators reflect events; they do not estimate a completion percentage.
