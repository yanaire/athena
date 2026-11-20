# Reply-generation Agent steps

Adapted from Kokonut UI AI State Loading 2.0.0, MIT © 2025 kokonutUI.
The requested location was explicitly selected as the **reply-generation indicator**.
Existing tool activity stays inline and is not replaced by this component.

Primary references:

- https://designbookmark.com/motion#ai-loading
- https://kokonutui.com/docs/ai/ai-loading
- https://github.com/kokonut-labs/kokonutui/blob/655ec61161aff87721e4c60c3cc4dc3329f3e80e/components/kokonutui/ai-loading.tsx

The original source is preserved as `motion/kokonut-agent-steps.reference.tsx`.
Its Git blob SHA is `a5fb5c74c7ab66e4d1d8885c0c382544a6fe2850`; the source retrieved separately exactly matched the registry file contents. The full MIT notice is in `motion/LICENSE-KOKONUT.txt` and the adapted implementation.

## Why this implementation

Athena's application uses plain HTML, CSS and JavaScript. It does not use React or Tailwind, so no shadcn installation or production framework dependency was added. `motion/agent-steps.js/css` provide the same timed motions through DOM and CSS. Athena's existing Lucide icons and a CSS ring replace the source icon geometry while preserving transition and draw timing.

Normal-mode constants are documented in `MOTION.md`: 180 ms icon crossfade/blur, 800 ms ring rotation, 300 ms completion drawing after 50 ms, 1600 ms letter wave with 50 ms character delays, 240/300/200 ms log transitions, 500 ms rail fill, 250 ms list expansion/collapse, and 200 ms chevron. Explicit easing is cubic-bezier(0.23,1,0.32,1).

## Component API

```js
const steps = AthenaAgentSteps.mount(host, { collapseWhenDone: true });
steps.update([
  { id: 'waiting', label: 'Waiting', status: 'done' },
  { id: 'thinking', label: 'Thinking', status: 'running', detail: [] }
], { active: true, title: 'Thinking' });
steps.setOpen(false);
steps.getState();
steps.reset();
steps.destroy();
```

Supported step states are pending, running, done, error, and the explicit Athena stopped state. Input labels/details are text, never HTML. Keys preserve row identity and focus. The component does not execute tools, infer completion, fetch data, or schedule a fake run.

The reply integration records only observed Waiting, Thinking and Replying milestones, at most three rows. A later visit reuses the same row. Tool preparation/execution, compaction, retry and approval update the current status without duplicating tool rows. On real success the list folds immediately, preserving a keyboard-accessible, reopenable summary. Error and stop never produce a success summary. Reduced motion removes movement while retaining accurate live state and received text.

## Seeing it

Open `athena-preview.html`, enable **Settings → About & diagnostics → Development examples**, expand **Demo options**, then click **Preview response**. This explicitly authored finite sequence shows the motions without performing work. A connected Pi session drives the same component with real events. Merely opening the page does not start a demonstration or a request.

## Verification

The integration suite executes this component and the real reply shell in Node + LinkeDOM with documented environment shims. It covers stable rows, bounded milestones, completion disclosure, cancellation/error distinction, reduced motion, live-stream settlement, and cleanup. CSS constants and source attribution are also inspectable. Actual browser rendering and visual timing were not verified in the restricted workspace.
