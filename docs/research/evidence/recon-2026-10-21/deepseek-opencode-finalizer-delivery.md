I'll start by reading the review finding, repo docs, and the current state of the branch before touching any code.Guard lane is stated complete. Reading the runtime, its tests, and the vendored spawner before deciding anything.I have the full picture. The installed beta.78 spawner's `acquireRelease` finalizer signals `-pid` on scope close for an already-exited non-zero child, and `unref` cannot suppress that branch. The public spawner API has no cleanup toggle. The safe route is to give the spawner a private scope that Neokod never closes, and register the only cleanup on the caller's scope via `acquireRelease`. Implementing that now.The regression is red without the fix, but the sentinel died without writing its TERM marker. I want the test to observe the exact signal, so I am checking the fixture's signal behaviour before finalizing it.The sentinel's shell was exiting for its own reasons, so I'm replacing it with a deterministic interceptor at the exact OS boundary the spawner finalizer uses (`process.kill`), which directly records whether `-pgid` is signalled while still using the real spawner and a real non-zero-exit child.Pushed to the existing branch without force.

## Result

**Commit:** `5cf2c44b5fb3b56ef07d7ae7ef59b2f9c91ccd15` on `work/core-opencode-cleanup` (parent `a4e8a7353`), pushed to `origin` fast-forward. `main`/`dev` untouched.

**Change:** `apps/server/src/provider/opencodeRuntime.ts` and its test only.

- The server is now spawned into a private `Scope.make()` that Neokod never closes, so the installed beta.78 `NodeChildProcessSpawner` finalizer can never run.
- The sole cleanup owner is `Effect.acquireRelease` on the caller's scope: guarded `terminateOpenCodeProcessGroup`, then ledger forget.
- Acquisition is uninterruptible by `acquireRelease`, so a child cannot be orphaned between spawn and finalizer registration.
- `unref()` was not used: in beta.78 the finalizer checks the exit signal before the referenced flag, so it cannot suppress the already-exited non-zero branch.
- Streams, `exitCode`, ready handling, ledger ordering, Windows `child.kill` cleanup and normal owned stops are unchanged.

## Evidence

- **Red proof:** reverting just the spawn scope to `runtimeScope` reproduces the finding exactly: the guard logs `identity: 'process_gone'`, then the spawner records `{ pid: -<leader>, signal: 'SIGTERM' }` at the `process.kill` boundary. Restored after the check.
- **Green regression** (real Node spawner, owned fixture child that exits 7): no group kill is recorded after the guard refuses.
- **Normal owned stop** (real Node spawner, healthy looping fixture): closing the scope still terminates the group.
- Focused file: 18 passed.
- OpenCode-related files: 81 passed across runtime, adapter, provider, text generation and ledger tests.
- `apps/server` tsgo typecheck: exit 0.
- Scoped `vp fmt --check` and `vp lint --report-unused-disable-directives`: clean.

## Limits

- The public spawner API has no cleanup toggle. Never closing its private scope is the smallest safe suppression; it holds no OS resource of its own once the child is gone and becomes unreachable, but a guard refusal against a still-live unverifiable leader deliberately leaves that process running with its ledger entry (fail-closed).
- `runOpenCodeCommand` still uses the ordinary scoped spawner path. It has no Neokod ownership guard, so this finding’s “after guard skip” sequence does not apply there; I did not change it.
- Per instruction I did not run builds, `vp check`, installs, or any root-wide checks.
