I’ll review the commit, its command-runtime dependencies and existing fixture evidence without running anything or changing files. I’ll keep findings focused on the open timeout P2 and risks introduced by this delta.The source and recorded test output support closure of the original POSIX TERM-ignore hang. The old runtime failed through the fixture watchdog; the fixed runtime returned and asserted that the fixture PID was gone.

One Windows concern remains: beta.78’s handle kill launches `taskkill /T /F` without a cancellation handler. A timeout can stop waiting for it while leaving that termination process running. I’m checking the exact impact on this new cleanup path.One actionable P2 remains in the new Windows cleanup path. The original POSIX TERM-ignore/finaliser hang is closed by this commit, with meaningful recorded fail-first/pass evidence. No P0 or P1 found.

Reviewed `61fcc828a` against parent `696f323c6`; HEAD matches and the working tree is clean.

## P2: Windows timeout abandons a still-running termination process

Location: [`opencodeRuntime.ts:509`](apps/server/src/provider/opencodeRuntime.ts#L509), through [`providerSnapshot.ts:123–126`](apps/server/src/provider/providerSnapshot.ts#L123).

Trigger: a Windows command is interrupted, and its `taskkill` invocation takes longer than the one-second cleanup window or hangs.

The installed beta.78 implementation does not provide cancellation-safe handle termination:

- [`NodeChildProcessSpawner.ts:341–350`](.repos/effect-smol/packages/platform-node-shared/src/NodeChildProcessSpawner.ts#L341) launches `taskkill /pid … /T /F` using `exec`, discards the returned process handle and supplies no cancellation handler.
- Both requested signals use that same forced tree-kill operation.
- `timeoutOption` interrupts the Effect callback wait, but cannot terminate or await the discarded `exec` process.
- If the command still appears running, escalation can launch a second `taskkill`. Cleanup can then return while either termination worker remains alive.

This bounds the caller’s wait by abandoning native work, rather than bounding all owned cleanup. Those workers can retain process resources and execute their captured PID-targeted operation after the original child has exited. The later liveness check cannot cancel them.

Action: make Windows termination cancellation-safe and owned through worker settlement, including bounded cleanup of any termination subprocess. Preserve unresolved child/worker evidence. Do not restore the unchecked native scope finaliser.

This finding concerns the newly introduced command-release boundary, not the unchanged server termination path.

## Original P2: closed for the POSIX trigger

The implementation now addresses the reported hang:

- [`opencodeRuntime.ts:548–559`](apps/server/src/provider/opencodeRuntime.ts#L548) places the native finaliser in a private scope and registers one explicit cleanup owner. Acquisition remains uninterruptible until release registration.
- The local [`Effect.scoped` at line 580](apps/server/src/provider/opencodeRuntime.ts#L580) runs release before command completion or interruption returns, rather than deferring it to an ambient scope.
- The helper’s timeout wraps the complete native `child.kill`, including its exit wait. Effect’s race creates interruptible competitors even inside the uninterruptible release.
- Native `isRunning` is an immediate Deferred-state read, not an asynchronous OS query. Its unwrapped checks do not introduce another native wait.
- Stdout/stderr collection owns its stream cleanup separately. The Node adapters remove listeners and destroy readables synchronously on interruption. This command configures no streamed stdin or additional-FD fibres in the private scope.
- Completed commands skip signalling, including nonzero exits. The unsafe native post-nonzero group-reaping branch cannot run. Normal output, numeric exit results, environment options and Windows command-not-found mapping remain unchanged.
- Timeout remains unknown version evidence. A surviving or unconfirmed child produces a PID-bearing warning, not a fabricated stopped outcome.

The effective probe budget is five seconds plus up to two seconds of cleanup and scheduling, not a hard five-second return.

## Fixture evidence and limits

The new [real-spawner fixtures](apps/server/src/provider/opencodeRuntime.test.ts#L710) install TERM ignoring before recording their PID. Completion is observed after cleanup; passing requires both return without watchdog intervention and the recorded PID no longer being alive.

I inspected the existing execution transcript in `/tmp/neokod-core-symphony-2026-10-21/acp/lane-opencode-probe-cleanup-events.jsonl`:

- Parent runtime with the new tests: both failed through `watchdog_expired`; the runner exited in 16.63 seconds.
- Restored fix: the runtime, driver and maintenance suites recorded 51 passing tests.

These fixtures establish POSIX leader-PID disappearance, not independent confirmation that every descendant is gone. They skip Windows.

Installed Effect/platform packages are beta.78. The vendored manifest says beta.73, but the relevant Effect implementation matches exactly and the spawner differs only in JSDoc; I checked the installed implementation directly.

No unchanged server-owned finaliser, ledger or stop finding was reopened. This review ran no tests, checks, builds or provider/app/browser actions and made no edits or external changes. Recorded execution evidence was inspected, not rerun.
