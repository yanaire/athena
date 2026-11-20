# Athena Task List — source and integration notes

## Source

- Official documentation: https://smoothui.dev/docs/components/ai-task-list
- Official registry source: https://smoothui.dev/r/ai-task-list.json
- Local source snapshot: `smoothui-ai-task-list.registry.json`
- SmoothUI license: `LICENSE-SMOOTHUI.txt` — MIT, copyright 2024 Eduardo Calvo.
- Motion spring generator source package: `motion@14.14.0`, published package retrieved from the npm registry. The SmoothUI registry names `motion` as an unpinned dependency.
- Motion license: `LICENSE-MOTION.txt` — MIT, copyright 2024 Motion B.V.

The browser preview uses the standalone `task-list.css` and `task-list.js` files. It does not need React, Motion, an external CDN, or a network connection. The Motion package was used only to calculate the spring progress samples during authoring.

## Motion values preserved from the registry source

| Element | Original value | Plain HTML implementation |
|---|---|---|
| Row spring | `type: spring`, duration `0.25 s`, bounce `0.1` | Web Animations keyframes sampled every 5 ms from Motion's generator with those same parameters; total 250 ms |
| Completed row | opacity `0.65`, y `1 px` | Same values; y stays 0 in reduced-motion mode |
| Box color/fill transition | `0.2 s` | 200 ms CSS transition |
| Check and failed cross | 200 ms, `cubic-bezier(0.23, 1, 0.32, 1)` | Same SVG path-length drawing and easing |
| Check path | `M 3.5 7.5 L 6 10 L 10.5 4.5` | Same path in a 14 × 14 SVG |
| Box | x/y 1, size 12, radius 3.5, stroke 1.4 | Same geometry |
| Running underline | 1.4 s, `cubic-bezier(0.645, 0.045, 0.355, 1)`, repeated | Same duration and easing |
| Underline movement | background-position-x 0% → 200%; background-size 50% 100%; opacity 0.5 | Same values; only running rows get an underline |
| Reduced motion | Fully drawn marks; no underline; no row shift; instant changes | CSS media query plus live matchMedia listener; running animations are canceled when preference changes |

Spring sampling is a native Web Animations adaptation; it does not claim to be a React runtime execution. The original source specified the box transition duration but no custom easing; the adaptation uses the keyframe generator's default ease-in-out for that small property transition.

## Athena-specific adaptations

- Warm colors come from the supplied `DESIGN.md`; the success mark is a muted warm gray and failure retains a restrained red accent.
- Labels are Korean and each row adds a short engineering context line.
- `needs-confirmation` is an added static state. It does not imply failure or cause a new calculation to be submitted.
- Counts are derived from the five task records. No separate count argument can drift from the displayed state.
- Completed metadata uses the foreground color before row opacity is applied, so small text remains readable on the white surface.
- Rows are real buttons inside a semantic list. Status labels are visible, and updates have a polite live announcement.

## API

```js
const taskList = window.AthenaTaskList.mount(
  document.getElementById('ac-task-list'),
  {
    onSelect(id, task) {
      // id is a string; task is a read-only snapshot.
    },
    onReconcile(id, task) {
      // Only the owning prototype changes state.
      taskList.setTaskState(id, 'running');
    }
  }
);

taskList.setTaskState('sensitivity', 'needs-confirmation');
taskList.destroy();
```

Task IDs are `plan`, `baseline`, `verify`, `sensitivity`, and `report`.
Allowed states are `pending`, `running`, `done`, `failed`, and `needs-confirmation`.

Initial states: plan/baseline/verify are done, sensitivity needs confirmation, report is pending. `setTaskState` returns whether the state changed and rejects unknown IDs or states. Reapplying the same state does not replay a completed check.

If an `onReconcile` callback is supplied, the component provides a small **상태 다시 확인** button while a task needs confirmation. The callback does not automatically change task state, and may optionally return a Promise to disable repeat clicks while the callback is pending. If the containing workflow has its own reconciliation button, it can call the returned controller directly instead and omit `onReconcile` here.

Hiding the containing research panel preserves task state. `destroy()` cancels owned row animations, removes event/media-query listeners, and restores the container's previous children. It can be called twice safely. Mounting on an already mounted container destroys the earlier instance first.

## Validation boundary

JavaScript syntax and deterministic DOM behavior can be checked without opening a browser. Browser animation rendering and Figma execution remain unverified in this workspace because the earlier policy restrictions were preserved. No simulator, external service, or real research job is invoked by this module.
