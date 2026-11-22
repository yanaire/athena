# M2: Offline CSV process

`calculate_csv` runs a single checked-in Node worker. The caller supplies a grant ID and, optionally, an exact header name. No executable, flags, environment, path, shell, or code can be supplied. The runner consumes a project/session-scoped grant created from a validated staged file version. The grant stores the exact bytes, file/version identifiers, byte length and SHA-256. The runner verifies the grant's scope and digest before copying bytes to a new attempt directory. The original file name is display metadata; it is never used as a path.

## Child command and limits

Supported hosts run Node 24 or newer on macOS or Linux. The child program is the host's absolute `process.execPath` and its arguments, in order, are:

```text
--permission
--allow-fs-read=<absolute path to runtime/csv-worker.mjs>
--allow-fs-read=<attempt cwd>/input.csv
--allow-fs-write=<attempt cwd>/statistics.json
--max-old-space-size=64
--disallow-code-generation-from-strings
--no-addons
--
<absolute path to runtime/csv-worker.mjs>
[optional exact column name, one argument]
```

The cwd is a new private directory under `$ATHENA_DATA_DIR/csv-jobs/attempts/`, keyed by the digest of the scoped attempt ID. The environment is exactly `LANG=C`, `LC_ALL=C`, and `TZ=UTC`. The runner does not inherit credentials, `PATH`, or `NODE_OPTIONS`. stdin is ignored; stdout and stderr are separate pipes. The worker imports only Node filesystem operations and makes no network or subprocess calls. Node's permission model restricts the fixed worker's file access and disallows spawning children. It is not an OS-level sandbox for arbitrary code or a network firewall. The deployment's Node binary, checked-in worker, private storage root, and host user account are trusted.

| Limit | Value |
| --- | --- |
| Active process slots | One by default; configurable from one to four |
| Waiting queue | 32 attempts |
| Child wall time | Five seconds by default; configurable from 1 ms to 30 s after spawn is requested |
| Kill or pipe drain observation | Up to one additional second |
| V8 old-space | 64 MiB; this is not a total process RSS cap |
| Input | 1 MiB UTF-8, 100,000 data records, 128 columns, 256 bytes per header |
| Process output | 16 KiB each for stdout and stderr; excess fails the attempt |
| Downloadable output | 64 KiB, one `statistics.json` per successful attempt |

The CSV parser accepts comma-delimited data, an optional UTF-8 BOM, LF and CRLF, quoted fields with doubled quotes, and quoted line breaks. The first record must have unique, nonblank header names. Data records must have the same width. Invalid input and missing requested columns produce exit code 2. The JSON includes `schemaVersion`, `rowCount`, `columns`, and `statistics`. Each selected column reports the finite decimal `count`, blank `missing` count, `nonNumeric` count, and `min`, `max` and `mean` (`null` if there are no finite numbers).

## Events, cancellation and recovery

`start()` emits `process_queued` synchronously, before dispatch, so the host can persist the full initial attempt. Its `status` is `queued`; its `args` are empty, and its cwd, PID and exit are unset because the child has not been prepared. If the callback throws, `start()` throws without dispatching the attempt. The runner emits `process_started` only after Node reports a real spawn, `process_output` for bounded UTF-8 chunks with a `stdout` or `stderr` stream tag, and `process_finished` on settlement. The started attempt includes the exact resolved program, argv, cwd and environment, effective limits, and live child PID. The finished attempt includes timestamps, the observed exit code or signal, and bounded output. Failures before spawn have no process PID or exit code. A successful exit alone does not publish an artifact: the runner must also read and verify valid bounded statistics JSON and record its digest.

Cancelling a queued/preparing attempt prevents spawn. For a live child, explicit cancellation or a timeout sends `SIGKILL` to the process group from the current in-memory child handle. Confirmation requires observing the child exit and then finding no process group; delivery of the signal alone does not confirm termination. If the runner cannot confirm, it reports `cancellation: "unknown"` and stops accepting or launching work. A cancelled or timed-out job publishes no artifact. `close()` cancels queued/live attempts and awaits their result. No persisted PID is ever signalled.

The host passes stored attempt records as `recoveredAttempts`. Nonterminal records become `interrupted` with termination unknown, while retaining the historical PID for inspection. Recovered IDs cannot be rerun. A pre-existing attempt directory also blocks reuse, even if the host lost the receipt before reopening. Verified artifacts are readable after restart through their existing records. The project/session authorization check belongs to the host before it calls `download(artifact)`. The runner matches that record with its private receipt and rechecks regular-file status, size and SHA-256 on download. A failed check returns no bytes.

The parent owns execution and workspace records; the runner only owns private input, output, and receipt files. This milestone applies bounds per job and to the live queue, not an aggregate workspace disk quota or retention policy.
