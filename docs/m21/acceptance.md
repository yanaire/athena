# M2.1 browser acceptance

**2 of 2 real browser cases passed.** Chrome submitted each CSV to the local Qwen3-4B-Instruct model. In both runs the parent issued two `spawn_agent` calls and joined two independent Pi sessions. The auditor read the granted attachment. The programmer wrote `analysis.py` and called `/usr/bin/python3 -I -B /workspace/analysis.py` with the original CSV mounted. The successful process published the exact source, `clean.csv`, and `result.json`. The parent read the published JSON and cited the three canonical artifact URIs. The user prompts included the requested calculations, but no program or numerical answers.

| Input | Run | Independently verified result |
|---|---|---|
| `optics.csv` | `5c97da9b-c57a-4785-894a-db2f6da66041` | Omitted P3; sorted P2:75, P4:82, P6:88, P1:96, P5:99. Median 88%; two batches at or above 90%. The parent read the source and JSON. The verifier independently checked the downloaded CSV's row order. |
| `settling.csv` | `b3373730-b07f-4405-a8c9-f91c844b8f52` | Omitted T2; sorted T3:6, T4:12, T1:18, T5:24. Median 15 ms; population SD 6.708203932499369 ms. The first process exited 1 with a missing `json` import. The model corrected its source and ran it again, exiting 0. The parent read all three files. |

Both Chrome download verifications exited 0. After restarting the host on the same data directory (PID `23874` → `53448`, commit `95bb1ef`), Chrome reopened both conversations and downloaded all six files again. Every file matched its pre-restart bytes and SHA-256. Independent before/after inspection of the same two run IDs also produced byte-identical records, including Pi messages, process histories, and artifact contents. In `~/.athena/evidence/m21-4b-gd0czZ/`, see `pre-restart.json`, `{optics,settling}-readback-verifier.log`, `post-restart/comparison.json`, and `post-restart/{optics,settling}-history.png`. See [setup](setup.md) to run the product and [verification](verification.md) for the separate controlled-provider, Docker and UI tests.

**Earlier attempts.** The integrated host reported the pinned image `sha256:cf0f1b9ce95e84000ca4f395d4619ae3318ce4c29038ce0a751c4ee9ab307c4d` available with Python 3.11.2 and Node v24.22.3. During the initial 1.7B tests, **New research** could not target an empty project when another project was active. The project picker fix was verified before the separate 4B runs.

**Optics attempt 1 (cancelled).** Run `1094faa0-3a16-4184-a851-8161130ca0b6`. The coordinator called `spawn_agent` twice, forwarding the correct upload ID to both workers, and called `wait_for_agents`. The programmer wrote `clean.csv` with `write_file`, then passed inline Python as `run_command.script` instead of the script filename. Validation rejected it before launching any process. The worker subsequently repeated `calculate_csv` with `clean.csv` as a file ID. The operator cancelled the run after more than 100 calls. No process, published output, download, joined numerical answer or acceptance credit. Private `optics-submit.png`, `optics-start.json`, and `optics-failed-inspection.json` retain the input screen and receipts. The failed first inspector diagnostic is also retained.

**Optics attempt 2 (cancelled).** After the host PID changed from `34275` to `52149`, Chrome opened a fresh conversation. Run `98f411a6-bc7a-4d95-a280-5669df57f450` wrote a script and executed `/usr/bin/python3 -I -B /workspace/analysis.py`. Qwen omitted `inputs` and included `optics.csv` among its declared outputs. Python exited 1 (`FileNotFoundError`); the worker then repeated failing calculator calls. Private `optics-2-failed-inspection.json` includes the model source and interpreter stderr.

**Optics attempt 3 (runtime succeeded; acceptance failed).** Chrome submitted run `6be62af4-cc5f-43c1-8ac6-1fb6cb734c8a` in the same conversation as attempt 2. The user prompt supplied column names, desired outputs and the tool argument shape, but no source or answers. Three programmer calls still omitted the input; Python could not open `/workspace/optics.csv`. The only published file was a legacy `statistics.json`. The parent got the median and missing batch right, reported **1** qualifying batch instead of **2**, and claimed a cleaned CSV that had not been published. See `optics-3-failed-inspection.json`.

The preparation browser was a new Chrome profile with a new Athena workspace. Both projects were created with **Add project**. In **Connections**, **Check connection** passed for `http://127.0.0.1:62279/v1` / `m1-qwen3-1.7b`, and **Save settings** returned configuration ID `e234bf51-0df3-431e-96b1-697245634ef1`.

