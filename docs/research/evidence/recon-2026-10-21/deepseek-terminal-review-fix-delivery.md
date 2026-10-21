Now I have the full picture. Let me implement the shared ownership/identity APIs first.Now let me capture fail-first evidence by running the new behavioural tests against the pre-fix source.Implemented and pushed the ownership-validation fix.

## What changed

**`packages/shared/src/processGroup.ts`**

- Added `TerminalOwnershipEvidence` and `captureTerminalOwnership`, capturing the pty shell's birth token and controlling tty at spawn.
- Added `readProcessTable`, `validateTerminalOwnership`, `discoverOwnedTtyProcessGroups`, and `confirmOwnedTtyProcessGroup`.
- Discovered tty groups now carry birth-token anchors per member. A group is only signalled while at least one anchor still exists with the same `pgid` and birth token.
- `terminateProcessGroup` accepts `confirmOwnership`, revalidated immediately before `SIGTERM` and again before `SIGKILL`. Revocation returns `ownership_revoked` and sends nothing further.
- Refactored the `ps` column reader so birth-token and tty reads share the same gone/unavailable semantics.

**`apps/server/src/terminal/Manager.ts`**

- Captures shell identity/tty after pty spawn, with a short bounded retry for the initial tty-visibility race.
- Stores evidence on the session and passes it into kill escalation.
- Validates shell identity and tty before discovery:
  - `recycled`, `tty_mismatch`, or `process_gone` → refuse all signals, including the pid fallback.
  - `unverifiable` or missing `ps` → keep the legacy single-pid fallback, never tty-group discovery.
  - confirmed → discover anchored groups, revalidating before TERM and KILL.
- Windows and missing-`ps` paths retain the existing safe fallback.

## Fail-first evidence

Against pre-fix source `e5b5eb4e3`, the new Manager behavioural tests failed:

- Shell PID reused before discovery: old code sent `SIGTERM`/`SIGKILL` to the replacement pid.
- Group replaced before TERM / before KILL / normal owned background cleanup: old code ignored the injected identity and fell back, timing out waiting for the expected anchored-group signal.

Log: `/tmp/neokod-core-symphony-2026-10-21/acp/lane-terminal-review-fix-failfirst*.log`

The new processGroup unit tests exercise new exports, so their fail-first evidence is the behavioural Manager layer; the shared API is covered by direct unit tests.

## Passing evidence

- `packages/shared`: 34/34 tests passed, including capture, shell reuse, tty mismatch, table/reader unavailability, anchors, and revocation before TERM/KILL.
- `apps/server` Manager: 62/62 tests passed, including the existing real disposable-PTY background cleanup tests.
- `tsgo --noEmit` clean for both `packages/shared` and `apps/server`.
- Scoped `vp fmt` and `vp lint` clean.
- `git diff --check` clean.
- Working tree clean after commit.

Logs: `/tmp/neokod-core-symphony-2026-10-21/acp/lane-terminal-review-fix-test-*.log`

## Commit

Remote: `3dc5eda07e2faf3f99a5bfd2a0d184778cbb6856` on `origin/work/core-terminal-cleanup`
Message: `fix(terminal): validate process ownership before signalling tty jobs [skip ci]`

Only the four owned paths were changed. No builds, root checks, installs, app launches, Playwright, or live Neokod/OpenCode workers were touched.

## Limitations

- A small TOCTOU window remains between the final ownership revalidation and the actual kill syscall; eliminating it would need pidfd support, which was not added.
- When the shell has already exited, signals are skipped. Background jobs left by a naturally exited shell are not newly cleaned up; this matches or is safer than the previous pid-only fallback.
- Group discovery intentionally does nothing when `ps`/tty evidence is unavailable, falling back to the pre-existing single-pid kill.
