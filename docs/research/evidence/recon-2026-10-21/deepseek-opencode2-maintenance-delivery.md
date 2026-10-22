I'll start by inspecting the current branch state and locating the relevant files.Now I understand the execution path. Let me make the changes.Pushed. Summary:

## Change

Root cause: maintenance capabilities (and the chosen updater) are captured once in `OpenCodeDriver.create()`; `ProviderMaintenanceRunner.updateProvider` reads that static object and spawns it. A CLI upgraded 1.x → 2.x after creation was therefore still passed to `npm install -g opencode-ai@latest`/`opencode upgrade`, replacing v2.

- `OpenCodeDriver.ts`: extracted `probeOpenCodeVersion` (shared by creation-time detection) and attach a command-time revalidation to the resolved update action. It re-probes the configured binary/env and blocks with the existing unsupported-version message when the current major is unsupported. Not attached for external-server instances (no local CLI inference) and not run at creation for disabled instances.
- `providerMaintenance.ts`: one optional field, `update.verifyStillApplicable`, documenting that a captured command may be re-checked immediately before spawn (`null` allows, message blocks).
- `providerMaintenanceRunner.ts` (narrow caller wiring, outside the listed allowlist because execution lives there): runs the revalidation after capabilities are read and before any state/command; a blocked reason returns `ServerProviderUpdateError` with no spawn and no update-state churn.
- Tests: driver test for the required v1-at-create → v2-at-update sequence (blocked), normal 1.x (allowed), external server (no guard/probe), disabled (no spawn until update requested); runner tests proving block-before-spawn and normal 1.x execution.

## Verification

- `vp test run` on `OpenCodeDriver.test.ts`, `providerMaintenanceRunner.test.ts`, `providerMaintenance.test.ts`, `openCodeVersion.test.ts`: 47 passed.
- Negative proof: removing the runner guard makes the block test execute the update and fail; restored afterwards.
- `tsgo --noEmit -p tsconfig.json` (apps/server): exit 0, no errors.
- Scoped `vp fmt --check` clean, scoped `vp lint` no findings. No builds, root checks, installs, processes, or `.repos` edits.

## Commit

`621803fd5` `fix(opencode): re-check CLI major before maintenance update [skip ci]`, pushed to `work/core-opencode2-guard` (no force).

## Remaining limits

- Guard only blocks. An instance created while v2 is installed keeps `update: null` after a manual 1.x downgrade until the instance is rebuilt (restart/settings change); it is not promoted dynamically.
- The check runs before the command queue, so a concurrent second click may probe before reporting "already running".
- An unverifiable version probe preserves existing behaviour and allows the update.
- External-server instances are neither guarded nor probed locally (intended); their displayed package capability is unchanged from before.
