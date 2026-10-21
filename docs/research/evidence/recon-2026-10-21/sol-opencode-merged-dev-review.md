I’ll review the four files at `6b6c1f06e` against `ec84861d5`, using the unchanged driver and maintenance paths only as integration context. I won’t edit files or run checks, and I’ll distinguish source findings from runtime or Windows evidence.The supplied diff matches the exact merge, and all four reviewed files match `6b6c1f06e`. The `d54cc1e96` guard is still present: command-time maintenance rejects an unknown version before the updater can spawn, inside the shared lock. I’m finishing the cleanup and Windows observer trace; no actionable finding so far.I found one P2 in the test integration: the hung-version fixture uses a fake command PID but inherits the production `taskkill` worker. On Windows, its immediate startup assertion races that real subprocess’s exit. The production cleanup path and preserved maintenance guard have no actionable source finding so far.One P2 finding in the test integration. No P0/P1 or production-code P2 identified in `ec84861d5..6b6c1f06e`.

### P2: Stub the termination worker in the hanging-version fixture

Location: [`apps/server/src/provider/opencodeRuntime.test.ts:269–271`](apps/server/src/provider/opencodeRuntime.test.ts#L269), affecting the fixture at lines 426–458.

`runtimeLayerWith` inherits the production `WindowsTaskkillSpawner` when none is supplied. The hanging-version fixture supplies no replacement, although its command handle is fake and reports PID `1`.

At the five-second probe timeout, cleanup now launches a real `taskkill` worker and awaits its settlement. The fixture then performs only `Effect.yieldNow` before asserting at line 449 that the server has spawned. On Windows, whenever that real subprocess has not exited by the assertion, cleanup is still pending and no server has spawned. The assertion therefore fails despite correct runtime behaviour. Advancing the test clock does not establish completion of the OS subprocess.

Inject a deterministically settled fake termination worker for this fixture, or make the fake-runtime helper provide one by default. This is a source-derived timing defect, not a reproduced Windows failure.

### Integration findings

- The `d54cc1e96` unknown-version maintenance guard is preserved. The driver still maps unknown evidence to a blocked reason, and the unchanged maintenance runner checks it inside the shared lock before updater spawn.
- Provider status now bounds local version collection at five seconds and retains `version: null` and unknown authentication on expiry. Owned cleanup can add its documented bounded windows.
- Command cleanup remains the sole owner through command-local `acquireRelease`; the private spawner scope is not closed, avoiding its automatic unbounded or unguarded finaliser.
- Native worker spawn, observer attachment, already-exited replay and handle construction remain synchronous within one callback. Settlement is replayable; cancellation uses the native handle with a second bounded wait rather than another `taskkill`.
- Configured external-server paths remain outside local version probing and owned-process cleanup.

The supplied diff matched the exact merge, and the four reviewed files remained identical to that revision. No edits, tests, checks, builds or runtime activity were performed. Main’s reported 43 passing tests, `vp check` result and root typecheck pass were not rerun. Native Windows behaviour and OS-level termination remain unproven.
