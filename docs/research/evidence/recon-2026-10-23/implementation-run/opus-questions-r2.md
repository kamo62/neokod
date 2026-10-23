**Verdict: accepted.** I found no P0, P1 or P2 defects introduced by this change.

- **Reviewed:** `bdf22d5338c628d8557c28edf494dcce3a545c9a` on `feat/neokod-questions`. The worktree was clean at session start and I made no edits. If the code changes, this SHA needs rechecking.
- **What this is based on:** reading the source only, with Read/Glob/Grep. I did not run tests, typecheck, a browser or a live Codex session. Nothing here proves that Codex actually continues after a free-text answer; the plan's live-continuation acceptance item is still open.
- **Scope:** every changed file is in the S6 allowlist (plan.md:1961). The diff touches no Symphony, contract or migration files, and doesn't use autonomous Symphony in place of ordinary Code threads.

## Production paths I traced

1. **Codex request to the adapter.** `CodexSessionRuntime.ts:1084-1110` registers a pending entry per request ID and emits the raw request. The adapter (`CodexAdapter.ts:675-707`) then does one of two things:
   - If any question is secret, it emits a `runtime.warning`.
   - Otherwise it emits `user-input.requested` with the normalised questions. `toUserInputQuestions` (`CodexAdapter.ts:338-377`) now keeps questions with no options (omitted, null or empty) and fills a missing option description from its label. `trimText` (`:148`) returns `undefined` for blank text, so that fallback works.
2. **Contract.** `UserInputQuestion.options` is `Schema.Array` (`packages/contracts/src/providerRuntime.ts:566`), so an empty options list is valid.
3. **Ingestion.** Questions are passed through unchanged (`ProviderRuntimeIngestion.ts:634-650`). The server's pending count (`ProjectionPipeline.ts:164`) counts each request regardless of question shape. The web parser now keeps free-text questions too, so the server count and the visible prompt agree more often than before. A secret request creates no `user-input.requested`, so it never appears as an answerable prompt.
4. **Web parser.** `session-logic.ts:474-528` keeps questions whose options are missing or null, but still rejects non-array options. Each question keeps its own ID.
5. **Answering.** For a no-options question, the answer can only come from the typed custom answer (`pendingUserInput.ts:48-63`, `:105-120`). Advancing is blocked until something is typed, and per-question answer maps are kept (`ChatView.tsx:4849-4900`). The number-key shortcuts do nothing when there are no options (`ComposerPendingUserInputPanel.tsx:139`). On the server, a string answer becomes `{answers:[text]}` (`CodexSessionRuntime.ts:661-675`).
6. **Other providers.** The Cursor, xAI and Copilot extensions already supply fallback options. No downstream web consumer (notifications, lifecycle, sidebar, run summary) relies on options being non-empty.
7. **Secret rejection.** This is needed, not an extra. Once free-text questions are allowed, a free-text secret would otherwise reach the normal composer and be stored in plain text in the `user-input.resolved` answers. Rejecting the whole request avoids a partial answer map.

## Non-blocking findings (P3)

1. **The warning tells users to do something they can't.**
   - **Where:** `CodexAdapter.ts:690`.
   - **Trigger:** any `isSecret` question.
   - **Problem:** "answer directly through Codex" isn't possible. The Codex app-server is a private child process; only Neokod's runtime holds that request, and nothing else is attached to answer it.
   - **Impact:** users may look for a way that doesn't exist. Stopping the turn is the only real option.
   - **Fix:** change the copy to something like "…does not support. Stop the turn to continue." and update the matching `/Interrupt the turn/` assertion in the test. I recommend doing this before merge, for honest delivery.

2. **After a secret rejection the turn stays blocked until the user stops it.**
   - **Where:** the pending entry from `CodexSessionRuntime.ts:1091` is never resolved or declined. The thread shows as running, with only an info-level warning row.
   - **Is it new?** Free-text secrets already hung like this before, silently. Secret questions that had options used to be answerable in plain text; they now hang instead. That trade-off is deliberate and acceptable.
   - **Follow-up:** have the runtime reply with a JSON-RPC error or decline. That's in `CodexSessionRuntime.ts`, which is outside this lane's allowlist, so it should go through the coordinator.

3. **Conflicting hint text.**
   - **Where:** `ChatComposer.tsx:2663` and `:2391`.
   - **Problem:** for a no-options question, the composer placeholder still says "leave this blank to use the selected option", which contradicts the panel's "Type your answer below." Submitting blank is still correctly blocked.
   - **Fix:** choose the placeholder based on `activeQuestion.options.length === 0`. That file is also outside the allowlist.

4. **Bad option data now becomes free text.**
   - **Where:** both normalisers.
   - **What happens:** if a question's options array contains only invalid entries, the question becomes free-text instead of being dropped. This is documented and safe, because custom answers are always accepted, but it is a behaviour change.

5. **Gaps that were already there, not made worse.**
   - A question with a blank ID, header or prompt is still dropped one question at a time, which can leave a partial answer map.
   - Pending entries after an interrupt are only cleared when the session closes.
