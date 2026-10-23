# Review verdict: **request changes**

**Reviewed SHA:** `11aea1d6a640bc4c36175df0432fe5c5ac1d1e6e` on `feat/neokod-recovery`. You reported the worktree as clean, and the files I read match the diff. I did not re-run `git status` because this review had no shell.

**Scope:** read-only source tracing (Read/Glob/Grep). Nothing was run, built or edited. This review does not prove live Codex, browser or OS process behaviour. The plan file and ExitPlanMode tools weren't available here, so the full review is in this message.

---

## P1: blocking

### P1-1: Symphony questions can no longer be answered from either production UI surface

- **Trigger:** any pending `user_input` request shown in the project Attention tab or on the run page.
- **Path:** `SymphonyAttentionList.tsx:60-65` and `SymphonyRunDetailView.tsx:304-309` render `SymphonyApprovalActions` with only `environmentId`, `requestId`, `mode` and `onDone`. Neither passes `questionPayload` or `runAttemptId`.
  - `AttentionItemSchema` (`contracts/symphony.ts:641-664`) has no question payload.
  - `approvalToAttentionItem` (`SymphonyOrchestratorLive.ts:500-535`) drops it.
  - In question mode with no payload, the component goes to the last branch: "This request did not record answerable questions. It cannot be answered here". That covers structured and legacy rows alike.
- **User impact:** no question can be answered. The agent waits until the wait timeout, which now ends the provider request with an error, and the run fails. Before this change, free-text answers worked. The S1–S5 acceptance check ("current live reply continues once without Resume") cannot pass.
- **Bounded correction:**
  - Run page: look up `details.approvalRequests.find(r => r.id === item.id)` and pass its `questionPayload` and `runAttemptId`.
  - Attention tab: add an optional `questionPayload` to the attention projection in `approvalToAttentionItem` (through the shared-contract owner).
  - Add a caller-level test that a structured question renders option buttons.

### P1-2: A user's Stop can be turned back into a re-queue or retry

- **Trigger A (in-process race):** a Stop on a run that started more than `codexStallTimeoutMs` ago (default 300 s), when the 30 s poll lands while `cancelAttempt` is waiting for closure.
  - The interrupted fiber's `ensuring` removes the run from `activeAgents` first (`Dispatcher.ts:802-806`). Only then does it check `isStopping`.
  - `isAgentActive` (`Dispatcher.ts:1057-1058`) reads only `activeAgents` and ignores `stoppingAttempts`.
  - `cancelAttempt` then spends up to 5 s on `Fiber.await` plus the default 10 s TERM grace inside `confirmOwnedProcessClosure`.
  - In that window the reconciler (`Reconciler.ts:182-185, 210-262`) sees an inactive run. It confirms closure itself, marks the attempt `stalled` and calls `releaseClaim(…, "queued", fence)` with the still-matching fence.
  - `launchNextQueuedWork` can then re-dispatch it in the same poll. The Stop's later `releaseConfirmedStop` fails and reports `held: claim_changed`, which is false because the item is already re-queued.
- **Trigger B (deterministic):** any held Stop (`dispatch_not_exited`, `ownership_revoked`, `termination_failed`, `leader_gone_descendants_unconfirmed`), followed by either:
  - a server restart: Recovery (`Recovery.ts:249` onward) confirms closure, since the detached leader survives the restart and gets TERM. It then marks the attempt `interrupted` and releases to `retry_scheduled`.
  - descendants exiting later: the reconciler confirms `leader_and_group_gone` and releases to `queued` once the stall timeout passes.
  - Neither path reads the durable `stop_requested` / `stop_unconfirmed` intent.
- **User impact:** a run the user explicitly stopped is relaunched on its own. It spends tokens again and can push work. This breaks "confirmed Stop" and 16.16 "stop/restart never releases unconfirmed work".
- **Bounded correction:**
  1. Make `isAgentActive` return true while the attempt is in `stoppingAttempts`.
  2. In Recovery and the reconciler, when the latest attempt has a `stop_requested` event (or a persisted stop-intent column), settle confirmed closure through `releaseConfirmedStop` plus `user_cancelled`, never queue or retry.
  3. Add regressions for both triggers.

### P1-3: On Windows, every Stop and every failed run is held forever

- **Trigger:** any Symphony run on win32, which README:61 lists as a shipped platform.
  - `AgentRuntime.ts:330` spawns non-detached, so `childIdentity` is undefined and only the pid is recorded.
  - `planOrphanGroupTermination` returns `unsupported_platform` (`processGroup.ts:47-58, 368-369`).
  - So `markFailed` → `failure_hold` (`Dispatcher.ts:362-375`), `ensuring` → `execution_hold` (`:840-851`), and every `cancelAttempt` → held.
  - The reconciler and Recovery hold the same rows forever. No operator action exists to release them.
