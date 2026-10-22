Fixed the P2 in `apps/server/src/provider/opencodeRuntime.test.ts` only.

**Change**

- `runtimeLayerWith` now always provides `WindowsTaskkillSpawner` to the layer. When no test worker is injected, it uses a deterministic fake that settles immediately with exit code 0, so fake win32 handles reporting pid 1 can no longer reach the production `Context.Reference` default and spawn a real `taskkill /pid 1 /T /F`.
- Explicit test workers still take precedence. The `makeLaunchErrorSpawner` native-error fixtures and the real POSIX spawner helper are unchanged. No production source, docs, changelog, or other lane was touched.
- The hung `--version` fixture now records the default worker spawn for pid 1 and drives effect continuations with bounded yields, so its progress depends on the fake worker, not an OS subprocess.
- Added one regression test, `uses the deterministic default worker for fake command handles`, which asserts the helper's default worker is invoked for pid 1 and the fake command handle is never killed through the spawner.

**Verification**

- `vp test run src/provider/opencodeRuntime.test.ts`: 34 passed, both before and after commit (33 existing plus 1 new regression).
- `vp fmt --check apps/server/src/provider/opencodeRuntime.test.ts`: exit 0.
- `vp lint --report-unused-disable-directives apps/server/src/provider/opencodeRuntime.test.ts`: exit 0.
- `tsgo --noEmit` in `apps/server`: exit 0, no diagnostics for the test file. Output contained only pre-existing Effect suggestions elsewhere.

**Commit and push**

- `4b1d0259c test(opencode): stub the Windows termination worker for fake handles [skip ci]`
- Pushed normally to `neokod/work/core-opencode-cleanup`. `dev` and `main` were not merged or touched.

**Limits**

- The full suite was not run, per the requested gate and scope.
- No native Windows run, real taskkill, build, install, app, browser, or live provider was exercised. The proof is that the fake layer records a worker for pid 1, which fails if the production reference is selected.
