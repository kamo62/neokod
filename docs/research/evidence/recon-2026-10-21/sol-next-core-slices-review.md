I’ll map only those nine cards against the canonical plan, current source, tests and history. I’ll separate concrete implementation gaps from verification holds, without running checks or changing files.
The current source still contains the U-06/U-07/U-11 defects described in the cards. Here, “verified, holds” means the finding was verified as valid, not that the fix is complete. X-9’s unconditional force-removal path is also still present. I’m checking the Git and recovery paths next to define safe lane boundaries.
All nine cards still have concrete source gaps; none is merely waiting for runtime evidence. The existing reconciler handles stopped/error bindings and turns already known to have ended, but still skips the hard-crash case. I recommend three disjoint lanes: composer/rewind, sidebar/Git safety, and shared crash recovery. That keeps the overlapping files under one owner per lane.
All nine cards still have concrete implementation gaps on `dev` at `cc054117d`. None is merely an implemented fix awaiting runtime evidence.

“Verified, holds” on U-06/U-07/U-11 means the reported defect holds, not that its correction is complete. Existing recovery and Git safeguards cover narrower cases.

This was read-only. No tests, installs, builds, app/provider actions, edits, subagents, commits, pushes or external messages were performed. Existing working-tree changes were left untouched.

## Current-state matrix

Paths and lines refer to the inspected revision.

| Card     | Current status                                                                                 | Source and existing-test evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **U-06** | Missing: queue ownership is surrendered before acceptance.                                     | `apps/web/src/components/ChatView.tsx:4402–4417` removes the entry before `onSend`; `:4014–4021` can return without attempting a send. Recovery ignores the boolean from `apps/web/src/components/chat/ChatComposer.tsx:2086–2097`, which refuses insertion while unavailable. `ChatView.logic.test.ts:150` covers sendability, not queued-dispatch settlement.                                                                                                                                               |
| **U-07** | Missing: rejected plan follow-up does not restore the draft.                                   | `apps/web/src/components/ChatView.tsx:4055–4067` clears prompt and attachments before awaiting submission. `:4627–4774` has early exits and failure handling but returns no acceptance result or draft restoration. The ordinary-send restore at `:4347–4381` is not used by this branch.                                                                                                                                                                                                                     |
| **U-11** | Missing: Copy Path can select the first project’s root.                                        | `apps/web/src/components/Sidebar.tsx:4126` supplies the first project for All threads; `:2228–2232` searches only group members and then falls back to that project. No scoped workspace-path resolver or corresponding regression exists in `Sidebar.logic.test.ts`.                                                                                                                                                                                                                                         |
| **X-9**  | Partially supported by old cleanup machinery; card requirements missing.                       | `apps/web/src/hooks/useThreadActions.ts:258–286` derives ownership from client-selected deletions and prompts with a basename; `:367–373` forces removal. `Sidebar.tsx:1890–1898` supplies all selected keys before outcomes are known. `apps/server/src/vcs/GitVcsDriverCore.ts:2458–2472` removes without inspection or branch reclaim. Existing `worktreeCleanup.test.ts:37–83` tests local sharing; `Sidebar.logic.test.ts:97–115` tests continuing after failure, not surviving-thread protection.       |
| **X-10** | Missing: no authoritative conflict refusal or operation-state reporting.                       | `apps/server/src/vcs/GitVcsDriverCore.ts:1478–1482` treats unmerged records as ordinary changed paths; `:1617` subsequently stages everything. `apps/server/src/git/GitManager.ts:1868–1876` has no conflict gate. `packages/contracts/src/git.ts:201–219` has neither conflict nor operation fields. Existing Git tests do not cover the card’s refusal cases.                                                                                                                                               |
| **X-11** | Partial separators exist, but the specified validation and argv protection are missing.        | Unsafe checkout arguments remain at `apps/server/src/vcs/GitVcsDriverCore.ts:2676–2684`; clone at `apps/server/src/sourceControl/SourceControlRepositoryService.ts:209`; Symphony revisions at `apps/server/src/symphony/Review/ModelReviewer.ts:197,202`; evidence range at `apps/server/src/symphony/Evidence/Service.ts:156`. Existing tests still expect unprotected removal/clone argv at `GitVcsDriverCore.test.ts:204` and `SourceControlRepositoryService.test.ts:182`.                               |
| **2.2**  | Missing: no pre-revert recovery snapshot, shared-folder busy refusal or honest confirmation.   | `apps/server/src/orchestration/Layers/CheckpointReactor.ts:783–787` restores directly. Existing capture support in `apps/server/src/vcs/GitVcsDriver.ts:774–859` is reusable, but restore at `:881–897` overwrites tracked files and cleans untracked files. `apps/web/src/components/ChatView.tsx:3966–3971` mentions only chat/diffs. `CheckpointReactor.test.ts:999` covers successful revert, not recovery or busy-folder protection.                                                                     |
| **2.3**  | Partial reconciliation exists; hard-crash settlement is missing.                               | `apps/server/src/provider/Services/ProviderSessionReconciler.ts:111–120` explicitly skips running/starting bindings. Its test at `ProviderSessionReconciler.test.ts:232–254` pins that behaviour. `apps/server/src/provider/Layers/ProviderSessionReconciler.ts:37–55` dispatches session settlement but has no host-lost binding write.                                                                                                                                                                      |
| **X-7**  | Missing: unrecoverable-session handling, live interrupted-session closure and safe error text. | `apps/server/src/provider/Layers/ProviderService.ts:568–573` returns an untyped validation error. Stop/answer paths allow recovery at `:914–917`, `:951–954`, `:990–993`. `ProviderCommandReactor.ts:910–1002` records failures instead of settling unrecoverable sessions and stores `Cause.pretty`. `ProviderRuntimeIngestion.ts:2051,2195–2199` does not consume interrupted session updates. Existing tests cover provider exits, stale requests and startup reconciliation, not this first-restart path. |

