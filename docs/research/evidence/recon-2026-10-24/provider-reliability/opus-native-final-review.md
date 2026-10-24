# Verdict: ACCEPT for source at `eef750bfbf86c9d6c1943211678f8f7a1a91386e`

That's `eef750bfb fix(codex): retain resumed child lineage and verify runtime isolation` on `feat/neokod-native-observation`. Its parent is `8ae70da51` and its merge base is `1eee19299`. The worktree is clean. The full lane against `1eee` is still exactly the six files. The correction commit itself changes three of them: `CodexSessionRuntime.ts`, its test, and `CodexAdapter.test.ts`.

**Scope:** I read the full diff from `8ae70da5`, the prior review, all three sections of `native-final-correction-answer.md`, the README, AGENTS and state-and-evidence files, and the actual runtime, client and adapter wiring. I didn't rerun tests or the check/typecheck commands; your reported results (61 server, 21 web) are taken as given.

**Model:** this session reports itself as `claude-opus-5-5`, running directly. I can't see a receipt for the model or the "high" effort setting from inside the session, so treat both as self-reported.

## F1: resolved

- **Runtime:** `rememberChildThreadTurns` now records `agentThreadId` for every `subAgentActivity` kind and for both `item/started` and `item/completed` (`CodexSessionRuntime.ts:626`). The latest observation overwrites the entry, and an undefined parent turn still returns early (`:606`).
- **No card from other kinds:** card creation is still limited to `kind === "started"` (`CodexAdapter.ts:610`). Both item handlers send every `subAgentActivity` there before the generic lifecycle (`:1110`, `:1128`), so `interacted` and `interrupted` create no card and nothing leaks to the parent timeline.
- **Tests:** the runtime unit test checks started → interacted → interrupted with the latest turn winning, plus the "no parent turn" case. The adapter test uses a parent sentinel to prove neither non-`started` kind produces an event.

## F2: resolved, and it tests the real wiring

The new `it.live` test drives the real `makeCodexSessionRuntime` and the real Codex client through `makeFakeCodexPeer`'s `ChildProcessSpawner` seam (`FakeCodexPeer.ts:224`). It covers all seven requested steps. Its assertions are sound:

- **Session checks are deterministic.** For each notification the client runs handlers in registration order (`client.ts:156`). The typed `turn/completed` handler (`:948`) is registered before the raw-queue forwarders (`:1161–1174`). So by the time the test takes the child's raw `turn/completed`, the typed handler has already run, and the `running` / same-`activeTurnId` check really observes it.
- **Lineage is set before the event is seen.** The raw handler saves the lineage map (`:900`) before emitting (`:901`). So when the test takes the start event, child registration is already done.
- **Suppression is proven by order.** The child's `turn/started` is sent just before its `turn/completed`, and the next event must be `turn/completed`.
- **The `interacted`-only child would fail on the old code.** `child-thread-b` is only ever announced as `interacted`, and its item is still tagged `childThreadId: "child-thread-b"`.
- **The parent settles only on its own completion**, ending `ready` with no active turn.

## Residuals to record (none block acceptance)

1. **No guard against registering the parent as a child.** Nothing stops an `agentThreadId` that equals the parent's own provider thread from being recorded. If it happened, the parent would never settle. F1 widens this exposure from `started` only to all kinds, matching the long-standing collab `receiverThreadIds` path.
   - Upstream T3's four recorded Codex transcripts (`subagent_v2*`, including nested) only ever target descendants. There was no case of the root or the emitting thread.
   - Optional follow-up: a one-line skip when `agentThreadId` equals the parent provider thread id.
2. **Some `subAgentActivity` kinds are dropped at decode.** Those upstream transcripts also emit `kind: "completed"`, which isn't in the generated literals (`schema.gen.ts:2619`). The client drops any notification that fails to decode (`client.ts:157`), so these are silently invisible. That's harmless here: no lineage comes from them, nothing leaks, and the card closes on the child's `turn/completed`.
3. **The test's `interacted` uses `item/started`.** Real Codex may send `interacted` only as `item/completed`. Both methods are handled, and the adapter test covers `item/completed`.
4. **Still open, as you said:** the real provider's ordering (whether child notifications can arrive before the parent's `subAgentActivity` start) needs root's matching-source browser test. Multi-turn child cards and the `FORK.md` update also remain open.

I made no edits, builds, installs, commits or signals in the repo. Two things to note:

- To analyse the upstream transcripts I wrote one throwaway helper script outside the repo, at `/tmp/claude-review-scripts/sa.py`. You can delete it.
- No Write tool was available in this session, so there's no plan file. The full review is in this message.
