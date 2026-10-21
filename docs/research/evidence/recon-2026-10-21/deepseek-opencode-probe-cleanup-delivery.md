I'll start by reading the required context documents and the review file.Now I have the full picture. Let me make the runtime change, reusing the existing `escalateChildTermination` helper.Now the `runOpenCodeCommand` boundary itself:Now add the real-spawner fixture tests with an external watchdog:Found it: my version removed `Effect.scoped`, so the `acquireRelease` finalizer attached to the caller's ambient scope instead of running on interruption. Restoring the local scope is required.## Result

Fixed the shared `runOpenCodeCommand` cancellation boundary and pushed `61fcc828ab6375603ec65456103531909d6e158b` to `work/core-opencode-cleanup` (normal push, no force).

## What changed

`apps/server/src/provider/opencodeRuntime.ts`

- `runOpenCodeCommand` now spawns into a private scope this runtime never closes, so beta78's spawner finalizer (TERM, then an unbounded `Deferred.await(exitSignal)`, plus its unguarded non-zero-exit group signal) can never run. A local `Effect.scoped` plus `Effect.acquireRelease` is the only cleanup owner, so interruption and completion both run it.
- Cleanup reuses the existing `escalateChildTermination` helper: bounded SIGTERM, bounded SIGKILL, bounded exit wait (1s grace per stage). Survivors of SIGKILL are logged with their pid instead of being awaited forever; unknown liveness stays `true` and is not reported as stopped.
- Kept the guarded server group termination, ledger retention, password/env scrubbing, Windows ENOENT mapping, and normal `{stdout, stderr, code}` results unchanged. No new process framework, no dependency/vendor edits.

`apps/server/src/provider/opencodeRuntime.test.ts`

- Added a POSIX real-spawner fixture that hangs on `--version` and ignores SIGTERM, plus tests for direct command interruption and for runtime startup reaching the unknown-version fallback.
- Each test runs the effect in a forked fiber and polls completion from the test. If the deadline passes, an external watchdog SIGKILLs the owned fixture and records `watchdog_expired`, so a regression fails instead of hanging the runner.
- Both tests assert bounded return, an interrupted/failed-or-successful exit as appropriate, and that the recorded fixture pid is no longer alive.
- Measured bounds are stated honestly: interruption asserts < 4s (~1s TERM grace + SIGKILL); startup asserts < 9s (5s probe timer plus up to 1s TERM grace plus the prompt SIGKILL exit).

## Verification actually run

| Check                                                                                                                                         | Result                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vp fmt --check` on both files                                                                                                                | pass                                                                                                                                                                                                          |
| `vp lint` (repo) and scoped lint                                                                                                              | exit 0; no findings in touched files                                                                                                                                                                          |
| `vp run typecheck` in `apps/server` (tsgo)                                                                                                    | exit 0, no errors                                                                                                                                                                                             |
| `vp test run src/provider/opencodeRuntime.test.ts src/provider/Drivers/OpenCodeDriver.test.ts src/provider/providerMaintenanceRunner.test.ts` | 3 files, 51 tests passed                                                                                                                                                                                      |
| Old-code proof                                                                                                                                | With `opencodeRuntime.ts` reverted and the new tests kept, both failed via `watchdog_expired` with the watchdog bounds (5s and 9s; 16.6s total) and the runner exited normally. Restored runtime then passed. |

## Chronology

1. Read the Sol review, `AGENTS.md`, `docs/architecture/state-and-evidence.md`, the Effect `LLMS.md` and vendored spawner.
2. Traced all four `runOpenCodeCommand` callers: driver version probe (timeout), provider snapshot status (no timeout), runtime startup guard (timeout), test stubs.
3. Implemented bounded owned cleanup, reusing `escalateChildTermination`.
4. Test iterations found one real defect in my first cut: without a local `Effect.scoped`, `acquireRelease` attached to the caller's ambient scope and cleanup ran only at scope close. Restoring the local scope made interruption cleanup synchronous.
5. Verified old-code failure under the watchdog, restored the fix, ran scoped checks, committed with hooks enabled (`fix(opencode): bound command cleanup on interruption [skip ci]`), pushed without force.

## Limitations

- Windows is not exercised: the new real-spawner tests are POSIX-gated, and Windows relies on the handle's `taskkill`-backed kill path being bounded by the same helper. No Windows runtime evidence is claimed.
- `apps/server/src/provider/Layers/OpenCodeProvider.ts:389` still calls `runOpenCodeCommand` with no caller-side timeout. A CLI that hangs on `--version` can still stall that status refresh. That is a caller gap in a file outside this task's ownership; the runtime cleanup itself no longer hangs when a caller does time out.
- Cleanup can add up to roughly two seconds beyond the 5s probe timer, so the effective worst case is about 7s, not a hard 5s.
- No builds, rootchecks, installs, app runs, real-CLI runs, other agents or external messages were used, per scope.
