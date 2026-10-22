I found no P0, P1 or P2 problems in `7d6f33890..a16c41050`. Sol's earlier P2 (a manual retry of a failed entry minted new IDs) is closed.

**Pin:** the worktree `HEAD` points to `refs/heads/work/core-composer-recovery`, and that ref read `a16c410505472ae061d0ba9e685c6d34d5fd88b8` at the start and the end.

**Source-only limits:**

- This session had no shell, so I could not run `git diff`, `git status` or `git show`. I reviewed the files as they stand at the pinned head. The earlier answers' description of `7d6f33890` was my baseline, not a byte-level diff.
- Not checking `git status` means a clean worktree is assumed, not proven.
- Nothing was executed. No tests, builds, browser, app or provider calls, child agents, edits, commits or messages.

## Requirement checks

1. **Stable identity for the life of the entry, including a restored failed record or a lost first claim.**
   - `resolveQueuedDispatchAttempt` (`ChatView.logic.ts:470-497`) reuses any recorded identity for every state, `failed` included. With no record it derives `queued-message:<id>` / `queued-command:<id>` from the entry's immutable `randomUUID()` id (`composerDraftStore.ts:3524`).
   - The store is authoritative. `claimQueuedMessageDispatch` (`composerDraftStore.ts:3592-3604`) keeps `entry.dispatch` IDs whenever a record exists and ignores the caller's IDs.
   - A failed claim write falls back to the claimed identity (`3652-3660`).
   - Hydration keeps the IDs and only maps `in_flight` to `unconfirmed` (`2337-2345`). Persistence copies `dispatch` intact (`2085`).
   - No path resets `dispatch` to null or copies entries to another key. The only writes to `queuedMessages` are add, remove, claim and the two mark functions.

2. **No unknown outcome is turned back into an ordinary draft.**
   - `shouldRestoreComposerDraftAfterFailure` returns `!queuedDispatch` (`ChatView.logic.ts:396-400`). Both the normal branch (`ChatView.tsx:4487-4508`) and the plan branch (`4164-4171`) use it.
   - `decideQueuedDispatchSettlement` (`ChatView.logic.ts:377-388`) maps a local failure with no earlier `failed` record to `unconfirmed`, not `failed`.

3. **A lost claim is acknowledged through its deterministic ID.**
   - `selectAcknowledgedQueuedMessageIds` (`ChatView.logic.ts:557-569`) falls back to the derived message ID when an entry has no record.
   - The effect compares against `activeThread.messages` (`ChatView.tsx:4672-4682`). That list holds server or local-draft messages only. Optimistic rows live in separate state (`1184`, `1332`), so an in-flight optimistic row cannot release its own entry early.
   - When the acknowledgement effect and the drain effect fire in the same commit, the drain's claim reads the store through `get()`. It finds the entry gone and returns `not_claimed` without showing an error.
   - Without history, the replay reuses the same command ID, and the receipt lookup (`OrchestrationEngine.ts:140-161`) returns the original accepted result.

4. **Plan follow-up identity is stable.** `onSubmitPlanFollowUp` passes the claimed IDs through `resolveSendIdentity` (`ChatView.tsx:4946-4951`) and sends the claimed `commandId` and `messageCreatedAt` (`5013-5015`, `5034`).

5. **A newer draft is not lost.**
   - Queued sends use `promptOverride` (`4120`).
   - The plan, slash-command and normal branches all skip clearing the composer for queued sends (`4151`, `4184`, `4337`).
   - Queued failures never restore into the composer, so there is no restore path that could overwrite a newer draft.

6. **No automatic loop.**
   - Automatic drain requires `dispatchState === "none"` (`ChatView.logic.ts:323`).
   - `dispatchQueuedMessage` refuses any existing record unless `allowRetry` is set (`ChatView.tsx:4546`). Only the manual `retryQueuedMessage` sets it (`4657-4667`).
   - The route guard after the claim settles through prior-aware logic (`4611-4616`). It cannot produce a state that auto-drains.

7. **Ordinary direct-send restoration is unchanged.**
   - A direct send still clears the composer before sending, restores on every failure and drops the optimistic row only after a restore (`4337-4341`, `4490-4508`).
   - A direct plan follow-up still restores on any outcome except accepted (`4164-4171`). This matches the U-07 card.
   - U-06's keep-until-accepted rule holds. The current design deliberately goes further than the card by never handing a queued entry back to the composer.

## Below P2, not findings

- **A first-attempt local failure now shows as "unconfirmed".** This covers `EnvironmentRpcUnavailableError`, a settings-stage failure and the post-claim route guard. These attempts are known not to have reached the server. It is fail-closed and still retryable under the same identity, so it is only a wording issue.
- **A queued standalone slash command returns `not_attempted` on every attempt.** Each try re-applies the mode change and leaves the entry `unconfirmed` until the user removes it. It depends on the queue path accepting slash-only text, which predates this commit.
- **A replay after a lost claim re-sends the turn-settings command first.** That command runs before the receipt-deduplicated turn start, so it can rewrite the thread's model or mode settings to the replay-time selection. This existed in `7d6f33890` and is not changed here.
- **Known limits the lane already disclosed:** a lost first claim has no recorded first-attempt timestamp, legacy random-ID records from older builds cannot be reconstructed, and a definite server rejection still shows as unknown.
