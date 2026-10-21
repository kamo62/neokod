### P2: The pinned tree loses the fail-closed maintenance guard

**Location:** [`apps/server/src/provider/Drivers/OpenCodeDriver.ts:262–265`](apps/server/src/provider/Drivers/OpenCodeDriver.ts#L262)

**Trigger:** A local instance captures a 1.x updater, the installation subsequently changes, and command-time `--version` fails, times out or returns unparseable output.

`probeOpenCodeVersion` returns `null`, which these lines convert into permission to update. [`providerMaintenanceRunner.ts:332–357`](apps/server/src/provider/providerMaintenanceRunner.ts#L332) then executes the captured updater, potentially replacing an unsupported installation.

`cc054117d` contains the fail-closed correction from `d54cc1e96`; this pin branches before that correction. The requested endpoint diff therefore loses both the protection and its regression coverage, although the four cleanup commits did not directly remove them.

**Action:** Preserve `d54cc1e96` and its tests during integration. Unknown command-time version evidence must refuse the destructive update with a retryable explanation.

### P2: Native worker errors can arrive before an error listener exists

**Location:** [`apps/server/src/provider/opencodeRuntime.ts:545–571`](apps/server/src/provider/opencodeRuntime.ts#L545)

**Trigger:** Windows cannot launch `taskkill.exe`, for example because its resolved path is missing or execution is denied, and Effect yields between native spawn and evaluation of `worker.exitCode`.

`spawn` returns before reporting asynchronous launch errors. The error listener is only installed inside the lazy `Effect.callback`, not when the native child is created. Effect’s cooperative scheduler can yield across that gap even during uninterruptible finalisation. Node can consequently emit an unhandled `"error"` and terminate Neokod instead of returning the intended unknown-state warning. `Effect.try` cannot catch that asynchronous event.

**Action:** Attach native exit/error observers synchronously with spawn and retain a single replayable settlement result for both bounded waits. Add a deterministic adapter regression that delivers a launch error before the first wait subscribes. The injected Deferred-worker tests bypass this native boundary and do not cover it.
