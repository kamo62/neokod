**Verdict: request changes** for `dd032f8674e667ddad8258634bb93e7df5e614f6` (`feat/neokod-feedback`) against `0b5ccd78e`.

The fixes for the original S1 to S5 findings are mostly right on the server side. Four P1 issues remain. One stops questions being answered in the current production UI. One can record an answer or approval that never reached the agent as delivered. Two sit in guidance code that production does not call yet, but they break 16.16 requirements.

This review used read-only git, ripgrep and sed. I made no edits and ran no tests, typecheck, build or browser checks. Source review cannot replace the gate that needs one real Codex continuation.

## Production path I traced

`AgentRuntime.handleRequest` → `approvalServiceRequestCallbacks` → `ApprovalService.recordPending` → `ApprovalRepository` (SQLite, migrations 045 to 047) → `LiveRequests` registration and waiting promise → `ws.ts` respond/approve/reject → `SymphonyApprovalActions`, called by `SymphonyAttentionList` and `SymphonyRunDetailView`.

Production `Dispatcher.ts` is unchanged in this range. It does not pass `acceptedGuidance` and it drops the child identity, so those parts are not reachable yet.

## P1 findings

**P1-1. A "delivering" row can be recorded as answered or approved when nothing was delivered, and recovery never cleans it up.**

- **Trigger:**
  1. `respondToUserInput` or `decide` saves the answer as `delivering` (`ApprovalService.ts`).
  2. The server crashes before the live request is resolved. A failed `abortDelivery`, which is only logged, has the same effect.
  3. After restart, the operator presses Send again; the component keeps the draft.
  4. The retry hits `record.state === "delivering"` (lines 496 and 561), sees the same content, and calls `completeDelivery` without any proof of live delivery. The row becomes `answered` or `approved` for an attempt that is dead.
- **Without a retry:** the row stays `delivering` forever. `listPending` only selects `state='pending'` (`ApprovalRepository.ts:361`). Startup recovery's `interruptRunApprovals` (`SymphonyOrchestratorLive.ts:1083-1094`) and the expiry sweep both read from that list, so neither touches the row.
- **UI:** `attention.logic.ts:127` labels these rows "Delivery to the agent was accepted", which is false for this case.
- **Impact:** history shows an answer or approval as delivered when it was not. That breaks the crash and lost-acknowledgement acceptance and the rule against false receipt claims.
- **Bounded fix:**
  - Only finalise a `delivering` retry when this process has positive evidence that the live claim succeeded, for example an in-memory set of claimed ids or a durable marker written straight after the claim. Otherwise refuse it as stale or unknown.
  - Have startup recovery reconcile `delivering` rows to `interrupted`, keeping the content with delivery shown as unknown.
  - Change the label to "Delivery unknown".
  - Add one regression test: stage, rebuild `LiveRequests`, retry, and confirm the row is not `answered`.

**P1-2. In the current production UI, questions can no longer be answered.**

- **Trigger:** both callers (`SymphonyAttentionList.tsx:60` and `SymphonyRunDetailView.tsx:304`) still pass only `requestId`, `mode` and `onDone`. With `questionPayload` undefined, every question falls through to "This request did not record answerable questions."
- **Impact:** before this change, a single-question request could be answered. Now every question waits about 30 minutes and then expires. This is a regression in a lane-owned component, not just unfinished wiring.
- **Data gap:** `AttentionItem` (`approvalToAttentionItem`) carries no `questionPayload`. Run details do have it, in `approvalRequests`.
- **Bounded fix:** do not ship this commit to dev without serial UI wiring:
  - The run detail view passes the matching request's `questionPayload` and `runAttemptId`.
  - The attention list either receives the payload through the projection or links to the run page instead of offering a dead control.

**P1-3. The approval-policy narrowing loosens an accepted policy in one case.**

- **Trigger:** `narrowAcceptedPermissions` (`AcceptedGuidance.ts:357`) returns `never` whenever either side is `never`, which contradicts its own rank table.
  - Accepted `untrusted` plus live `never` becomes `never`. In the sandbox, `untrusted` requires human approval for commands that are not known safe; `never` runs them unattended.
  - The function correctly refuses the reverse direction (accepted `never`, live approvals enabled).
