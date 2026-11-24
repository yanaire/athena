# Built-in engineering MCP contract v1

The board consumes existing host snapshots and artifact downloads. The public identities are defined in `runtime/mcp-contract.mjs`.

| Field | Source and meaning |
| --- | --- |
| Task and attempt | `process.taskId`, `runId`, `attemptId` and `toolId` link the owning records. `process.id` is the process attempt ID. |
| State | `process.status` is queued, running, succeeded, failed, cancelled, timed_out or interrupted. `job.error` supplies a diagnostic when present. |
| MCP metadata | `process.job.mcp` carries `registryVersion` (1), `server`, `displayName`, server `version`, `protocol`, server `tool`, Pi `alias`, `resultKind` and last `phase` (initialize, tools/list or tools/call). Phase is not completion. |
| Published output | On success join `job.artifact.id` to `snapshot.artifacts[].id` and match `artifact.processId` to `process.id`. Read `artifact.location.uri` for the verified JSON. File metadata includes name, MIME type, byte count and SHA-256. Input versions are in `artifact.evidence`. |

Both servers use version 1.0.0 and MCP 2025-06-18. Model alias and MCP tool name currently match. For older measurement records use the existing server/tool pair when v1 metadata is absent. Pre-MCP CSV receipts can still be downloaded using the existing scoped artifact ID. WASI process records have a separate analysis field.

| Server | Alias | Result kind | Published file |
| --- | --- | --- | --- |
| athena-measurements | calculate_csv | csv-statistics | statistics.json |
| athena-circuits | calculate_rc_response | rc-step-response | rc-response.json |

CSV keeps its v1 `columns`, `rowCount` and `statistics` array. RC uses seconds, hertz and volts. This example is rounded for display.

```json
{"schemaVersion":1,"timeConstantSeconds":0.001,"cutoffHz":159.154943091895,"samples":[{"timeSeconds":0,"outputVolt":0},{"timeSeconds":0.001,"outputVolt":0.632120558829},{"timeSeconds":0.005,"outputVolt":0.993262053001}]}
```

## Attaching a circuit

Attach a UTF-8 file named `circuit.json` to a chat and ask the parent to delegate an ideal RC step-response calculation. This example describes a 10 kΩ resistor and a 100 nF capacitor.

```json
{"schemaVersion":1,"resistanceOhm":10000,"capacitanceFarad":0.0000001,"inputVolt":1,"sampleTimesSeconds":[0,0.001,0.005]}
```

The worker models zero initial capacitor voltage and a step at time zero. It accepts positive finite R and C, a finite step voltage and 1–512 finite, nonnegative times in seconds. File order and repeated times are preserved. The calculation uses τ = RC, f = 1/(2πτ), and V(t) = Vin × (1 − exp(−t/τ)). Invalid or unrepresentable calculations fail the call. The input and result are each bounded to 64 KiB.

## Registering a bundled worker

1. Declare its v1 identity, flat worker and file names, byte limits, closed MCP argument schema and argument validator in `runtime/mcp-contract.mjs`. A worker imports its binding and calls `serve` from `mcp-worker.mjs` with its calculation. Both in-tree workers are Athena code under the repository license.
2. Add a child `Registration` in `runtime/mcp-registry.ts` and include it in `registerBuiltins`. Specify the Pi schema, upload filename predicate, JSON result validator, model result field and error code. The registry rejects duplicate server IDs, reserved or duplicate aliases and invalid file bindings. Host-owned workers share the existing queue, timeout, heap, stdio and process-group termination limits.
3. Pi exposes the alias only to the child. Both tools accept an optional exact granted `fileId`; omitting it selects the only granted upload. The manager resolves project, session and immutable version, and strips the file ID before MCP. Only CSV accepts `column`. The host stages a private snapshot, verifies its digest and starts the bundled worker with fixed arguments, environment and filesystem permissions.
4. Exercise the worker from the installed bundle in `scripts/check-desktop-bundle.mjs`. The common client pins server identity, protocol and the listed tool schema. Publication requires a successful matching call and process exit, bounded readable bytes matching the response SHA-256, and a valid registered result. Failed, timed-out, cancelled or interrupted processes publish no artifact.

The child tool result contains `artifactId`, `artifact`, `processId`, `sha256` and either `statistics` (CSV) or `response` (RC). The board downloads the saved artifact at its existing URI. New grant and artifact receipts include `mcpAlias`. Historical CSV records retain their storage directory, fixed filenames, ownership checks and download URI. Missing aliases resolve to the historical CSV registration. No database migration or credential change is required.