| Case | UI project ID | Independent oracle |
|---|---|---|
| Settling | `5dee97fc-bb6b-4a57-a6b6-ff067122c041` | Exclude blank `T2`; sorted `T3:6, T4:12, T1:18, T5:24`. Median `(12+18)/2 = 15 ms`; population SD `sqrt((81+9+9+81)/4) = 6.708203932499369 ms`. |
| Optics | `c2d4299b-1f60-442f-bb5f-5b9e73c3da70` | Exclude blank `P3`; sorted `P2:75, P4:82, P6:88, P1:96, P5:99`. Median `88%`; `P1` and `P5` meet `>=90%` (count `2`). |

Private evidence: `~/.athena/evidence/m21-real-kgDTFi/`. `preparation.json`, `projects.png`, and `connection-saved.png` record setup only. The exact opt-in string is `5dee97fc-bb6b-4a57-a6b6-ff067122c041,c2d4299b-1f60-442f-bb5f-5b9e73c3da70`. Do not reuse those IDs in another workspace. No screenshots, logs, or databases are checked in.

The separate 4B workspace is `~/.athena/evidence/m21-4b-gd0czZ/`. Its host is `http://127.0.0.1:44219`; its model configuration targets `athena-qwen3-4b-instruct` at `http://127.0.0.1:62281/v1`. Both projects were created in Chrome before opt-in. The rebuilt **New research → Project** picker created settling conversation `01a1f747-a3a0-742d-ba67-94aa21120355` and optics conversation `01a1f747-d7ba-742d-ba67-94ad8f6b9851` in their intended projects. `project-picker.png`, `conversations-before-submission.json`, and `projects-before-opt-in.json` document this setup. The exact 4B allowlist is `fa2cdf31-a984-4a27-afa8-7ddb68b23662,8fa1d0d5-947f-4bae-b6ad-f25b58acba83` (settling, optics). `opt-in-host.json` records the pinned runtime and host PID `73779`. This is pre-execution evidence only.

The 4B attempts below are independent runs. In particular, do not use the parent reads from one attempt to fill a gap in another.

| Run | What the records establish |
|---|---|
| Optics `1aab4264-2ac1-43d2-bb9d-d530e9143a49` | Host closed before any interpreter process; paused, zero published files. |
| Settling `4b2df45e-4a59-41db-b14d-e746e8358d74` | Before the required-inputs schema: two interpreter failures followed by a successful process. Preserved separately; not replayed. |
| Optics `1b06bb08-f614-4925-bf53-0e95dfd5260f` | The worker wrote private files but never ran a program. No published files. |
| Settling `dd717927-a61f-42cd-8c4a-860a89e7d2ec` | Correct cleaned rows, median and population SD. Three browser downloads matched their receipts. Parent omitted the canonical result read and mislabeled the script. |
| Optics `c9fc4bdb-4efa-4932-82c1-20fc104a551d` | Correct JSON, unsorted cleaned CSV, no parent result read. Source and both outputs downloaded and hashed. |
| Optics `4ceb0a9a-08d2-4f95-804a-526c05c60a46` | Parent read both canonical outputs. The program sorted measurements separately but wrote the original record order; the parent missed this defect. |
| Optics `5c97da9b-c57a-4785-894a-db2f6da66041` | Correct cleaned rows, median 88%, count 2 and missing batch P3. Chrome downloads passed the offline verifier: source hash `d74d075f15ff39ca2ad057dc2d467189e84c2e979708ff27bb57a965f3d4a646`, clean CSV `7b3e763dfbc753f6db45f661edb341dd2729336ec1fb9a0e805307fd0396ab15`, JSON `ac7c3f385e01b02c0d5ab2e9d895f61462b83ba9d6aad12119b74b9b08e237b0`. The script reopened its CSV without asserting order. Parent read the script and JSON rather than the cleaned CSV and JSON. The verifier does not check these two extra requirements. |

`node scripts/inspect-m21.mjs DATA_DIR RUN_ID` reads one explicitly named run from SQLite in read-only mode, joins the recorded messages to the Pi JSONL files, and hashes the immutable artifact versions. It never opens a conversation or invokes any SDK command. Output contains raw messages, tool arguments and results; redirect it to a private evidence directory. For example, the following works offline and does not rerun the model:

```sh
umask 077
e="$HOME/.athena/evidence/m21-4b-gd0czZ"
node scripts/inspect-m21.mjs "$e/data" 5c97da9b-c57a-4785-894a-db2f6da66041 > "$e/optics-independent-inspection.json"
node scripts/m21-browser-verify.mjs "$e/optics-independent-inspection.json" "$e/downloads"
```
