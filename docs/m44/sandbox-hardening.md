# M4.4 sandbox resource controls

This change retains the existing TaskManager -> CsvJobRunner -> native Wasmtime
helper -> CPython WASI / QuickJS-ng execution path. It adds no host interpreter,
shell, Docker, VM, or alternate agent executor.

## Resource enforcement

| Boundary | Enforcement |
| --- | --- |
| Guest linear memory | Wasmtime StoreLimits: 192 MiB, one memory/instance/table, 20,000 table elements, 1 MiB Wasm stack. |
| Native helper memory | Independent thread starts before engine creation; every 10 ms checks a 768 MiB threshold. macOS uses libproc 0.15.0 and max(physical footprint, resident size); Linux uses RSS from `/proc/self/status`. Accounting failure stops execution. |
| Time and liveness | Guest epoch deadline; independent native startup + execution deadline; parent stdin EOF terminates the helper; Node kills and observes its own child on cancellation. |
| Host descriptors and files | Existing native limits: 96 descriptors, 1 MiB/file, no core dump, bounded CPU time. Guest output paths remain exact declared basenames. |
| Transfer and admission | 1 MiB/file, 2 MiB script + input snapshots, at most eight inputs/outputs each, 16 arguments of 256 bytes, 16 KiB captured per stream. Existing runner admits up to four concurrent jobs and 32 queued jobs. |

Exit 126 belongs to the native memory watchdog; guests requesting that exit
status receive ordinary failure code 1. The watchdog exits without writing to
potentially blocked guest pipes. Node reports a memory-limit/accounting error
and does not publish artifacts.

The sampled threshold bounds sustained helper growth, including native
compilation and WASI host calls; it is not a kernel allocation quota. A sample
can be delayed, transient growth can exceed the threshold, and Linux RSS omits
swapped memory. The Node process, model SDK, and aggregate job memory remain
outside this watchdog. Four simultaneous helpers can each approach 768 MiB.
Linux execution is not established by macOS tests.

## Cleanup and publication

The existing runner removes input snapshots after the child settles and removes
output scratch before publication. Cancellation and timeout keep child exit
confirmation separate from an unconfirmed cleanup failure, which halts further
admission. The regression suite checks that successful, cancelled, timed out,
stream-overflow and file-overflow attempts leave no workspace/output scratch.

Publication validates the complete batch before writing. Immutable versions now
use the existing flushed-temp-file/rename primitive. One `.published` index
rename exposes the entire batch. If any write or index commit throws, all newly
installed versions are removed, including the archived source; older versions
remain downloadable. Synthetic write/index faults test this boundary without
using private files or real credentials. Rollback errors retain the original
error in an AggregateError.

Abrupt process death or machine failure can still leave snapshots, temporary
files, or unreferenced immutable versions. This change does not introduce a
recovery sweeper: another running host may own a job directory, so age or a
persisted PID alone is insufficient authority to delete it. Namespace atomicity
does not make the filesystem commit and SQLite receipt one transaction, nor
does it guarantee directory-entry durability after power loss.

## Other host tool boundaries

`runtime/pi.ts` supplies only Athena's explicit custom tool names to Pi.
`runtime/agent-tools.ts` does not expose a general shell or arbitrary host write.
These host tools do not execute inside WASI:

- The standalone/project `read` tool uses `runtime/files.ts`: regular UTF-8
  files inside the project, no symlink components, bounded at 256 KiB.
- Manager-mediated attachment reads, `read_file`, and `write_file` use authorized
  grants/artifact receipts and the existing scoped AnalysisFiles store. Private
  files are bounded at 1 MiB and 32 names per task; published versions are
  immutable and historical versions do not have a total retention quota.
- `calculate_csv` uses the existing fixed Node worker with Node filesystem
  permissions, a 64 MiB V8 old-space setting, bounded input/output/time, and
  process lifecycle controls. V8 old-space is not a full Node RSS limit; the
  Wasmtime memory watchdog does not apply to this worker.
- Delegation and model-provider network traffic execute in the trusted Node
  host. WASI's lack of networking does not imply that Athena is offline or that
  host SDK/network allocations have the helper's memory limit.

Same-account local software remains outside the isolation guarantee. The
watchdog adds no credential reads and inherits no host environment.
