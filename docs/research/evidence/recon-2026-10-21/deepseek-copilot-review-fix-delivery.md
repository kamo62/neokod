I'll start by reading the required documentation and tracing the actual code paths.Now I'll add the failing regression test on the current source before touching production code.Red state recorded: the regression fails at "expected the in-flight turn to settle when the refresh replaced the runtime". Now implementing the fix.Implemented, committed and pushed on `work/core-copilot-recovery`.

## Fix

Runtime replacement now has one authoritative transition in `CopilotRuntimeSupervisor.restartIfDead`: re-probe under the restart permit, run the registered adapter settlement once, then `forceStop` and `start`. Settlement therefore runs on provider refresh, the adapter watchdog, send recovery, and abort recovery. The adapter records the settlement callback at construction and no longer requests its own restart from inside settlement, so the restart permit cannot be re-entered.

Files changed, all within the lane:

- `apps/server/src/provider/copilot/CopilotRuntimeSupervisor.ts`
- `apps/server/src/provider/copilot/CopilotRuntimeSupervisor.test.ts`
- `apps/server/src/provider/copilot/CopilotAdapter.ts`
- `apps/server/src/provider/copilot/CopilotAdapter.test.ts`
- `apps/server/src/provider/copilot/CopilotDriver.ts`
- `apps/server/src/provider/copilot/CopilotDriver.test.ts`

## Regression evidence

The new integration test creates a driver instance whose instance scope stays open, starts a session, sends a turn, opens a real pending approval through the adapter's permission handler, kills the child, and lets `snapshot.refresh` win.

On the pre-fix source the genuine assertion failure was:

```text
AssertionError: expected the in-flight turn to settle when the refresh replaced the runtime
```

The refresh had already called `forceStop` and `start`, but no `turn.completed` arrived and the session remained. Recorded in `lane-copilot-review-fix-red3.log`. An earlier red attempt failed before reaching the assertion because the driver test used `Effect.scoped`, which closed the adapter event queue as soon as `create` returned; the test now owns and closes its scope explicitly.

After the fix the same test verifies:

- old turn settles exactly once as failed;
- pending approval resolves once as `cancel`;
- `session.exited` appears once and `hasSession` is false;
- a second healthy refresh emits no duplicate terminal events;
- a fresh `startSession` and `sendTurn` recover on the replacement runtime.

## Checks run

- `vp test run` on the three affected suites: 54 passed.
- Driver suite repeated three times: 13 passed each run.
- `vp run typecheck` in `apps/server`: exit 0.
- `vp fmt --check` on the six files: clean.
- `vp lint --report-unused-disable-directives` on the six files: exit 0.
- `git diff --check`: exit 0.
- Commit hooks ran and passed (`vp fmt` on staged files).

No builds, root checks, installs, runtime/app/browser launches, Playwright, other providers, `.repos`, external messages, PRs or main merges. Version/changelog untouched because Main owns integration and docs.

## Commit

`95722133aaf3653becc34319287237bba593fca8`
`fix(copilot): settle sessions before every runtime replacement [skip ci]`

Pushed without force; `HEAD` matches `origin/work/core-copilot-recovery`.

Logs: `/tmp/neokod-core-symphony-2026-10-21/acp/lane-copilot-review-fix-*.log`.
