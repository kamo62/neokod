ACCEPT at `41a49b825`.

The [revised regression](/Users/kamogelo/.codex/worktrees/neokod-feedback/t3code/apps/server/src/symphony/Runner/ApprovalService.test.ts:1135) deterministically holds `recordRequest` after real persistence completes. It confirms a pending row and live registration, then closes the scope while publication remains blocked.

The caller’s release finaliser removes the registration and marks the row `interrupted`. Against `7574eb450`, publication interruption only withdrew the live entry, leaving the durable row pending, so this assertion catches the old bug.

Recorded verification shows 26 tests passing, server typecheck exit 0 and changed-file `vp check` passing. I ran only read-only checks; checkout is clean and diff whitespace checks pass. Previously accepted source remains unchanged. Live proof remains separate.
