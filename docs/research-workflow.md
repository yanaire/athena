# Athena research workflow and evidence ledger

This implementation uses Athena's existing TaskManager, Pi sessions, file grants,
process receipts and SQLite storage. It is an Athena implementation inspired by
the reusable research direction described in Tencent's
[Hyra 2.0 announcement](https://hy.tencent.ai/research/hyra2), linked from the
[official Hyra-results repository](https://github.com/Tencent-Hunyuan/Hyra-results).
It does not import a Hyra agent framework or claim to reproduce Tencent's internal
research infrastructure.

## Implemented flow

1. The coordinator records the question, acceptance criteria and planned stages
   with `plan_research`.
2. Existing direct child tasks perform the requested work with their actual tools
   and granted inputs. They keep the existing model, account, cancellation and
   retry behavior.
3. `add_research_evidence` records only actual input or result IDs. The host resolves
   and reads each target, checks access and hashes its bytes. Version, digest,
   size and artifact producer task/attempt/process identifiers come from the host.
4. The coordinator uses `request_review` with recorded evidence. The package is
   frozen and rechecked. A new direct child Pi session receives the original
   evidence and public review question. The author's conversation and hidden
   reasoning are not copied to this reviewer.
5. The registered reviewer calls `submit_review` with performed checks, findings
   and a verdict. The host rechecks the frozen evidence before accepting that
   structured receipt. A free-form assistant conclusion is not a review receipt.
6. The coordinator may record a reusable method using `propose_knowledge`. Its
   confidence level is computed from actual receipts. A tool's successful exit
   or an enthusiastic summary cannot set the level to verified.

There is one existing TaskManager scheduler. Mission records describe research
goals; they are not a new third agent role. Parent/child depth remains one.
No timer, autonomous wakeup, remote compute purchase or permission grant is
introduced by this ledger.

## Public tool contract

| Tool | Inputs | Persisted outcome |
|---|---|---|
| `plan_research` | `objective`, `acceptanceCriteria[]`, optional `stages[]` | Scoped mission with host-created ID |
| `add_research_evidence` | `missionId`, `title`, optional `summary`, `fileIds[]`, `artifactIds[]` | Immutable verified target references; at least one target required |
| `request_review` | `missionId`, `evidenceIds[]`, `question` | Frozen package and a separately bound reviewer child |
| `submit_review` | `reviewId`, `verdict`, `checks[]`, `findings[]`, optional `reproductionEvidenceIds[]` | Immutable receipt owned by the actual reviewer attempt |
| `remember_research` | `scope: project\|agent`, `text` | An explicit operational note in the selected memory scope |
| `propose_knowledge` | `missionId`, `title`, `method`, `rationale`, `applicability[]`, `evidenceIds[]`, optional `reviewIds[]` | Books entry with computed level and history |
| `get_research_board` | No arguments | Current mission, evidence and reviews; project Books and explicit project notes; calling agent's own notes |

Mutation request IDs identify the same logical operation. Reusing an ID with
different arguments fails. Source IDs and versions are technical references;
ordinary UI uses recorded titles and statuses.

Every mission operation must match an actual stored project, conversation, run
and attempt. Normal writes require a running, non-reconciliation attempt. Child
agents may record evidence or explicit notes, but only the coordinator may plan,
request reviews or propose shared methods. No tool grants are added by these
records or by loading a skill.

## Evidence and review invariants

`ResearchLedger` is in `runtime/research.ts`. It uses a versioned project metadata
record in Athena's existing `Storage`. Writes are synchronous SQLite updates;
asynchronous file checks reread the latest ledger before writing so concurrent
workers do not overwrite each other's records. Arrays are bounded, and returned
objects are copies.

The trusted resolver supplies the target kind, ID, project, conversation,
version, SHA-256 and byte count. For results it also supplies the actual producer
task, agent session, attempt and process, plus the process's input versions.
Models can request IDs but cannot supply a trusted digest, producer or success
state. The resolver must authenticate access and verify actual bytes; the ledger
does not grant access on its own.

Review preparation requires a real published artifact and rejects conflicting
versions of a target. Preparation and submission both re-resolve the full frozen
package. A changed hash, version, producer or input provenance invalidates the
submission; a new review of the new evidence is required.

The host calls `registerReviewer` after persisting the real child attempt and
before scheduling it. The reviewer must be a separate direct child session, not
the evidence author or the producing artifact's task/session. Only that exact
reviewer attempt may submit. The allowed verdicts are:

- `supported`: the recorded checks support the reviewed claim within their scope.
- `changes_required`: the reviewer found a problem that needs correction.
- `insufficient_evidence`: the available evidence does not establish the claim.

These are model review judgments with recorded evidence, not external peer
review or a guarantee of scientific correctness. Using separate sessions of the
same model does not establish model diversity.

The review's execution state and its verdict remain separate. Failed, cancelled
or paused attempts retain their own states. A manual retry calls host-only
`retryReviewer(previous, next)` before scheduling: it creates a new review ID,
records `previousReviewId`, pins the new attempt and preserves the earlier
receipt. The frozen input package is not silently replaced. The host directs the
retried child to submit to the new review ID. Restart does not automatically
rerun an interrupted review.

## Books levels and history

| Level | Required evidence |
|---|---|
| `observation` | An actual recorded evidence package; independent reproduction may be missing, incomplete or unsupported |
| `verified` | Every cited evidence record is covered by a supported independent review; the reviewer attempt actually succeeded; that same reviewer produced a separate result artifact from the exact pinned original input versions |
| `convention` | Explicit human action on an already verified entry, with a recorded reason |

Adding a source file reference beside an unrelated reproduction output is not
enough. The reproduction artifact's actual process input provenance must include
each pinned original input ID and version. Missing provenance, no original
inputs, a still-running reviewer or only a supported textual review leaves the
entry at `observation`.

Immediately before proposing knowledge, the host calls
`verifyKnowledgeEvidence` to recheck both the original targets and the review's
reproduction artifacts. Corrupting a reproduction file after the review does
not make that file eligible for a new verified entry.

Human `decideKnowledge` is an application RPC, never an agent tool. Its actions
are `convention`, `revoke` and `supersede`, each requiring a reason. Supersession
must name another active entry in the same project. Old methods, evidence links
and decision history are retained; revoked or superseded entries cannot be
silently reopened.

An entry does not authorize a file read, network request, process or plugin.
It records method, rationale, applicability and evidence. A reusable method is
not automatically installed or enabled as a skill.

## Project state, memory and UI

Mission/evidence/review records, explicit project notes, agent operational notes
and Books are separate collections. Project notes and Books are reusable within
the project. A model-facing board view includes only the calling agent's private
notes. Notes are deliberately authored summaries of next actions, observed
constraints and unresolved questions; the ledger does not extract hidden
reasoning or automatically copy conversation text into memory.

Mission `phase` is derived from real records: `planned`, `evidence_recorded`,
`review_pending`, `review_interrupted`, `reviewed` or `knowledge_recorded`. Interrupted
or cancelled reviewer attempts do not remain labelled as pending. These labels describe what
has been recorded. `reviewed` does not mean approved; `knowledge_recorded` does
not mean verified. The explicit `stages[]` are planned labels and are not rendered
as completed steps without corresponding execution evidence.

The existing Workflow and result artifact UI remain authoritative for actual
tool execution and downloads. Research records reference those results and do
not recalculate engineering values in the browser.

## Verification and remaining acceptance

`tests/research.test.ts` covers scope and role boundaries, exact host-resolved
targets, duplicate/conflicting requests, concurrent writes, changed evidence,
separate reviewer binding, structured immutable verdicts, cancellation during
verification, reproduction provenance, manual retry, Books confidence gates,
human decisions, history retention and restart/memory separation.

These are ledger tests against real SQLite storage with controlled file resolver
responses. `tests/manager-research.test.ts` additionally exercises the actual Pi
SDK, TaskManager, SQLite and Node CSV MCP worker using a controlled loopback model
provider. It follows skill loading, planning, calculation, evidence recording,
separate reviewer dispatch, actual CSV reproduction, structured review, Books
classification and restart downloads. A second case cancels the reviewer,
restarts without automatic execution, and manually retries with a new review
binding while retaining the original result and cancelled record.

Those manager tests replace only the WASI availability discovery flag to enable
the existing approved artifact-transfer gate on development hosts without the
native runtime. They do not call the WASI runner, and explicitly check that every
calculation used the actual Node measurement MCP worker. They are neither WASI
acceptance nor live-model review-quality evidence. Native Mac/ChatGPT acceptance
must identify the exact source/build SHA and distinguish a true independent
reviewer run from a controlled provider fixture.

An end-to-end acceptance starts with the actual measurement CSV, then records
the produced statistics, dispatches a fresh reviewer with the original CSV and
that exact artifact, independently recalculates, submits a structured verdict,
records a method, and reloads the same evidence and decisions after restart.
Changed input, malformed CSV, missing evidence, cancelled reviewer, failed
reproduction and changed output bytes must remain visible as their actual
outcomes. No unobserved external MCP or native-account case is marked passed.
