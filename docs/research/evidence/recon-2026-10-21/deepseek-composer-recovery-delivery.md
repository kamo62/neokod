I'll start by reading the required documentation and tracing the code paths.Now implementing U-06. First the pure helpers and tests.Now U-07. Adding the draft-emptiness helper and tests.Implemented U-06 then U-07 on `work/core-composer-recovery`, based on `cc054117d`. Only the three owned files changed.

## Commits

- U-06: `217f062c6606d16a6650dbe9aa797e2f0f12ab27`
  `fix(web): keep a queued message queued until its send is accepted [skip ci]`
- U-07: `8eed3c91fe4de3e6fa682f3201e06739c245290e`
  `fix(web): restore the composer draft when a plan follow-up is rejected [skip ci]`

Pushed normally to `neokod/work/core-composer-recovery`; the branch tracks the remote and the remote head is `8eed3c91f`. No force push, no main/dev writes, no builds.

## Implementation

U-06:

- Added `canDispatchQueuedMessage`, `SendOutcome` and `settleQueuedDispatch` in `ChatView.logic.ts`.
- `dispatchQueuedMessage` now checks every send blocker before touching the queue, no longer removes the entry before sending, and no longer calls `insertTextAtEnd`.
- Queue ownership is released only on `accepted`, or on `failed` when the failure path restored the text into the composer. `not_attempted`, `attempted` and thrown sends keep the entry. A failed send with newer composer text keeps the queued entry instead of discarding it.

I used a direct per-invocation return from `onSend` rather than the card's shared `sendOutcomeRef`. Reason: a shared ref can be overwritten by an unrelated `onSend` between the queued send settling and its handler reading the ref, which would settle the wrong queue entry. The direct result ties the outcome to the invoking call and needs no new framework.

U-07:

- Added `isComposerDraftEmpty` and tests for every draft component.
- `onSubmitPlanFollowUp` now returns `"accepted" | "rejected"` on all exits.
- The plan branch snapshots prompt, images, terminal contexts, element contexts, preview annotations and review comments before clearing, then restores only on rejection, only while the target is still current and the draft is still empty. Newer user edits are not cleared, and acceptance does not restore.
- Extracted the existing failure restore into `restoreComposerDraftSnapshot` and reused it at both restore sites.

## Checks actually run

From `apps/web`:

- `pnpm exec vp test run src/components/ChatView.logic.test.ts`: 29 passed.
- `pnpm exec tsgo --noEmit`: passed, no output.

Scoped:

- `pnpm exec vp fmt --check` on the three files: passed.
- `pnpm exec vp lint --report-unused-disable-directives` on the three files: exited 0 with one existing unused-disable warning at the drain effect. The directive already exists on the base commit, so this change did not introduce it.
- `git diff --check`: clean.

No fail-first claim: the new helpers did not exist at base, so the first run checked new pure boundaries rather than reproducing the old defect. No browser harness exists for `ChatView`, and app/browser/provider actions were excluded, so the queue drain against a stopped server and the plan follow-up server-stop recovery remain unverified at runtime. No root gates or builds were run.
