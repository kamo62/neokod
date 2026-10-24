What this change does: It buffers server configuration updates while constructing the initial snapshot, then emits the snapshot first. It also preserves nested OpenCode HTTP status codes in diagnostic messages so external server authentication rejection is classified correctly.

Reviewer configuration: gpt-6.1-sol, high, as requested for this delegated review. This is a read-only source review. No source/test changes, tests, builds, provider calls or live commands were performed. Expected load is the documented local, single-user server with several provider probes and concurrent settings updates.

Reviewed frozen worktree: `/Users/kamogelo/.codex/worktrees/neokod-provider-detection/t3code`, HEAD `1eee1929961e4659c70e968961cc82f90c355023`, four changed files against that base. Read README, AGENTS, state-and-evidence, implementer handoff, connected callers, and vendored Effect source.

Must fix:

1. [P2] One yield does not attach the production subscribers (`apps/server/src/ws.ts:1386-1393`; production composition at `2881-2884`).
   - What this is: The helper forks the consumer of `merge(keybindings, merge(debouncedProviders, settings))`, yields once, then reads the snapshot and starts refresh.
   - Problem: `Stream.merge` delegates to `Channel.merge`, which schedules a separate fibre for each side. Starting the outer consumer only queues the outer branches; starting the right branch queues the nested provider/settings branches. The parent can resume and read cached providers before the provider branch subscribes. An already running provider probe can then finish and publish its ready state during that gap. The snapshot retains pending and that update is lost. This is the same missing-update outcome the change is intended to fix, not merely a hypothetical scheduler policy. The default scheduler drains batches and equal priorities are FIFO. The one yield queues the parent's continuation ahead of the branches subsequently queued by the consumer.
   - Fix: Acquire the underlying scoped subscriptions before starting refresh or reading the snapshot, then compose streams over those acquired subscriptions. The repository already uses this exact pattern through `ProviderInstanceRegistry.subscribeChanges` and `Stream.fromSubscription`. For this RPC, expose an equivalent scoped acquisition on the relevant services (at minimum ProviderRegistry for the pending-picker defect; all three sources for the helper's stated guarantee). Preserve the existing mappings, settings secret materialisation and provider debounce after acquisition. This requires a small, explicit expansion beyond the frozen four-file ownership. Do not replace the yield with a sleep, several yields, `Stream.toPull` alone, `Stream.toQueue`, or only `forkScoped({ startImmediately: true })` around the merged consumer: none acquires all nested PubSub subscriptions before returning.
   - If we skip it: A connection can still keep a pending provider after its readiness event was published. The new test (`ws-server-config.test.ts:27-30`) uses a single PubSub without production merge/debounce, so it cannot reject this implementation. Add a focused regression using the actual nested merge/debounce and an update synchronised immediately after the snapshot's provider read, without a delay that allows subscribers to catch up.

2. [P2] Live consumer failure no longer reaches the RPC (`apps/server/src/ws.ts:1385-1394`).
   - What this is: The new background consumer writes successful values to a plain unbounded queue. The returned stream only drains that queue.
   - Problem: The consumer fibre is discarded, and neither its failure nor its normal completion closes/fails the queue. A source with an allowed defect (for example a mapper/secret materialisation defect, or `Stream.die(...)`, whose typed error is still `never`) now kills the producer while the RPC waits forever after the snapshot. Before this change, the live merged stream was consumed directly, so that cause reached the RPC instrumentation and caller.
   - Fix: Preserve the source exit in the queue. The supported existing API is `Stream.runIntoQueue` with a queue whose error type includes `Cause.Done`, followed by `Stream.fromQueue`. It forwards successful values, calls `Queue.endUnsafe` on completion, and `Queue.failCauseUnsafe` on failure. Keep scoped interruption and add a focused defect-propagation assertion alongside the subscription regression. Alternatively retain and explicitly propagate the consumer exit without inventing new infrastructure.
   - If we skip it: A broken live feed looks like an open, idle subscription, and reconnect/error handling cannot respond to the actual failure.

Accepted portions:

- `opencodeRuntime.ts:275-296` reads only numeric status values from the relevant nested Error/cause/response shape. It keeps the existing Error message, carries 401/403 through to `OpenCodeProvider.formatOpenCodeProbeError`, and does not serialize that nested body. The focused new tests cover the requested 401 credential-body case, nested 403, plain Error compatibility and the old response-shaped output. This is not a claim that all existing non-Error diagnostics are credential-safe; the unchanged body-serialization branch still exists.
- The live consumer is scope-bound via `forkScoped`; closing the RPC stream scope interrupts it and releases subscriptions already acquired by the stream. Snapshot failure remains in the effect error channel and the enclosing RPC scope provides cleanup. No separate cleanup blocker was found. The success-path finalizer test checks one useful aspect of cleanup, but does not establish error propagation or the production subscription barrier.
- Snapshot-first delivery, existing provider debounce and refresh error logging are retained.

Vendored Effect evidence used to determine the supported pattern:

- `Stream.ts:1389`: `fromPubSub` delegates to `Channel.fromPubSubArray`.
- `Channel.ts:1695-1696`: `fromPubSubArray` wraps `PubSub.subscribe` in `unwrap`.
- `Channel.ts:6627-6640`: `unwrap` does not run its acquisition until the first pull. Thus `Stream.toPull` alone is not a subscription barrier.
- `Channel.ts:6213-6269`: merge forks each branch with `Effect.forkIn`; nesting adds more scheduled branches.
- `internal/effect.ts:5038-5053`: ordinary forks schedule child evaluation; `yieldNow` at `911-926` merely schedules the parent's continuation.
- `Scheduler.ts:224-230`: the default dispatcher drains one batch; later child tasks run in a subsequent batch. `Scheduler.ts:60-64` documents FIFO for equal priority.
- `PubSub.ts:1130-1141`: direct `PubSub.subscribe` registers the subscription and its scope finalizers before returning.
- `Stream.ts:1589-1590`: `fromSubscription` consumes a pre-acquired subscription.
- `Stream.ts:11674-11690`, `Channel.ts:8141-8175`: `runIntoQueue` preserves the source exit using queue end/failure.
- Existing repository precedent: `provider/Services/ProviderInstanceRegistry.ts:55-81`, `provider/Layers/ProviderInstanceRegistryLive.ts:387-396`, and `provider/Layers/ProviderRegistry.ts:630-671`.

Verification boundary: The implementer handoff reports 39 focused tests plus two subscribeServerConfig tests, targeted formatting/lint and server typecheck. I did not rerun those and do not treat them as proof of the missed production topology or live UI/provider behaviour. No live acceptance is established.

Frozen file SHA-256:

```text
cc75ed5ed626897da5caa40edb2b096cfaa93aaa2b2b56d26a5719e7e59b99af  apps/server/src/ws.ts
4a86ca46350f47ba47bce3bb051adfd927d486723f81382b87e98d7746e1f250  apps/server/src/ws-server-config.test.ts
223d9bdbd2756c72946d8a407468e186d345e2f1502bbdd0c41634fa1a9b6909  apps/server/src/provider/opencodeRuntime.ts
45156729340e20b21c02bd615def1a22c581cbc3ebdb4d3306698f43ef5b01a5  apps/server/src/provider/opencodeRuntime.test.ts
```

Verdict: fix 1 and 2 first. The HTTP-status change is acceptable as a source change; the server configuration stream fix is not accepted.

Not checked: test execution, desktop behaviour, provider authentication against a real server, build/package/deployment.
