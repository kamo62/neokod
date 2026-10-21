Implemented and pushed the two correction commits on `work/core-composer-recovery`.

## Commits

- `e9b635d33` `fix(web): keep queued sends owned across remounts and blocker clears [skip ci]`
- `670c9cfa7` `fix(web): restore rejected plan drafts into their original target [skip ci]`

Pushed to `neokod/work/core-composer-recovery` (`8eed3c91f..670c9cfa7`). Pre-commit hooks ran formatting successfully.

## Design

**Queue ownership and duplicate prevention**

- Added a durable per-entry dispatch claim in `composerDraftStore`: stable `messageId`, stable `commandId`, `attemptedAt`, and `state: "in_flight" | "unconfirmed"`.
- The claim is written atomically before `onSend`; a remount reads it from the store, so the queue entry cannot be dispatched twice while the first send is awaiting acknowledgement.
- Hydration converts `in_flight` to `unconfirmed` because the confirming promise cannot survive a reload. Unconfirmed entries never auto-replay.
- Retry reuses the same `messageId` and `commandId`. The server already deduplicates `thread.turn.start` by command id through its durable command-receipt table, so an explicit retry cannot create a second user message even if the first send was accepted but unacknowledged.
- When the stable message id appears in thread history, the entry is removed as an authoritative acknowledgement. Absence of a message is never treated as rejection.
- Failed restores and queue ownership decisions read the original target’s durable draft, not current visible refs.

**Reactive drain**

- The drain effect now depends on `activeThread`, `isSendBusy`, `isConnecting`, `activeEnvironmentUnavailable`, and pending user input, so clearing a blocker retries a retained unclaimed entry.
- Claimed entries are excluded from auto-drain. Manual retry is the only replay path for unconfirmed entries.

**Pending controls**

- In-flight entries show only a pending state; Remove and Steer are not rendered.
- Unconfirmed entries expose an explicit `Send again` (stable identity) and a remove action. No control implies an in-flight send can still be cancelled.

**Target-aware draft restore**

- Added `restoreComposerContent` to the store: writes to the original target only when that target’s durable draft is empty, preserving queued messages and settings.
- Shared refs and cursor are updated only when the original target is still the current route, using `composerTargetKey` rather than object identity.
- Ordinary send failures and rejected plan follow-ups now use this path. Plan restoration survives A→B and A→B→A, never overwrites a newer A draft, and no longer contaminates B’s refs.

No server, contracts, client-runtime, dependency, infrastructure, or doc changes.

## Verification

- `pnpm exec vp test run src/components/ChatView.logic.test.ts src/composerDraftStore.test.ts` — 122 passed.
- `pnpm exec tsgo --noEmit` from `apps/web` — passed.
- `pnpm exec vp fmt --check` on the six changed files — passed.
- `pnpm exec vp lint` on the six changed files — only one pre-existing warning remains: unused `TurnId` import in `ChatComposer.tsx` (present in HEAD before these changes).
- `git diff --check` — clean.
- Initial `tsgo` run caught a `MessageId` branding error during development; fixed before commit. No failing tests remain.

Behavioural regressions now covered:

- claim survives a consumer remount and rejects a second claim;
- persisted `in_flight` hydrates as `unconfirmed` and cannot auto-dispatch;
- accepted entries are selected for release only by stable message id;
- blocker-clear eligibility for an unclaimed entry;
- same-scope identity round-trip across recreated refs;
- restore writes only to empty target A while B and newer A stay untouched;
- claimed entries are partitioned out of the control-bearing queue list.

## Remaining proof

There is no `ChatView` render/browser harness in this repository, so the full remount, reload, blocker-clear effect, real command acknowledgement, and A→B→A plan flows are covered by store/logic tests plus source reasoning, not rendered runtime evidence. I did not run the app, providers, browser, builds, or root gates. No 2.2 work started and no Phase 1 completion is claimed.
