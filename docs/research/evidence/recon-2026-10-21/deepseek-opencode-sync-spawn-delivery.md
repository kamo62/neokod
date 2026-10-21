Now I'll add the regression fixture first, so I can prove it fails against the current commit before changing the runtime.The fixture now fails on the current runtime exactly as intended (`unobserved` is true). Now I'll move spawn, settlement and observer attachment into one synchronous `Effect.try` callback.Corrected at `2a924dea9` and pushed to `work/core-opencode-cleanup`.

## Runtime change

`apps/server/src/provider/opencodeRuntime.ts:570-654`

- The `Deferred` is created before the native child exists.
- Native spawn, settlement capture, `exit`/`error` observer attachment, already-exited replay, and handle construction now all execute inside one synchronous `Effect.try` callback.
- The callback returns a fully observed handle. No Effect scheduler yield can occur between `spawn` returning and listener installation.
- One replayable settlement, bounded cancellation through the owned handle, and the existing unknown-state warnings are unchanged.

## Regression proof

`apps/server/src/provider/opencodeRuntime.test.ts:762`

The fixture uses an Effect `Scheduler` one-shot yield triggered immediately after the native spawn callback, with the launch error queued on `process.nextTick`. It asserts:

- the scheduler actually yielded (`didYield`)
- the error was delivered before the generator continuation resumed
- the error was observed, then replayed as the same failure twice
- `isRunning` is false and `terminate` does not signal the unlaunched worker

Before the runtime change, against `c7571d0d8`, the focused test failed:

```
AssertionError: expected true to be false
at expect(unobserved).toBe(false)
```

`unobserved` was `true`, proving the old continuation installed listeners after the async error fired. It did not merely test removed listeners.

## Verification

- Focused launch-boundary tests: 3 passed
- Full `opencodeRuntime.test.ts`: 33 passed
- Server `vp run typecheck`: exit 0, no `error TS`
- Scoped `vp lint`: exit 0
- Scoped `vp fmt --check`: pass
- Diff: only `opencodeRuntime.ts` and `opencodeRuntime.test.ts`

## Limits

- No native Windows execution, real `taskkill`, build, install, browser, app, or live-provider check was performed.
- The fixture proves the Effect runtime scheduling boundary with a fake native child. It does not prove Windows kernel-level timing or real `EACCES` delivery.
- No docs, dependencies, driver, maintenance paths, or other sources were changed, and the branch was not merged into `dev` or `main`.
