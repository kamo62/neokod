I accept the reconciliation, with one correction to my own audit and two small clarifications. I only read files: I made no edits and ran no tools, providers, builds or signals.

**1. Parent Stop cascade: I accept the correction and withdraw my recommendation.**

- Row 5 of my audit (`opus-independent.md:62`) said stopping a parent, including a no-op Stop on an idle parent, should stop its active managed children. That conflicts with `plan.md:1395`. The plan says parent interrupt, archive and session stop leave children running and hold wakes. It also says only parent delete stops children (`plan.md:1396`).
- I have no contrary evidence. My recommendation came from upstream's V2 behaviour, which isn't a Neokod requirement. Making it one would be a new policy change.
- What stays as acceptance criteria:
  - `child_stop` and the UI Stop are idempotent, including when a stop is replayed.
  - A child is recorded as stopped only on engine evidence. If it isn't confirmed, it becomes `orphaned` with `mayStillBeRunning`, never "stopped".
  - Stopping a child that has no session yet ends it immediately.
  - My "no re-cascade from `child_stop`" point is moot, since nothing cascades except delete.
- At most, the upstream fix is a test idea for the existing parent-delete path in `ThreadDeletionReactor`: an unconfirmed child stop blocks cleanup and keeps the orphan evidence. That is not a new requirement.

**2. The other agreed points: I accept them as stated.**

- Shell snapshot read cost: the structural concern is real but unmeasured, so measure before changing anything. No V2 SQL or reader-worker port.
- V2 subagent filtering is a future input for W6-C3/C5, not a direct port, because it could hide native or unknown work.
- Two small backend performance changes, porting the intent only: the terminal control-string scan offset in `Manager.ts`, and skipping line buffering when Git output has no progress callback (`if (onLine)` in `GitVcsDriverCore.ts`). Checkpoint metering is observability, not a speed-up.
- No UI ports, and no full V2 or reader rewrite.
- The optimistic fallback on a malformed native Codex child `turn/completed` payload is confirmed in source. It is recorded, not changed.
- The Claude CLI surviving server death, and the effect of ingestion failures, both remain hypotheses that need a disposable fixture before any claim is made.

**3. Live Codex probe limits: I accept them, with two clarifications.**

- **What it proves:** run `live-202610232224341-4814c082` at `85a4acfe5` with zero blockers.
  - The real provider sent one structured request with two questions, `Amber` and a custom label were submitted, and turn 1 completed.
  - A second turn on the same thread completed without Resume.
  - The answers were still `answered`, with delivery `unknown`, after reloading the database. The separate push approval stayed pending.
  - This meets the 16.16 condition "Observe one real Codex continuation before shipping" and the original turn-completion gate.
- **What it doesn't prove:**
  - That the provider received or acknowledged the answers (`delivery: unknown`), or anything about the assistant's text, which wasn't kept.
  - That the model actually used the answers. "Continued after answer" only means the turn finished after submission.
  - Default behaviour of the installed CLI or app: a temporary wrapper turned on `default_mode_request_user_input`, which is off by default.
  - The normal Code provider path, the full scheduler/dispatcher, WebSocket, browser or installed UI, or anything visual.
  - Live stop, restart or ownership safety, or the full core exit (14.2/16.12).
  - Any W6 or OpenCode managed-child gate: this was Codex in Symphony's AgentRuntime, not an app-managed child.
- **Clarification 1:** the S1–S6 row in 16.16 isn't fully closed. A custom answer with no options surviving reload is still only contract/unit evidence, because both questions had options (`customQuestionNoOptions: false`). Stale, duplicate and lost-acknowledgement races weren't exercised live either. The probe releases the single continuation hold, not the whole S1–S6 row.
- **Clarification 2:** releasing the PR152 hold still needs the coordinator to accept this test setup as valid evidence (it ran the app's source code directly, not the installed app), and the current remote checks need reviewing. It isn't permission to merge.
