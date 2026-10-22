I'll start by locating the worktree and reading the required context.Now I have the full picture. Let me implement the pure logic changes first.All checks pass. Committing the five task files.Pushed the correction on `work/core-composer-recovery`.

**Commit**

- `7d6f33890445b7c35d0d45975778d03a8dcfcc09` `fix(web): keep queued send identity through unknown outcomes [skip ci]`
- Pushed to `neokod/work/core-composer-recovery` at the same hash. No merge to `dev` or `main`.

**What changed**

1. A generic `OrchestrationDispatchCommandError` is now `unknown`, not `rejected`. This covers receipt-read, startup/queue and post-commit failures that can follow acceptance. A retry of an earlier unconfirmed attempt keeps its message/command identity and stays `unconfirmed`.
2. The post-claim mount/target guard now calls the prior-aware `"not_attempted"` settlement. An earlier unconfirmed attempt stays unconfirmed; a first attempt becomes failed.
3. Queued text is passed as an invocation-owned `promptOverride`. The send no longer writes or clears the shared `promptRef`, and queued sends no longer clear the visible composer draft. A newer draft, including identical text, is not touched.
4. `messageCreatedAt` is the first claim time, stored on the dispatch claim and reused on retries. Legacy claims fall back to their first `attemptedAt`, never the queue entry's `createdAt`.
5. First-attempt message and command IDs are derived deterministically from the saved queue entry id (`queued-message:<id>`, `queued-command:<id>`). A lost claim with `dispatch: null` therefore replays under the same identity. A definitive failed entry still retries with fresh IDs, and no entry auto-replays after failure.
6. Removed the now-unreachable `rejected` send outcome. Definitive `failed` still comes from local pre-dispatch failures and guarded `not_attempted` exits.

U06 direct ordinary sends are unchanged. U07 direct plan-follow-up restoration still restores on every non-accepted outcome.

**Checks**

- `pnpm --dir apps/web exec tsgo --noEmit`: passed.
- `vp lint` on the five changed files: passed.
- `vp fmt --check` on the five changed files: passed.
- `vp test run --project unit src/composerDraftStore.test.ts src/components/ChatView.logic.test.ts`: 2 files, 145 tests passed.
- `git diff --check`: passed.

**Exact limits**

- The flush/readback proves acceptance by persistent browser storage, not an operating-system disk flush. A force-kill before the browser writes its cache can still lose the claim. The deterministic IDs make that replay idempotent, but this does not establish whole-app-kill durability.
- If the claim is fully lost, the original first-attempt timestamp is unrecoverable. The replay uses the replay time for the optimistic row; the server keeps the originally accepted row. Stable identity, not timestamp recovery, prevents the duplicate.
- `ChatView.tsx` has no render harness in this repo. The route-guard and shared-ref lifecycle changes are covered by source review and pure-logic tests, not by a rendered or runtime run.
- No builds, installs, browser/app runs, live provider calls, user data access, or full-repo checks were run.
- Item 2.2 was not started.
