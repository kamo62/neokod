Two actionable terminal closure gaps at `cc477c2371e541d22e1fe13fbe04856c40881a64`. Reviewer identity confirmed from session metadata: `gpt-6.1-sol`, effort `high`.

1. P1: Discovery can adopt a replacement process’s birth identity. [processGroup.ts:761](/Users/kamogelo/.codex/worktrees/core-symphony/t3code/packages/shared/src/processGroup.ts:761), [processGroup.ts:795](/Users/kamogelo/.codex/worktrees/core-symphony/t3code/packages/shared/src/processGroup.ts:795)  
   If a job exits and its PID/PGID are reused after the initial process-table snapshot but before anchor capture, discovery records the replacement’s birth token. The fresh pre-signal check accepts its matching PID, PGID and birth token without checking the captured TTY. An unrelated group on another TTY therefore passes validation and receives TERM or KILL. Bind anchor identity to terminal membership and reject fresh TTY mismatches. Existing tests replace identities after anchor capture, so they miss this sequence.

2. P1: Unknown ownership still authorises unchecked PID escalation. [Manager.ts:1409](/Users/kamogelo/.codex/worktrees/core-symphony/t3code/apps/server/src/terminal/Manager.ts:1409), [Manager.ts:1523](/Users/kamogelo/.codex/worktrees/core-symphony/t3code/apps/server/src/terminal/Manager.ts:1523)  
   Missing birth evidence or unavailable process-table evidence selects the legacy fallback. On Node, `NodePtyProcess.kill()` delegates to pinned `node-pty` 1.1.0, which calls numeric `process.kill(this.pid, signal)`. If TERM exits the shell and its PID is reused during the default one-second grace period, the unconditional KILL can terminate the replacement. `stopProcess` has already removed exit listeners. Retaining this fallback does not establish safe ownership; it needs process-bound signalling or identity validation before each signal. This is a retained closure gap, not a newly introduced escalation body.

Closure status:

- Claude cross-session per-window retention: closed at source level.
- Claude unknown-reset evidence alongside known expiry: closed at source level.
- Terminal shell reuse before discovery: guarded when captured birth evidence is verifiable.
- Terminal reuse after anchor capture, before TERM/KILL: guarded.
- Normal anchored cleanup: preserved in source and covered by inspected tests.
- Terminal ownership overall: partially closed because of the two findings above. Naturally exited shells intentionally skip signals.

These findings are separate from the acknowledged bounded OS revalidation-to-signal race; no pidfd was added.

Reviewed only the requested deltas, relevant callers, root wiring and test source. No tests, builds, installs, launches, edits, other agents or external messages. No app/live-provider proof. The supplied fail-first sequence was collected after implementation by restoring old source; it does not establish chronological initial fail-first.
