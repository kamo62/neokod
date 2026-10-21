Done. Pushed commit `abac8268c360d4227fedacc5ebb6e66bf3def3a4` to `work/core-opencode2-guard` with hooks enabled and no force.

## Changes

**O1 P2 version probe bound**

- Added `OPENCODE_VERSION_PROBE_TIMEOUT = Duration.seconds(5)` in `openCodeVersion.ts`.
- `probeOpenCodeVersion` now uses `Effect.timeoutOption(OPENCODE_VERSION_PROBE_TIMEOUT)`.
- A timeout resolves `null`, preserving the documented unknown fallback: no version-based block, Symphony review stays enabled, maintenance retains its resolver fallback.
- Applies to both hydration and the command-time maintenance revalidation because both use the same probe.

**Maintenance verify moved inside the actual lock**

- Removed the pre-queue `verifyStillApplicable` check in `providerMaintenanceRunner.ts`.
- The guard now runs inside `runProviderUpdate`, which executes only after `withCommandLock` has acquired the shared provider lock. That is after any queue wait and immediately before the captured command starts.
- On rejection it clears the transient `queued` state, then returns `ServerProviderUpdateError` with the guard reason, so no provider is left looking queued.
- The rejection test was updated to assert no final `updateState` instead of an empty state history, which cannot hold once the update has entered the queue.

## Test evidence, in order

Before the source fix:

- New runner regression failed at `Exit.isFailure(secondExit)`: the legacy second command still spawned after the version flipped to 2.x.
- New driver timeout test hung and hit the 120s test timeout, confirming the unbounded probe.

After the fix:

- `providerMaintenanceRunner.test.ts`, `OpenCodeDriver.test.ts`, `openCodeVersion.test.ts`: 32 tests passed.
- Server `vp run typecheck`: exit 0.
- Scoped `vp fmt --check`, scoped `vp lint`, and `git diff --check`: passed.

The regression test uses the real runner and command coordinator with a withheld shared lock, flips the fake version from 1.x to 2.x after the update is enqueued, and verifies only the first provider's command ran. No real CLI or live process was used.

## Limits

Only the five authorised files changed. `opencodeRuntime.ts` and its test were not touched, so the runtime-start probe remains unbounded and assigned to the other worker. No build, root checks, installs, app/provider/browser launches, live processes, user data, external messages, or `.repos` edits were performed.