- **Impact:** editing the workflow later can loosen an accepted attempt's human gate. 16.16 forbids that. The code path is not wired into production yet.
- **Agreement check:** the prompt and runtime agree. Narrowing twice gives the same result, so this is a policy-rule error, not a disagreement between them.
- **Bounded fix:** treat `untrusted` against `never` as unrepresentable in both directions. Keep `on-request` plus `never` resolving to `never`. Add one test.

**P1-4. Manual work is relabelled as the tracker kind, against the contract.**

- **Trigger:** the contract adds `AcceptedSourceKindSchema` including `"manual"` and says provenance must not be relabelled. The builder still uses `sourceKindFor` (`AcceptedGuidance.ts:171`), which maps manual to `config.trackerKind`. `AcceptedGuidance.test.ts:218` asserts the wrong behaviour.
- **Impact:** an accepted brief would record a false source. This path is not wired into production yet.
- **Bounded fix:** store `"manual"` and correct the test.

## P2 findings

- **Settled requests stay pending.** When a run is cancelled or finishes (`settleRun`), the runtime sends an error response, but the durable row stays `pending` until the expiry sweep. The comment near `AgentRuntime.ts:923` says the row is left `expired`/`interrupted`; that is not true for the settled branch. Fix: call `approvals.interrupt` on that branch.
- **Child identity is lost at the Dispatcher.** `AgentRuntime` builds the identity and `Live.ts` forwards it. The `AgentRuntimeFactory` type in `Dispatcher.ts:103` is still `(pid) => Effect<void>`. The Dispatcher catches recording errors, so the runtime's fail-closed path never runs. The 047 columns are never written. `pgid` is assumed from the `detached` spawn option, not observed. Fix: tighten the factory type so the identity cannot be dropped silently; Recovery stays serial work.
- **One bad row hides every row.** A row that fails to decode makes `listPending`, `listForRun` and `listRecent` fail as a whole. Causes include bad answer or note JSON, or a snapshot whose approval policy and `approvalsEnabled` disagree. `ApprovalService.listPending` then returns `[]`, which hides all requests from recovery and the sweep. Fix: degrade per row.
- **Secret questions.** The answer input is not masked and shows no sensitivity cue. Retrying a redacted answer that is still delivering reports "no longer pending", which is misleading.
- **Duplicate check and serial handling.** The duplicate check compares only `reason` and `command`, not `questionPayload` or `action`. Requests are still handled one at a time (this predates the lane), so one waiting request blocks later provider requests for up to 30 minutes.
- **Unchecked updates.** `stageDelivery` and `completeDelivery` do not check affected row counts. The service lock limits the risk in a single process.
- **Snapshot digest.** The accepted-snapshot digest is never recomputed on read.
- **Multi-select.** A custom answer clears any selected options, so the two cannot be combined. Codex's `isOther` flag is ignored. Question ids are trimmed before the reply is sent.
- **File ownership.** This branch includes guidance-lane files (`AcceptedGuidance`, `Prompt`, `RunAttemptRepository`) and `Policy.ts`, which no lane owns. The coordinator must reconcile this with the guidance lane before integration.

## What I verified as correct in source

- **S1:** a timeout sends an explicit `-32001` error, never an empty synthetic answer.
- **S2:** answers are keyed per question id and checked for an exact id match in three places: `prepareAnswer`, `LiveRequests`, and `sendAnswers` in the runtime. Nothing is duplicated or filled in.
- **S3:** structured questions are stored with a version, and older rows decode as `legacy_text` or `unsupported`. Questions with no options are kept.
- **S4:** history now separates `answered` from `approved`, and old rows are relabelled.
- **S5:** notes are saved as history only. Displaying them is still UI work.
- **Lost acknowledgement within one process:** retrying the same content is idempotent, and a different answer is rejected. The live claim can only succeed once and the service lock is global, so there is no double delivery.
- **Request ids:** the collision across attempts is fixed by UUID record ids keyed on attempt and request id.
- **Typed Stop result:** no production code produces it yet. `cancelRun` returns nothing, so the RPC returns `{ok:true}` with no outcome. That honestly means "unknown" for older servers, as long as no UI treats `ok` as proof the run stopped.

## Status and limits

- Not complete: guidance admission, Dispatcher and Recovery identity, Stop producers and UI wiring remain serial seams.
- Required checks (`vp check`, `vp run typecheck`) and tests were not run in this review.
- This source review does not satisfy the live gate: one real Codex continuation must still be observed before shipping.
