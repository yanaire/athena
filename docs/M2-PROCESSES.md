# M2: Offline CSV process

`calculate_csv` runs the bundled Athena measurement MCP server over stdio. The caller supplies a grant ID and, optionally, an exact header name. No executable, flags, environment, path, shell, or code can be supplied. The runner consumes a project/session-scoped grant created from a validated staged file version. The grant stores the exact bytes, file/version identifiers, byte length and SHA-256. The runner verifies the grant's scope and digest before copying bytes to a new attempt directory. The original file name is display metadata; it is never used as a path.

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
```

The cwd is a new private directory under `$ATHENA_DATA_DIR/csv-jobs/attempts/`, keyed by the digest of the scoped attempt ID. The environment is exactly `LANG=C`, `LC_ALL=C`, and `TZ=UTC`. The runner does not inherit credentials, `PATH`, or `NODE_OPTIONS`. stdin and stdout carry newline-delimited JSON-RPC. The host sends the optional column through the tool arguments. stderr is a separate diagnostic pipe. The server uses Node built-ins and makes no network or subprocess calls. Node's permission model restricts the fixed worker's file access and disallows spawning children. It is not an OS-level sandbox for arbitrary code or a network firewall. The deployment's Node binary, checked-in worker, private storage root, and host user account are trusted.

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

The CSV parser accepts comma-delimited data, an optional UTF-8 BOM, LF and CRLF, quoted fields with doubled quotes, and quoted line breaks. The first record must have unique, nonblank header names. Data records must have the same width. Malformed CSV and missing requested columns produce an MCP tool error. The transport can exit normally on these failures. The JSON includes `schemaVersion`, `rowCount`, `columns`, and `statistics`. Each selected column reports the finite decimal `count`, blank `missing` count, `nonNumeric` count, and `min`, `max` and `mean` (`null` if there are no finite numbers).

## Events, cancellation and recovery

`start()` emits `process_queued` synchronously, before dispatch, so the host can persist the full initial attempt. Its `status` is `queued`; its `args` are empty, and its cwd, PID and exit are unset because the child has not been prepared. If the callback throws, `start()` throws without dispatching the attempt. The runner emits `process_started` only after Node reports a real spawn, `process_output` for bounded UTF-8 chunks with a `stdout` or `stderr` stream tag, and `process_finished` on settlement. The started attempt includes the exact resolved program, argv, cwd and environment, effective limits, and live child PID. The finished attempt includes timestamps, the observed exit code or signal, and bounded output. Failures before spawn have no process PID or exit code. Publication requires a successful MCP response and process exit. The host checks the saved JSON against the SHA-256 returned by the server before issuing the artifact receipt.

Cancelling a queued/preparing attempt prevents spawn. For a live child, explicit cancellation or a timeout sends `SIGKILL` to the process group from the current in-memory child handle. Confirmation requires observing the child exit and then finding no process group; delivery of the signal alone does not confirm termination. If the runner cannot confirm, it reports `cancellation: "unknown"` and stops accepting or launching work. A cancelled or timed-out job publishes no artifact. `close()` cancels queued/live attempts and awaits their result. No persisted PID is ever signalled.

The host passes stored attempt records as `recoveredAttempts`. Nonterminal records become `interrupted` with termination unknown, while retaining the historical PID for inspection. Recovered IDs cannot be rerun. A pre-existing attempt directory also blocks reuse, even if the host lost the receipt before reopening. Verified artifacts are readable after restart through their existing records. The project/session authorization check belongs to the host before it calls `download(artifact)`. The runner matches that record with its private receipt and rechecks regular-file status, size and SHA-256 on download. A failed check returns no bytes.

The parent owns execution and workspace records; the runner only owns private input, output, and receipt files. This milestone applies bounds per job and to the live queue, not an aggregate workspace disk quota or retention policy.

## Measurement study in chat

Attach [measurements.csv](measurements.csv) to a conversation with a configured model profile and ask “계측 전압의 평균과 범위, 결측 건수를 조사해 줘.” The parent delegates to a child with an upload grant. The child uses `calculate_csv` for `measurement_mV`. The fixed CSV tool is available with the existing child tool permissions, including projects with scripted WASI execution disabled.

Open **Workflow** in the right panel to see the child task, MCP phase and terminal process status. **View measurement results** opens the corresponding version in **Artifacts**. The table reads the same authenticated artifact route as **Download result file**. Reopening the conversation restores task, process and artifact records. For the supplied CSV, four numeric rows total 76 mV, one row is blank, the mean is 19 mV and the range is 7–35 mV. Changing the first reading from 7 to 0 yields a mean of 17.25 mV.

The host negotiates MCP `2025-06-18` with `athena-measurements` `1.0.0`, sends `notifications/initialized`, discovers `calculate_csv` with `tools/list`, and calls it with the owning Athena tool ID as the JSON-RPC ID. Each server has a single attempt directory and one write-once result. Lifecycle, grant, cancellation and recovery limits are listed above. [MCP protocol source](https://github.com/modelcontextprotocol/modelcontextprotocol/tree/f5ccad944fdf2b7d9cc70cf817f66ca5a8aa03a4/docs/specification/2025-06-18)

The [data quality skill](../skills/athena-data-quality/SKILL.md) is copied from [catalog commit 987e61d](https://github.com/yanaire/athena-1/blob/987e61d8b922c609b0fda3794a06f835c9b36530/skills/athena-data-quality/SKILL.md). The fixed Pi prompts in `runtime/agent-tools.ts` apply the selected guidance to delegate a granted measurement file, distinguish missing and nonnumeric cells from zero, retain repeated measurements, and report only computed statistics. The full Markdown is a reference. The app ships the selected instructions directly in its runtime.

### Verification

A Chromium run on 2026-11-24 attached the repository CSV in the chat composer, submitted a measurement request, opened the child’s completed Workflow entry, and downloaded the JSON from the Artifacts table. After restarting the host, the run, process and artifact IDs matched and the same bytes downloaded again. Pi used a loopback model fixture. The browser, Athena host, MCP server, calculation, persistence and download path were real.

An independent [official TypeScript MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk) client (`@modelcontextprotocol/sdk` 1.26.0, MIT) also negotiated the protocol, listed the tool, called it, and matched its SHA-256 to the output file. The SDK was installed only in a temporary verification directory.
