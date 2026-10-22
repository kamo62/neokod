RUNTIME half of O1 P2 is done and pushed.

## Actual SHA

`d89fad2f72bf09995e60754f5e780a1b3ae881ce` on `work/core-opencode-cleanup` (remote matches; normal push, no force).

## Change

- `apps/server/src/provider/opencodeRuntime.ts`: `assertSupportedOpenCodeVersion` now wraps `runOpenCodeCommand --version` in `Effect.timeoutOption(OPENCODE_VERSION_PROBE_TIMEOUT)` (shared 5s constant). Timeout (`Option.none`) logs debug and returns, preserving the documented unknown fallback. Command failure and unparseable output behave as before. A known unsupported major still fails before `serve`/connect. Cleanup, ledger, adapter, driver, maintenance, shared and docs paths untouched.
- `apps/server/src/provider/opencodeRuntime.test.ts`: added a fake `--version` handle that never emits output and never exits, plus a `TestClock` regression. It asserts startup is still waiting at 4999 ms, then at 5000 ms the normal supported server spawn occurs and the server reaches `SERVER_URL`.

## Chronology

1. Read README, AGENTS, `state-and-evidence.md`, Effect LLMS and the Sol guard review; confirmed `OPENCODE_VERSION_PROBE_TIMEOUT` already exists in `openCodeVersion.ts`.
2. Implemented the bound and unknown fallback.
3. Added the hanging-command regression.
4. Reverted only the runtime change and ran the new test against HEAD: it failed at the post-bound serve-spawn assertion (836 ms). The earlier version of the test hung past a 120 s command timeout, so both failure modes were observed.
5. Restored the fix; the new test passes (10 ms).
6. Scoped checks, commit with hooks, push.

## Checks

- `vp test run src/provider/opencodeRuntime.test.ts`: new test passes; known-2 and supported-1.x tests pass; 23/24 pass overall.
- One failure remains: `startOpenCodeServerProcess spawner ownership > does not let the spawner scope finalizer signal a group the guard refused`. Reproduced identically with the runtime file stashed to HEAD, so it is pre-existing in this worktree, not caused by this change.
- `vp run typecheck` (server `tsgo --noEmit`): exit 0, zero `error TS`; existing Effect suggestions only.
- Scoped `vp fmt --check` on both files: pass.
- Scoped `vp lint` on both files: exit 0.
- `git diff --check`: exit 0.
- Commit hooks ran (lefthook `vp fmt`); commit `[skip ci]`; only the two owned files staged.

## Limitations

- The runtime test file is not fully green because of the pre-existing POSIX spawner-ownership failure, which I did not modify or fix.
- No real CLI, build, root checks, installs, other agents or external messages were run.
- No source-reviewer lifecycle correction arrived for these files, so the sequencing stop condition did not trigger.
