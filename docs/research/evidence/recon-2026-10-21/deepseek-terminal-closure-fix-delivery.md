Pushed commit `8d7c69c99` to `work/core-terminal-cleanup` (`3dc5eda07..8d7c69c99`). Four files changed, all within the assigned scope.

## What changed

`packages/shared/src/processGroup.ts`

- Anchors now carry the tty they were captured on.
- Discovery re-reads process-table membership after reading birth tokens and keeps an anchor only when pid, pgid and tty still agree. A token read after a pid was recycled onto another tty no longer authorises that group.
- Pre-signal confirmation requires the fresh row to match pid, pgid, tty and birth token. A tty mismatch revokes with `member_recycled`; missing membership evidence fails closed.

`apps/server/src/terminal/Manager.ts`

- Discovery receives the live table reader, so anchor capture has a fresh membership observation.
- On POSIX, the pid fallback revalidates the captured shell birth token immediately before TERM and again before KILL. Missing ownership, missing birth token, a changed shell pid, recycled pid, exited process, or unavailable reader all skip with an explicit diagnostic naming the phase.
- Windows keeps the existing node-pty console-bound kill path; no birth/tty evidence is required there.
- Normal owned group cleanup and server-shutdown cleanup remain on the same paths.

## Chronological evidence

Before the fix, with the new regression tests only:

`packages/shared/src/processGroup.test.ts`: 4 failed, 33 passed

- Recycled pid moved to another tty: old discovery returned groups `[9000, 7001]`, expected `[9000]`.
- Fresh membership unavailable: old discovery returned groups, expected `[]`.
- Matching anchor on another tty: old confirmation returned `confirmed`, expected `revoked/member_recycled`.
- One existing anchor-shape test failed because expectations already included the new tty field; this was an API-shape update, not a bug reproduction.

`apps/server/src/terminal/Manager.test.ts`: 7 failed, 58 passed

- No birth evidence: old code sent `["SIGTERM", "SIGKILL"]`, expected `[]`.
- Replacement between TERM and KILL: old code sent `["SIGTERM", "SIGKILL"]`, expected `["SIGTERM"]`.
- Replacement group adopted before anchors: old code sent `7001 SIGTERM`, expected none.
- Four existing normal-cleanup tests failed under their updated fixture setup because their fake ownership now reached the table read before their assertions. These were test-harness updates, not product-bug reproductions.

After the fix and after the commit hook:

- `packages/shared/src/processGroup.test.ts`: 37 passed.
- `apps/server/src/terminal/Manager.test.ts`: 65 passed.
- `packages/shared`: `tsgo --noEmit` exit 0.
- `apps/server`: `tsgo --noEmit` exit 0.
- Scoped `vp fmt` and `vp lint` on the four files: clean.

## Limitations

- No builds, installs, full suite, real app, browser or live process inspection. The Manager test file includes its existing isolated real-PTY fixtures for background-job cleanup, which ran as part of the 65 tests.
- Windows behaviour was preserved in source but not executed on this macOS host.
- Birth proof remains limited by the existing `ps lstart` identity evidence and the acknowledged bounded revalidation-to-signal race; no pidfd or framework was introduced.
- Docs, changelog and integration remain for the main owner, as requested.
