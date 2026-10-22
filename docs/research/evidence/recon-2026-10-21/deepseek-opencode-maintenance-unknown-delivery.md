Implemented and pushed on `work/core-opencode2-guard`.

**Commit:** `d54cc1e96e2c8df179e6d422eb0d7749f9a7b859`
`fix(opencode): refuse legacy updater when version is unknown [skip ci]`

**Changes**

- `OpenCodeDriver.ts`: command-time maintenance guard now fails closed. A `null`/unknown probe result returns a retryable blocked reason explaining that the installed major could not be verified. Known OpenCode 2 remains blocked; known OpenCode 1 remains allowed to update.
- Hydration/status behaviour is unchanged: unknown versions still keep the existing fallback, and `symphonyCodeReview` remains enabled for unverified installs.
- `OpenCodeDriver.test.ts`: added unparseable and failing probe cases; the hung-probe test now expects refusal rather than permission.
- `providerMaintenanceRunner.test.ts`: runner regressions now exercise the real driver guard decision. Unknown probe spawns no command and clears the queued state; known supported 1.x still updates; known 2.x rejects.

**Verification chronology**

1. Focused tests: 35 passed across `OpenCodeDriver.test.ts`, `providerMaintenanceRunner.test.ts`, `openCodeVersion.test.ts`.
2. Server typecheck: exit 0. Effect tsgo emitted pre-existing suggestions, no type errors.
3. Scoped `vp fmt --check`: passed.
4. Scoped `vp lint`: passed.
5. `git diff --check`: clean.
6. Commit hooks enabled; `vp fmt` ran during commit.
7. Re-ran the same focused tests on the committed tree: 35 passed.
8. Normal push, no force: `abac8268c..d54cc1e96`.

**Limits**

- No root checks, builds, installs, app runs, real CLI processes, or external actions.
- `openCodeVersion.ts` was left untouched per scope; its probe-timeout comment still describes the unknown fallback, while the new maintenance refusal lives in the driver guard.
