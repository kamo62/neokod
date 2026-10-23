**Verdict: request changes.** I found two P1s and one P2.

I reviewed HEAD `0ebac2fb4bd2c9be16bd29bf32c6b89b615cccbc` with a clean worktree. Both come from your brief; I ran no commands, so I didn't confirm them myself. Everything here is from reading source with Read/Grep/Glob. I ran nothing and didn't check live Codex or browser behaviour. Plan mode was on, but this session has no Write or ExitPlanMode tool, so I've put the findings here instead of in a plan file.

## P1-1: Agent questions can no longer be answered from either screen

- **Trigger:** any pending agent question shown on the run page or the project Attention tab.
- **Path:**
  - The two screens that show the answer controls, `apps/web/src/components/symphony/SymphonyRunDetailView.tsx:304-309` and `apps/web/src/components/symphony/SymphonyAttentionList.tsx:60-65`, pass only `environmentId`, `requestId`, `mode` and `onDone`. They pass no `questionPayload` and no `runAttemptId`.
  - In `SymphonyApprovalActions.tsx`, when question mode gets no payload it falls through to the final branch: "This request did not record answerable questions. It cannot be answered here".
  - `AttentionItemSchema` (`packages/contracts/src/symphony.ts:641-664`) has no question field, so the Attention tab couldn't pass the questions even if it tried.
  - The tests only render the component with the props filled in by hand, so they miss this.
- **User impact:** before this change, a free-text answer worked. Now every question shows as unanswerable. The agent waits until `liveRequestsWaitTimeoutMs`, then gets the -32001 error and the run stalls. This breaks the core answer flow.
- **Fix:**
  - **Run page:** look up `details.approvalRequests.find((r) => r.id === item.id)`. The attention item id is the approval id (`SymphonyOrchestratorLive.ts:516`), and `RunDetails.approvalRequests` already carries `questionPayload`. Pass its `questionPayload` and `runAttemptId`.
  - **Attention tab:** add an optional `questionPayload` to `AttentionItemSchema`, fill it in `approvalToAttentionItem` (`SymphonyOrchestratorLive.ts:500`), and pass it through.
  - Add a test that renders the two real screens.

## P1-2: An empty option description hides all pending requests and leaves the row stuck

- **Trigger:** Codex `item/tool/requestUserInput` sends an option whose `description` is empty, whitespace or missing.
- **Path:**
  1. `parseQuestionPayload` (new in `AgentRuntime.ts`) stores `description: ""`.
  2. `ApprovalQuestionSchema` reuses `UserInputQuestion`, whose option `description` must be non-empty (`packages/contracts/src/providerRuntime.ts:556-559`).
  3. `create` inserts the row, then `rowToApproval` fails to decode it. That error is swallowed by the `recordRequest` catch, so the row stays `pending` in the database.
  4. From then on, `ApprovalRepository.listPending` and `listForRun` (`ApprovalRepository.ts:318-339`) fail the whole list via `Effect.forEach`. `ApprovalService.listPending` and `listForRun` (`ApprovalService.ts:504-508`) turn that failure into `[]`.
  5. `getById` returns null, so answering fails with not-found. `expireRequest` (`ApprovalService.ts:570-578`) can't find the row, so it is never expired.
- **User impact:**
  - One malformed provider question makes the global pending list and that run's approval history show zero requests: an unknown state shown as zero.
  - The question can't be answered.
  - The row stays `pending` forever.
- **Fix:**
  - Give the Symphony question its own option schema with `description: Schema.String` (or optional) instead of reusing the stricter provider schema.
  - Check the payload against `ApprovalQuestionPayloadSchema` before persisting, and store it as `unsupported` if it fails.
  - In `rowToApproval`, read an undecodable question payload as `unsupported` instead of failing the whole row.
  - Add a test with an empty option description.

## P2-1: A custom answer to a multi-select question is always rejected

- **Trigger:** typing custom text for a `multiSelect` question. A multi-select question with no options can only be answered this way.
- **Path:** `answerInputs` in `SymphonyApprovalActions.tsx` sends the custom text as a plain string. `validateStructuredAnswers` (`ApprovalService.ts`) rejects any non-array answer when `multiSelect === true`.
- **User impact:** an `invalid_answer` error every time, and some questions can never be answered. This is hidden behind P1-1 today but appears as soon as P1-1 is fixed.
- **Fix:** send `[custom]` for multi-select questions, or have the server wrap a single string into an array.

## Lower-severity note

- **Secret retry claims success:** `sameAnswers` compares the redacted records. A second submission with a _different_ secret, from a stale tab, returns success even though nothing was delivered. Treat a non-pending retry that touches redacted entries as stale.

## Gaps (not blocking, but the lane overstates them)

- **Accepted guidance is never used in production.** Nothing in `symphony/Persistence` reads or writes `accepted_guidance_json`, and `Dispatcher.runTurn` never passes `acceptedGuidance`. So no snapshot is ever frozen, and the target refusal and permission narrowing never run outside tests. The snapshot itself correctly leaves out front matter and secrets, keeps empty and absent guidance distinct, and keeps unset delivery gates as `null`.
- **Process identity is never recorded.** `Dispatcher.ts:399-409` ignores `identity` and catches its own errors. So `owner_pgid` and `owner_birth_token` are never written, and the new fail-closed path can't trigger in production.
- **Redelivery still creates a second row.** `recordPending` creates a new random UUID each call (`ApprovalService.ts:375-389`). `ON CONFLICT(id) DO NOTHING` therefore never merges a real redelivery; the "one durable row" test only calls the repository directly.
- **Codex's reaction to the timeout error is unproven.** How Codex handles the -32001 error reply to a user-input request can't be confirmed from source.
- **Narrowed `reviewer` can differ from the canonical rule.** It drops the `codexTurnSandboxPolicy === "readOnly"` → `user` rule in `Policy.ts:84-88`. This is only reachable through accepted guidance, which isn't used yet.
- **Answer history isn't shown.** `approvalRequestHistory` is only used by its own test; no screen displays answers or notes yet.

## Checked and correct

- Migrations 045–047 only add nullable columns.
- Old `approved` question rows read back as `answered` with no answer invented.
- Answers are matched per question id, with exact-id validation in both LiveRequests and ApprovalService.
- A timed-out question no longer sends a fake empty answer.
- Approval notes are clearly labelled history-only.

The SHA needs rechecking once code changes.
