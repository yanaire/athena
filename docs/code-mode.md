# Read-only code-mode

Ask Athena to compare the published results linked to a research mission in one prompt.

> Read the result files linked to this mission. Compare values by experimental condition, flag missing measurements and discrepancies, and cite the source versions.

The coordinator uses the existing research board and delegates to one worker with the mission ID and the exact published artifact IDs. The artifact transfer uses the existing project setting for offline analysis and artifact access. This first version works within the current run. Enable offline analysis before starting a run that transfers result files.

## Tool usage

Set `readTools: "discover"` when calling `spawn_agent` for the comparison worker. Give that worker only the results needed for the comparison. Its initial tool list includes the scoped read names and the discovery interface. `discover_read_tools` can search by query or return one exact input and output schema by ID.

| Tool ID | Host operation |
| --- | --- |
| `athena.research.get_research_board` | List missions in the worker's current run. Include published evidence only where the result is owned by or transferred to this worker. |
| `athena.artifacts.read_file` | Reopen one published UTF-8 result by exact artifact ID and verify its stored size and SHA-256. |

Discovery returns an ID, a contract version and a SHA-256 fingerprint of the definition. Use these three fields with `call_read_tool` for one ordinary read. For a comparison, pass the selected pins in `run_code.tools` and use `await tools.call({id, version, hash, args})` inside `run_code.source`. Each call must match a selected and currently authorized contract. A changed hash or version requires a fresh lookup. A default worker can still use its usual direct tools.

`source` is a JavaScript async function body. Use `return` for a compact JSON result. Top-level `await`, loops and branches work. Use small batches with `Promise.allSettled` to retain successful reads when one fails. File contents are data. The read tool returns verified text and a source reference. The final receipt derives its source list from completed host reads.

In Chat, open **Research comparison** to see completed, active and unfinished reads. The Workflow graph links the same receipt from the worker's task. A successful file read opens the exact result in Artifacts. **Technical details** contains the submitted JavaScript, IDs and hashes. Each comparison stays inside its existing worker task. It creates a receipt and a summary. The app receives batched workspace refreshes during an active run, while each admitted read and terminal state is recorded in the journal.

## Isolation and limits

The existing `run_command` helper executes offline files with Wasmtime and QuickJS-ng. Its stdin is reserved for parent liveness. Code-mode uses the QuickJS/Wasm engine already bundled through the locked Pi SDK. `@earendil-works/pi-codemode` 1.6.0 is now a direct dependency on the same installed version. It and `quickjs-wasi` 3.6.2 declare MIT. The existing 637,405-byte core WASM asset is reused, with no new native sandbox binary, WASM package, or platform image. The current notice inventory covers the asset. [Third-party notices](../THIRD_PARTY_NOTICES.md)

Each run creates a fresh QuickJS runtime inside a Node Worker. The guest receives no environment, preopened files, direct network, Node modules or package installation. The Worker executes Athena's fixed bridge code. The guest exchanges JSON with one injected function and discards transient sandbox console, image and store output at the end of the run. TypeScript and persistent guest state are outside this version.

The host rechecks the live Pi attempt, role, conversation, run, project and file grant at dispatch and before returning file bytes. Unexpected identifiers in the input are rejected by the contract. The built-in allowlist is independent of external MCP registrations and read-only annotations. Approved external MCP schemas still enter the existing prompt. This feature defers its own scoped research-read contracts.

| Limit | Value |
| --- | --- |
| UTF-8 source | 16 KiB |
| QuickJS heap | 12 MiB |
| Node Worker V8 old generation / young generation / stack | 64 MiB / 16 MiB / 2 MiB |
| QuickJS interrupt polls per run | 8,000 across active guest execution |
| Total elapsed time / each issued host read | 6 s / 2 s |
| Simultaneous workers / active reads per worker / waiting reads per worker | 2 / 4 / 8 |
| Read requests per run | 24 |
| Read envelope / one result / aggregate guest read results / final JSON | 8 KiB / 128 KiB / 512 KiB / 32 KiB |

The QuickJS polling budget applies while the guest executes. Host deadlines also cover waiting. The measured Worker CPU time includes engine startup. Set `ATHENA_CODE_READ_CONCURRENCY` to an integer from 1 to 4 to reduce read concurrency. The existing Pi session tool queue and JobRunner keep their own limits. Nested reads use the scoped research and artifact readers directly, so the active code tool never waits for itself or for a JobRunner slot.

## Cancellation and errors

Syntax rejection has zero reads. A valid program may fail after issuing reads. The saved receipt retains each admitted request and its start and end times, contract, argument digest, terminal state, and any verified result digest and source. Model-computed JSON is labelled as a summary. Catching a tool error does not stop it counting toward the Pi attempt's shared failure budget. A repeated or total failure limit ends the attempt.

Stop closes the bridge, discards queued requests and stops accepting replies. Reads already verified and returned remain recorded. An issued read may finish in the host after Stop or its deadline; its late response is discarded. Capacity stays held while that read settles. The same rules apply to outstanding reads when the script returns or throws. A stopped host marks in-flight receipts interrupted when it opens the same workspace, preserving completed reads and identifying requests that never started. A new explicit attempt gets a new execution ID.

The read tools can compare published results for the current run. Earlier-run transfers, full external MCP catalogs, manuscript creation, Crossref, and CAD are separate capabilities. Code-mode adds no write tool or permission for them. [Validation](validation/code-mode-readonly.md)
