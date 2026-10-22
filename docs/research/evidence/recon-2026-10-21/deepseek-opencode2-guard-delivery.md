I'll start by reading the required context and inspecting the current state.I have the context. Let me add the regression tests first so the current failures are recorded, starting with the version helper and provider/runtime guards.Failures recorded as expected. Now implement the shared OpenCode version helper.I'll add a direct driver-construction regression so the maintenance and review-capability wiring is covered, not just the pure decision helpers.Branch: `work/core-opencode2-guard`  
Commit: `48769b3807329a3ea4650a3734c12497ec0f2c23`  
Pushed to `origin/work/core-opencode2-guard` without force.

## Implemented O1 guard only

- Added `openCodeVersion.ts`, which accepts `opencode v2.0.32` and plain `1.x` output, normalizes through the existing `parseSemver`, and classifies the major in one place.
- Provider status now reports a known OpenCode 2 install as an explicit unsupported error and returns before connecting, so it cannot appear ready or fail later as a timeout or inventory error.
- Both readiness banners are parsed without claiming v2 support: `opencode server listening ...` and `server listening ...`.
- Local server startup now probes `--version` before spawning `serve` and refuses an affirmatively classified unsupported major. This covers adapter and text-generation starts that bypass a fresh status snapshot. Failed or unparseable probes preserve prior behavior.
- The OpenCode driver probes only enabled local installs. For a known v2 install it advertises `symphonyCodeReview: false` and manual-only maintenance with no npm or native update command, so no 1.x downgrade is offered. Disabled instances and configured external servers are not probed.
- External servers remain on the existing auth and URL paths. Their version is explicitly reported as unverified with the OpenCode 2 warning, because Neokod cannot prove v2 from the protocol, HTML, or package version.
- No changes to `OpenCodeAdapter.ts`, `OpenCodeServerLedger.ts`, shared process handling, docs, changelog, or `main`. O2 remains queued.

## Verification chronology

1. Regression tests were added first. The focused run failed as expected:
   - `openCodeVersion` module missing.
   - Readiness banner parser not exported.
   - A v2 install still launched the HTTP server.
   - Provider status returned version `null` instead of the unsupported v2 message.
2. After implementation, the focused OpenCode suite passed: 40 tests.
3. Added direct driver wiring coverage, then passed: 13 tests.
4. Broader affected OpenCode/provider suite passed: 149 tests across 10 files.
5. `pnpm exec tsgo --noEmit` in `apps/server`: exit 0.
6. Scoped `vp lint`, `vp fmt --check`, and `git diff --check`: clean.
7. Commit hooks ran formatting successfully. Post-commit focused run passed: 42 tests.

No live OpenCode process, app, provider, or browser was launched. Tests use fake command, version, spawn, ledger, and client calls. Root `vp check` and full repository typecheck were not run, per the instruction against root checks.

## Limitations

- A configured external server cannot be version-classified locally. Its status now names that guard gap, but it may still fail against a v2 server through the legacy HTTP API.
- Maintenance capabilities are resolved when the driver instance is created. A v2 install introduced while Neokod is already running is blocked by the status and adapter guards, but the static maintenance capability can stay on the previous 1.x entry until the instance is rebuilt or the server restarts.
- No v2 updater was added. A known v2 install is intentionally manual-only.
- The `opencode acp` spike and any HTTP v2 runtime remain separate O2 and O3 work.
