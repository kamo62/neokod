I'll start by orienting in the specified worktree and reading the required docs and review.Now I have the full picture. Let me make the source changes, starting with the reconciler timing.I found a correctness problem with using `session.updatedAt` as the freeze time: it is also the observation cutoff for runtime-item closure, so recovered items observed after the binding write would be left active. I'm correcting this by carrying turn completion as a separate field, keeping session/event time server-owned.Implemented and pushed on `work/core-crash-recovery`.

**Commits**

- `c37563ab39c26cc254a9ce1f9d55287069c93532` (HEAD): `fix(orchestration): carry recovered turn completion separately from event time [skip ci]`
- `a666f2f45`: `fix(provider): close crash-recovery timing, stop evidence and error-text gaps [skip ci]`

Pushed to `neokod/work/core-crash-recovery`. Remote HEAD matches local HEAD.

**What changed**

1. Recovered turn timing: the reconciler now carries `lastObservedAt` and dispatches it as a separate optional `latestTurnCompletedAt`. `session.updatedAt` and `createdAt` remain on the server clock. The in-memory projector, durable `ProjectionPipeline`, and client reducer use the separate completion time. The second commit exists because the first attempt changed `session.updatedAt`, which would also have shifted the runtime-item closure cutoff and could leave newer items active.
2. Shutdown snapshot: `upsertSessionBinding` now preserves stop evidence by default. Only accepted start and recovery paths pass `clearStopEvidence: true`. The `stopAllSessions` pre-sweep snapshot no longer clears `stopPhase`, `stopOutcome`, or `stopRequestedAt`.
3. Inactive `host_lost` stop: an explicit Stop now returns the persisted orphan outcome, emits a settled stop update, and performs no durable write. A crash before settlement therefore cannot erase the original observation.
4. Backtick paths: the quoted absolute-path matcher accepts backticks, while backtick-quoted relative paths remain untouched.
5. URL apostrophes: URL tokenisation allows an internal apostrophe only when URL content follows, so `https://api.example.com/v1?name=O'Reilly&redirect=/docs/api` is fully preserved, including quoted forms.

**Verification**

- Server focused tests: 5 files, 134 tests passed (`userFacingErrorText`, reconciler, `ProviderService`, `ProjectionPipeline`, `ProviderRuntimeIngestion`).
- Additional impacted tests: 2 files, 45 tests passed (`ProviderCommandReactor`, `ProviderSessionReaper`).
- Client-runtime reducer test: 21 tests passed.
- `vp run --filter neokod typecheck`: exit 0.
- `vp run --filter @neokod/contracts typecheck`: exit 0.
- `vp run --filter @neokod/client-runtime typecheck`: exit 0.
- `vp run --filter @neokod/web typecheck`: exit 0.
- Scoped `vp lint` on all 14 changed files: exit 0.
- Scoped `vp fmt --check` on all 14 changed files: exit 0.
- `git diff --check` and `git diff --check 75e608f53..HEAD`: exit 0.

**Material design decision**
Added one narrow optional field, `latestTurnCompletedAt`, to the internal `thread.session.set` command and `thread.session-set` payload. This is required to separate frozen turn completion from server-owned session and event time without changing the runtime-item closure cutoff. It is consumed by the server projector, projection pipeline, and client reducer.

**Startup ingestion readiness gap**
Still unresolved and unchanged. Startup runs `providerRuntimeIngestion.start()` before `providerSessionReconciler.reconcile` (`serverRuntimeStartup.ts:345`, `OrchestrationReactor.ts:20`). Ingestion runs its startup reconciliation before subscribing, then forks `streamDomainEvents` (`ProviderRuntimeIngestion.ts:2241-2254`), while the engine exposes `Stream.fromPubSub(eventPubSub)` with no replay (`OrchestrationEngine.ts:345`). A recovery event dispatched before the fork subscribes can be missed. A narrow fix needs a subscription-ready signal or a replayable domain-event subscription in the orchestration engine API, which is broader than this lane, so I left it as a reported gap.

**Proof limits**

- `binding.lastSeenAt` is the last binding write, not a per-item observation. Individual orphaned items still freeze at their own `updatedAt`. A recovered turn may under-report elapsed time if no binding write occurred after turn start.
- The stop-window tests simulate the crash between writes by guarding the directory upsert. They do not reproduce a process kill.
- No root `vp check`, full workspace suite, builds, installs, browser/app runs, live providers, or native process changes were performed.
- Client-runtime was updated because it applies the same `thread.session-set` event; no other lane source or plan/docs files were touched.