Runtime/UI acceptance remains outstanding for every row. Source inspection establishes the gaps, not reproduced runtime results.

### What history does, and does not, close

- U-06’s remove-before-send code is still the implementation from `51b8e7c16`.
- `85d255a63`, titled “make worktree removal idempotent and finish bulk deletes”, supplied idempotent removal and continue-after-failure behaviour. It did not implement X-9’s inspection, successful-delete ownership or branch reclaim.
- `814408bc9` and `a709bb58b` supplied narrower session reconciliation. `7eb401554` implemented card 2.4’s command-read-model optimisation, not 2.3’s host-lost settlement.
- `f3a8bc935` surfaced interrupt failures and cleared stale OpenCode requests. The shared unrecoverable-session and sanitisation requirements of X-7 remain absent.

## Dependencies before parallelisation

Recommend three lanes, rather than splitting overlapping files between workers:

1. U-06 → U-07, followed by 2.2 under the same owner. All touch `ChatView.tsx` and its logic/tests.
2. U-11 and X-9 share `Sidebar.tsx`. Keep them with X-10/X-11 because those Git cards also share contracts, driver, shared logic and tests. Apply X-9 → X-10 → X-11.
3. Preserve the already implemented 2.4 change; implement 2.3 → X-7 together.

The startup dependency is important: `apps/server/src/serverRuntimeStartup.ts:340–345` starts runtime-item reconciliation before provider-session reconciliation. Implementing 2.3 alone would not close pending items during that first restart. X-7 must consume the later authoritative interrupted-session event.

These lanes have disjoint write ownership and can proceed as source work under section 16.8. They do not authorise ordinary-child or Symphony UI launch.

## Exact next DeepSeek briefs

These are proposed implementation briefs, not actions executed here. Retain one card per commit.

### Lane A: U-06 → U-07 → 2.2

Ownership:

- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/components/ChatView.logic.ts` and `.test.ts`
- `apps/server/src/checkpointing/Utils.ts` and new `Utils.test.ts`
- `apps/server/src/orchestration/Layers/CheckpointReactor.ts` and `.test.ts`

Tasks:

- U-06: retain queued ownership until accepted, or until failed-send restoration demonstrably transfers ownership to the composer. Remove the duplicate insertion recovery. Early return, exception or failed restoration keeps the entry.
- U-07: return explicit accepted/rejected submission results; snapshot and reuse the existing restoration logic for prompt and all attachment/context collections. Never overwrite a newly entered draft. Feed plan-submission acceptance into U-06’s settlement.
- 2.2: refuse another running/connecting session in the same session cwd; capture a recovery ref before restoring; abort without mutation if capture fails; record the recovery ref and correct the confirmation copy. Reuse `CheckpointStore`; do not change restore semantics or introduce recovery-ref cleanup.

Focused acceptance:

- `ChatView.logic.test.ts`: dispatch blockers, ownership outcomes, draft emptiness and confirmation copy.
- `Utils.test.ts` / `CheckpointReactor.test.ts`: recover tracked and untracked content from the saved ref; busy refusal changes nothing; capture failure prevents restore; ready/different-folder sessions remain allowed.
- Rendered queue/draft behaviour remains a separate pending check. Preserve the card’s documented non-canonical cwd-comparison limitation.

### Lane B: U-11 → X-9 → X-10 → X-11

Ownership: the exact X-9/X-10/X-11 file lists in `docs/plan-cards/07-git-terminal-and-web-hardening.md`, plus U-11’s `Sidebar.logic.ts` and `.test.ts`.

This gives one worker exclusive ownership of `Sidebar.tsx`, `useThreadActions.ts`, `worktreeCleanup.ts`, Git driver/manager/workflow files, Git contracts/RPC, shared Git logic, VCS client commands, Git action surfaces, clone handling and the two specified Symphony Git call sites.

Tasks:

- U-11: resolve worktree or project root by environment plus project identity; unknown owner means unavailable, never first-project fallback.
- X-9: implement the specified inspect RPC end to end. Inspect failures keep the worktree. Use authoritative surviving links after deletion outcomes; require full-path/loss confirmation and a second discard confirmation before force. Reclaim only eligible `neokod/` branches using compare-and-delete.
- X-10: collect conflicts and operation state; preserve them through status streams; reject commit/push/PR actions before staging or other side effects. Keep resolved-merge commits allowed and add the specified thin UI guards.
- X-11: implement the shared validators and every enumerated call-site correction in the card. Preserve revision expressions and Unicode names; do not turn this into a general Git audit.

Focused acceptance:

- `Sidebar.logic.test.ts`, `worktreeCleanup.test.ts`: scoped paths, loss prompts and retained shared worktrees.
- `GitVcsDriverCore.test.ts`: inspection counts, reclaim/keep cases, dirty refusal, operation state, malicious names/ranges and protected argv.
- `GitManager.test.ts`: unresolved conflicts remain unstaged and uncommitted; resolved merge can conclude.
- Shared Git stream tests, Git action logic tests, clone-service tests and the X-9 RPC test.
- Explicitly verify failed bulk deletion leaves the surviving thread’s worktree intact. Existing “continue after failure” coverage does not prove this.

Leave Symphony workspace-removal policy unchanged.

### Lane C: 2.3 → X-7

Ownership:

- `provider/Services/ProviderSessionReconciler.ts` and `.test.ts`
- `provider/Layers/ProviderSessionReconciler.ts`
- `provider/Errors.ts`
- `provider/Layers/ProviderService.ts` and `.test.ts`
- New `provider/userFacingErrorText.ts` and `.test.ts`
- `orchestration/Layers/ProviderCommandReactor.ts` and `.test.ts`
- `orchestration/Layers/ProviderRuntimeIngestion.ts` and `.test.ts`

All paths are under `apps/server/src/`.

Tasks:

- 2.3: persist binding `error` plus `orphan_possible/host_lost` before dispatching session `interrupted`; clear the active turn and preserve unknown outcome/process evidence. Retain live-session, provider-identity and existing terminal-turn protections.
- X-7: introduce the typed unrecoverable condition; settle Stop without a failure activity; expire approval/input answers through the existing stale-request mechanism. Reuse central durable runtime-item closure for live interrupted-session updates and startup, with deterministic identities and the newer-item fence.
- Sanitise server-stored provider failure text while retaining full causes in logs. Preserve URLs, relative paths and model identifiers. Adapt illustrative snippets to the current Effect APIs.

Focused acceptance:

- Reconciler tests: dead running/starting bindings settle; live sessions do not; binding write precedes session settlement; repeat reconciliation is harmless.
- Provider service/reactor tests: typed missing-resume error, Stop settlement, stale approval/input handling and untouched idle-ready sessions.
- Runtime-ingestion tests: first-restart interruption closes old pending items as orphaned, does not close newer items and remains idempotent.
- Sanitiser tests plus existing `ProjectionPipeline.test.ts` stale-request coverage.

Do not edit provider adapters, process ownership, terminal cleanup or startup ordering.

## Acceptance boundary

For later execution, each lane needs chronological behavioural fail-first evidence, its focused checks, affected typechecks and required integrated Node 24 source gates, including `vp check` and `vp run typecheck`. None was run here.

Do not reopen the completed settings/workspace/terminal lanes. X-7’s shared `ProviderService` change is required by its existing card, not a new provider lane. Parallel OpenCode closure remains separate.

After authorised implementation, section 16.8 still governs scoped publication to `dev` and Sol/Opus review. No builds, main merge, release or deployment are implied. Section 14.2’s runtime and release proof remains pending, and no whole-Phase-1 completion claim is justified. P3 Harp ideas remain backlog.
