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
