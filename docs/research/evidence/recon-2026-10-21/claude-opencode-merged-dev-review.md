I found no P0, P1 or P2 issues in the merge `ec84861d5..6b6c1f06e`, judged against the current dev source. This is from reading the source only. I ran nothing, and I can't confirm runtime or native Windows behaviour.

## Review points

**Unknown-version maintenance guard from d54cc1e96: kept.** The merge doesn't touch `Drivers/OpenCodeDriver.ts`.

- `probeOpenCodeVersion` (`OpenCodeDriver.ts:124`) still returns `null` when the probe times out, fails or can't be parsed.
- `openCodeUpdateBlockedReason` (`:164`) still blocks an update when that result is `null`.
- `verifyStillApplicable` is still wired at `:279-286`.
- The merge makes this guard more reliable. Before it, a CLI that ignored SIGTERM could leave the timeout in that probe waiting forever. Command cleanup is now bounded, so the check before an update finishes.

**Bounded version status: correct.** At `OpenCodeProvider.ts:404`, `timeoutOption(OPENCODE_VERSION_PROBE_TIMEOUT)` now limits the status probe.

- A timeout gives `installed: true, version: null, status: "error", auth: unknown`, and the status check never connects or loads the inventory.
- A real failure still goes through `fallback` as before.
- The vendored `raceAllFirst` (`.repos/effect-smol/.../effect.ts:1468`) waits for the interrupted loser to stop. The real wait is therefore about 5s plus up to about 2s of cleanup, which the comment at `OPENCODE_COMMAND_TERM_GRACE` already states. The "did not finish within 5000ms" message is still accurate because it describes collecting the output.

**Owned cleanup and interruption: correct.**

- `acquireRelease` inside `Effect.scoped` (`opencodeRuntime.ts:890-922`) is now the only cleanup owner. The private `spawnScope` is never closed, so the vendored finaliser never runs. That finaliser waits for exit without a bound and signals the process group without checking ownership.
- The private scope holds no forked fibres. The vendored spawner only calls `forkScoped` for stdin when a stream is supplied (`NodeChildProcessSpawner.ts:212,267`), and `runOpenCodeCommand` supplies none.
- On POSIX, `escalateChildTermination` limits each `kill` to `grace`. Vendored `kill` waits for exit (`:539`), so the total stays bounded.

**Native Windows worker: correct.**

- Spawning, attaching the observers, replaying an exit that already happened and building the handle all happen in one synchronous `Effect.try` (`:563`), with the Deferred created before it.
- There is one worker. Cancellation kills it through its own handle and launches no second `taskkill`.
- Waits are 1s plus 1s. A worker that fails or doesn't settle is reported as unknown, not as stopped.
- Release runs uninterruptibly, so the `onInterrupt` at `:755` won't fire on that path. The timeout branch of `settleWindowsTaskkillWorker` covers the same case, so the time limit still holds.

**External server: unchanged.** The status probe is still inside `if (!isExternalServer)`. Driver creation and maintenance still skip external servers.

## Minor (P3)

1. **A test can launch a real system `taskkill`.** `opencodeRuntime.test.ts:426-458` ("starts the server after a hung --version probe times out") uses `runtimeLayerWith` with `HostProcessPlatform` set to `"win32"` and no worker override. When its fake hanging handle times out, cleanup goes through the default `WindowsTaskkillSpawner` (`:653`), which really spawns `taskkill /pid 1 /T /F`.
   - On macOS and Linux this fails with ENOENT. The error is caught, so the test passes, but it depends on that real launch failing.
   - On a Windows machine it would run the system `taskkill` against fake pid 1.
   - CI only uses Windows for the release build (`release.yml:261`), so this is test hygiene, not a live risk.
   - Fix: pass a no-op `WindowsTaskkillSpawnerShape` in `runtimeLayerWith` by default.
2. **Duplicated helper.** `isCommandChildRunning` (`opencodeRuntime.ts:789`) repeats the private `isChildLikelyRunning` in `providerSnapshot.ts:98`, which `escalateChildTermination` already lives beside. Exporting the existing helper would leave one definition.
3. **Pid reuse on Windows.** A pid could be reused between the `isRunning` preflight and `taskkill` resolving it. The comment at `:819` documents this limit, and the vendored spawner had the same exposure, so it is not a regression.

The `sol` final answer's limitation is also resolved: the `d54cc1e96` guard is present in dev, and the merge diff touches neither the Driver nor the maintenance paths.
