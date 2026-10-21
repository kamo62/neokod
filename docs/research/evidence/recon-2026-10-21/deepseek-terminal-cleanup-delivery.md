# DeepSeek ACP lane: terminal-cleanup

Worker report retained verbatim. Central integration/review status is recorded in plan.md section 16.8.

I'll start by reading the required context: README, AGENTS, the card, architecture doc, and canonical plan.Now I'll add the behavioural regression test first (real PTY, existing API only) so it can run against base.Baseline recorded: the real-PTY test times out after 8 s because the three background jobs survive close. No leftover `sleep` processes. Now implement the shared helpers.X-14 implemented in a single commit and pushed. No work outside the four owned files.

## Changed files

- `packages/shared/src/processGroup.ts` — added `parsePsPidPgidTty`, `selectControllingTtyProcessGroups`, `listControllingTtyProcessGroups`. The lister reads a live `ps -A -o pid=,pgid=,tty=` snapshot, returns only groups sharing the pty child's controlling tty, excludes the server's own group, and returns `[]` (fallback preserved) on win32, invalid root, or `ps` failure.
- `packages/shared/src/processGroup.test.ts` — parser, group-selection, own-group exclusion, fail-closed (absent root, `??`, `-`), win32 no-op.
- `apps/server/src/terminal/Manager.ts` — `processGroupLister` / `processGroupSignaller` seams; `runKillEscalation` now terminates every group from the pty-tty snapshot through `makeProvenGroupIdentity` + `terminateProcessGroup`, logging survivors. Empty list keeps the original single-pid SIGTERM/grace/SIGKILL path (Windows and missing-`ps`).
- `apps/server/src/terminal/Manager.test.ts` — fake lister/signaller tests (per-group SIGTERM, per-group SIGKILL escalation, no single-pid kill) and two real-PTY tests (close, scope shutdown) spawning only their own disposable `/bin/bash` PTY jobs.

## Behavioural evidence

- Baseline on `f2ad1498d` with only the real-PTY close regression added: **failed** with `WaitForConditionError` on the 8 s post-close poll (`sleep 300/301/302` still alive). Log: `.../acp/lane-terminal-cleanup-baseline-fail.log`.
- After implementation:
  - `packages/shared/src/processGroup.test.ts`: **21 passed**.
  - `apps/server/src/terminal/Manager.test.ts`: **60 passed**, including both real-PTY close/scope tests.
  - `pgrep -fl "sleep 30[0123]"` after runs: nothing.

## Checks run

- `packages/shared`: `vp test run src/processGroup.test.ts`; `tsgo --noEmit` clean.
- `apps/server`: `vp test run src/terminal/Manager.test.ts`; `tsgo --noEmit` exit 0 (only pre-existing Effect suggestions in unrelated files, none in terminal paths).
- Scoped `vp fmt --check`, scoped `vp lint`, `git diff --check`: all clean.
- No build, packaging, Docker, Playwright, runtime launch, or full suite.

## Commit and remote

- Commit `e5b5eb4e3e1484deaed463c29e5bf040c21896ba`, message `fix(terminal): terminate background jobs sharing the pty tty when a terminal closes [skip ci]`.
- Branch `work/core-terminal-cleanup`, pushed with upstream (no force); `git ls-remote origin refs/heads/work/core-terminal-cleanup` returns that exact SHA. Working tree clean.

## Limitations / remaining

- Real-PTY proof is macOS/Darwin with `/bin/bash`; Linux procps, Windows, and missing-`ps` fallback are covered by unit logic only and were not executed here.
- No central `vp check` / root `typecheck`, dev/main merge, PR, CI dispatch, or Sol 6.1 / Opus review was performed; those remain main’s integration and review gates.