- **User impact:** before this change, Stop and retry worked on Windows. Now any non-success run stays in `running` with its claim and workspace held for good. Stop never completes, and nothing gets retried. The `Effect.scoped` finalizer in `SymphonyOrchestratorLive.ts:1821-1825` does kill the child, so the hold also misreports state.
- **Bounded correction:** pick one:
  - (a) Refuse Symphony dispatch on platforms without supported closure proof, before claiming, with a visible reason (honest fail-closed at admission).
  - (b) Accept the runtime-owned child's observed exit (its scoped kill completed, and on Windows a tree-kill whose exit is confirmed) as closure evidence for an in-process tracked child.

---

## P2: should fix

### P2-1: One provider option with an empty description breaks approval reads for every run

- **Trigger:** Codex sends `options[i].description` as `""` or whitespace. Codex types it as a plain `string`.
  - `parseQuestionPayload` keeps it as `""`.
  - The stored payload then fails `ApprovalQuestionSchema` on read, because `UserInputQuestionOption.description` is a `TrimmedNonEmptyString` (`providerRuntime.ts:556-559`).
  - `listPending` and `listForRun` decode with `Effect.forEach` (`ApprovalRepository.ts:318-339`), so one bad row fails the whole list.
- **User impact:** the global Attention list, run details, `sweepExpiredApprovals` and Recovery's approval interruption all fail. The question itself shows as "not found".
- **Correction:** make the option description optional or `Schema.String` in the stored question schema, or drop empty descriptions at parse time. Add a parse test with an empty description.

### P2-2: A held Stop is acknowledged to the client as success

- **Path:** `ws.ts:1130` returns `{ ok: true }` no matter what `cancelRun` did. The web Cancel button (`SymphonyRunDetailView.tsx:193-200`) fires and forgets.
- **Impact:** the only sign of a held Stop is a global notification. The run page gets no scoped evidence. A repeated confirmed Stop also republishes "Run cancelled" and records another `run_cancelled` audit entry.
- **Correction:** return `StopOutcome` through the orchestrator and RPC, and render the held reason on the run.

### P2-3: Accepted guidance is not frozen in production (scope gap, plus latent defects)

- **Gap:** no caller freezes, persists or passes `acceptedGuidance`.
  - `Dispatcher.ts:614-625` and `:701-727` call `runTurn` without it.
  - `RunAttemptRepository` never reads or writes `accepted_guidance_json`.
  - This matches the plan's serialized sequencing, but the commit title "freeze accepted guidance for run attempts" overstates it. F6 must stay open.
- **Fix before wiring:**
  - `assertAcceptedTarget` compares `target.baseBranch` (the base, e.g. `main`) with `input.branch` (the work branch). Every snapshot that has a `baseBranch` would be refused.
  - `AcceptedSourceSnapshotSchema.kind` uses `TrackerKindSchema`, but `freezeAcceptedGuidance` copies `WorkSource.kind`, which can be `"manual"`. Manual and delegated items would fail decode.
  - The `as unknown as` cast in `asPromptAcceptedGuidance` hides contract drift.

---

## Not blocking

- **Secret answers:** a retried answer to a sensitive question with a _different_ secret is reported as an idempotent success, because both compare as `[redacted]`. Only the first value was delivered.
- **Ownership-record failure:** `onChildSpawned` failure uses `Effect.die` in the Dispatcher. That bypasses AgentRuntime's typed log and `mapError`, and the test exercises the typed `fail` path instead. The child is killed by `Effect.scoped`, but `ensuring` releases with `no_owner_recorded` before that kill.
- **Marker leak:** `stoppingAttempts` is never cleared on the early held returns (`attempt_not_found`, `stale_attempt`, `attempt_terminal`, `claim_not_owned`).
- **Multi-select custom text:** the UI submits custom text on a multi-select question as a string, which the server rejects. Codex sends no `multiSelect`, so this isn't reachable today.
- **HandoffService takeOver:** the tests use a fake dispatcher that never sets the item to `cancelled`. With the real confirmed Stop, the park step (whose `from` list excludes `cancelled`) would refuse. This looks broken before this change too, so I haven't counted it against this diff, but no test covers the real composition.

## Requirements this diff meets

- **No signal without proof:** reused PIDs, bare legacy PIDs and the server's own PID are never signalled. Closure must be confirmed before Recovery, the reconciler or Stop release anything, and release is fenced to the exact claim.
- **No fake timeout answer:** a timed-out question sends no synthetic empty answer.
- **Per-question answers:** each answer is validated against its own question id.
- **Honest history:** answered and approved stay distinct, legacy rows decode honestly, notes are labelled history-only, and provider receipt is recorded as `unknown`.
- **No secrets in the snapshot:** the accepted snapshot never takes the raw config or tracker credentials.
- **Normal Code threads untouched:** ordinary Code threads are not routed through Symphony.

**Recheck:** after fixes to P1-1, P1-2 and P1-3, the final SHA needs a fresh source recheck, the focused tests, and one observed real Codex question/continuation and Stop/restart before acceptance.
