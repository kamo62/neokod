# Verdict on `8ae70da51`: FIX

It needs two narrow corrections inside the same six-file lane. Everything else is source-acceptable, subject to your matching-source network proof.

I read the `README.md`, `AGENTS.md` and `state-and-evidence.md` rules, plan §16.19, the full commit diff, all six changed files, the Opus design report's section C and `native-correction-answer.md`. I also traced the actual callers: the Codex client dispatcher, the runtime's raw and typed handlers, the adapter, ingestion, the engine's command receipts, and the web card derivation and panel. I made no edits, ran no tests, builds, installs, browser actions or signals, and changed nothing in git. The target tree is clean at `HEAD 8ae70da51`, with merge base `1eee19299`.

**Model:** this session reports itself as `claude-opus-5-5`, running as a direct Claude Code session on the first-party Anthropic provider. I can't see a `modelUsage` receipt from inside the session, so treat this as self-reported. No fallback was used.

## Required fixes

**F1. Lineage is recorded only for `kind: "started"`.** This is in `CodexSessionRuntime.ts:626`.

- The older collab path records `receiverThreadIds` for every tool, including `sendInput`, `wait` and `resumeAgent`. The new shape records the child only on `started`.
- The child map is held in memory per runtime and lost on restart. After a server restart or session resume, a parent that sends `interacted` to an existing child leaves that child unregistered. The child's items, deltas and `turn/completed` then reach the adapter without `childThreadId`.
  - The child's turn completion then hits the parent `turn/completed` mapping at `CodexAdapter.ts:1036`, which doesn't check the thread id. It emits a parent `turn.completed`, so parent isolation is lost.
- Within one session, a later interaction leaves the child mapped to the stale parent turn id.
- **Correction:**
  - Record `agentThreadId` for any `subAgentActivity` kind, so the most recent observation wins, matching the collab behaviour.
  - Keep card creation limited to `kind === "started"` in the adapter. That rule is already correct (`CodexAdapter.ts:610`).
  - Change the test at `CodexSessionRuntime.test.ts:134` to assert that `interacted` and `interrupted` record lineage but create no card. Keep the "undefined parent turn records nothing" half.

**F2. Parent isolation is proven only by helper tests.** You asked for retained isolation, not just helper coverage.

- The runtime tests call the exported pure helpers.
- The adapter tests feed a fake runtime with `childThreadId` already set.
- So the real wiring is never exercised end to end:
  - in `handleRawNotification` (`:858-918`): the tagging, the remap to the parent turn id and the suppression;
  - in the typed `turn/completed` handler (`:948-974`): the session status update.
- This is feasible within the lane: `makeFakeCodexPeer` (`apps/server/src/symphony/Runner/testkit/FakeCodexPeer.ts:104`) plugs in at the `ChildProcessSpawner` seam. It already answers `initialize`, `thread/start` and `turn/start`, and its `sendNotification` sends raw messages.
- **Correction:** add one test to `CodexSessionRuntime.test.ts` that drives `makeCodexSessionRuntime` through this sequence:
  1. `start` and `sendTurn`.
  2. The parent sends `item/started` for a `subAgentActivity` (started).
  3. The child sends `item/completed` with an `agentMessage`. The event should carry `childThreadId` and the parent turn id.
  4. The child sends `turn/started`. It should be suppressed.
  5. The child sends `turn/completed`. The event is forwarded with `childThreadId`, and `getSession` should still show `running` with the same `activeTurnId`.
  6. The parent sends `turn/completed`. The session becomes `ready`.
  7. After F1, add one more case: an `interacted` child with no prior `started` should also route as a child.

## Acceptable as written

- **Typed decoding on start and completion:** both `item/started` and `item/completed` decode through the generated `V2ItemStarted/CompletedNotification` unions (`CodexAdapter.ts:1103-1130`). `subAgentActivity` returns before the generic lifecycle, so no parent `item.started` or `item.completed` leaks. The `rawItemFromPayload` probing is gone. The generated schema (`agentPath`, `agentThreadId`, `id`, `kind`, `type`) matches the fixtures.
- **Idempotence:**
  - The stable ID is `codex:subagent-started:<agentThreadId>` (`:509`). It becomes the command ID `provider:<eventId>:thread-activity-append` (ingestion `:871`, `:2284`), and the engine's receipt check (`OrchestrationEngine.ts:148-165`) returns the existing sequence for a repeat. On the web side, `deriveSubagentCards` also skips a second `task.started` with the same `taskId`.
  - A collab spawn of the same child now shares the ID, which removes an old duplicate source.
  - The ID is not scoped to the NeoKod thread. A cross-thread reuse would fail with `CommandIdReused`, which is logged and caught. But the only resume source is the same thread's own session (`ProviderCommandReactor.ts:734`), and nothing forks a provider thread, so I don't count this as a defect.
- **Parent thread identity and the early child terminal:**
  - `shouldApplyParentTurnCompletion` (`:688-695`) now requires a known parent id that matches exactly.
  - The parent id is set in `start()` (`:1264`) or seeded from the resume cursor, and is never cleared. A real parent completion therefore can't arrive while the id is unknown, so the stricter check introduces no regression.
  - The typed handlers run before the raw queue in arrival order, and the client keeps every registered handler. The early-ordering case is therefore protected by the parent-id check even if the child isn't registered yet.
- **Malformed child completion:** the client drops undecodable notifications before any handler runs (`client.ts:152-158`). The adapter's `childTurnCompletedStatus` also returns nothing for a malformed or `inProgress` completion (`:843`). Either way, no fabricated `completed`.
- **No Stop cascade:** `interrupted` produces no event. Only the child's own completion or abort closes the card.
- **Old collab compatibility** is preserved apart from the stable ID.
- **Cards:** `SubagentsPanel.logic.ts:111` now hides a card only on explicit dismissal. Cards only ever come from `task.started` (`session-logic.ts:790`). The only caller is `SubagentsPanel.tsx:107`. The removed predicates have no other callers.

## Residuals (record them; no fix needed now)

- **Ordering:** if real Codex 0.163 sends child notifications before the parent's `subAgentActivity` start, they still go to the parent timeline, through the thread-blind `CodexAdapter.ts:1036`. This was already true before this commit. Only matching-source network proof can confirm the ordering.
- **Multi-turn children:** a child's first `turn/completed` now marks its card terminal. If the child runs a later turn, the card isn't reopened. That is outside this lane; don't broaden it here.
- **Docs:** `FORK.md` still describes the old empty-card auto-hide; you've said root will update it. The test results claimed in the receipt are fixture-level only, not live proof.

**Acceptance condition:** apply F1 and F2, re-run the same focused server and web tests plus check and noEmit, and get root's matching-source network proof of the real child notification order. With those, this becomes ACCEPT.

There was no Write tool in this session, so I couldn't create the plan file. The full review is in this message.
