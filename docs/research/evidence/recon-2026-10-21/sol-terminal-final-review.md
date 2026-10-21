No actionable findings remain in the two requested P1 closures at `8d7c69c994d9be5dc9642d8bd66c321c35a135d3`, reviewed against `3dc5eda07`. Current `turn_context` confirms actual `gpt-6.1-sol`, effort `high`.

- Replacement adopted during discovery: closed. Discovery re-reads membership after capturing birth tokens, rejects PID/PGID/TTY mismatches, and fails closed when membership is unavailable. Pre-signal confirmation checks TTY and birth identity before TERM and KILL. Manager supplies the live reader. See [processGroup.ts:784](/Users/kamogelo/.codex/worktrees/core-symphony/t3code/packages/shared/src/processGroup.ts:784) and [Manager.ts:1429](/Users/kamogelo/.codex/worktrees/core-symphony/t3code/apps/server/src/terminal/Manager.ts:1429).
- Unchecked POSIX PID fallback: closed. Captured shell PID and birth evidence must match immediately before TERM and again before KILL. Missing, unavailable, recycled or exited identity skips signalling. See [Manager.ts:1494](/Users/kamogelo/.codex/worktrees/core-symphony/t3code/apps/server/src/terminal/Manager.ts:1494) and [Manager.ts:1613](/Users/kamogelo/.codex/worktrees/core-symphony/t3code/apps/server/src/terminal/Manager.ts:1613).

Traced spawn capture, close/restart, shutdown finalisation, shared escalation, Node and Bun adapters, and pinned `node-pty` 1.1.0’s Windows implementation. Normal owned cleanup remains covered in source; naturally exited shells intentionally skip signals. Windows is unchanged and is not certified by this POSIX closure verdict.

Regression source covers both sequences. The supplied before-fix record honestly reports shared tests **4 failed / 33 passed**, including one anchor-shape expectation failure, and Manager **7 failed / 58 passed**, including four fixture/timing failures. Those five failures are not bug reproductions. Supplied subsequent results show **37 shared and 65 Manager tests passing**; I did not execute them.

The OS revalidation-to-signal race and macOS second-resolution birth-token limits remain acknowledged limits, not newly identified defects. No pidfd guarantee is claimed.

Static review only. No builds, tests, installs, app/process probes, edits, commits, delegation or external messages. OpenCode excluded.
