The working tree is clean at `1b2b16f8891375f59d148bc95aaa744fa511a6d8`. I’ll review that frozen commit, focusing on the cursor invariant and refusal path, without running checks or changing repository files.The cursor gate accepts the intended shapes and rejects unsupported skew before any writes. The tests exercise `[11 × 9, 10]` for acceptance and `[11 × 9, 9]` for refusal. I found one narrow concern: the error advises clearing persisted data and restarting as though that recovery were verified safe, but replay can also prune attachment files.FIX, narrowly scoped, at frozen SHA `1b2b16f8891375f59d148bc95aaa744fa511a6d8`.

The cursor invariant and refusal-before-writes path are accepted at source level. The previous Stop, targeted-outcome, timestamp and old-target corrections remain intact.

One blocker remains: `apps/server/src/orchestration/Layers/ProjectionPipeline.ts:1921` instructs operators to clear projections/cursors and restart without establishing safe recovery. Historical replay can prune attachment files belonging to later valid messages. A wording-only correction should remove that recipe and require investigation, backups and a validated recovery procedure.

The report records the actual test shapes, assertion limits, and disclosed historical-identity/unknown-provenance limitations:

`/tmp/neokod-provider-reliability-2026-10-24/sol-outcomes-final-acceptance.md`

Only that report was written. No tests, checks, builds, runtime actions or delegation were performed. Root owns integration verification; this is not full core exit.ACCEPT for the bounded source correction at frozen SHA `773ac63866473f036988c8d60fa453969e4e7e95`, compared with `1b2b16f8891375f59d148bc95aaa744fa511a6d8`.

The exact diff changes only the recovery error message and removes its unused local projector-name list. No logic, type, policy or storage changes are present.

The prior blocker is resolved. The message now:

- Removes the unsafe clear/reset recipe.
- Explicitly states there is no automated or verified repair.
- Requires stopping the application and backing up the database, event store and attachments before manual action.
- Requires a separately validated coordinated rebuild procedure and warns that deletion or cursor resets must not be assumed safe.
- Confirms no automatic reset occurred.

The previously accepted coupled-cursor invariant assessment stands.

Compatibility limitation remains: startup refusal involving older pre-v3.5.34 databases/runtime-items migration state is not fixed here, and no upgrade or recovery path has been validated. Previously disclosed historical-identity and unknown/provenance limitations also remain.

Working tree was clean. No files changed, tests/checks/builds/installs, process actions, commits, pushes or delegation were performed. This is not whole-app, core-exit or live-upgrade acceptance.The new frozen HEAD is `5d91f949ab2d99f7cc88da8a4d399e5831d3b064`, with a clean working tree. I’ll review the guard-scope change and both upgrade fixtures, then trace dependencies to assess whether the narrower guard is safe. The prior acceptance does not carry forward automatically.The empty-table fixture is present, but I found a concrete replay-window issue: bootstrap starts at the lowest cursor while `readFromSequence` defaults to 1,000 events. A runtime-items cursor at zero can exhaust that window before replay reaches a coupled-projector tail above sequence 1,000. This is separate from the disclosed revert and summary-refresh limitations.FIX at frozen SHA `5d91f949ab2d99f7cc88da8a4d399e5831d3b064`, reviewed against `773ac63866473f036988c8d60fa453969e4e7e95`.

### Blocking finding: legacy catch-up can exhaust bootstrap’s replay window

Location: `apps/server/src/orchestration/Layers/ProjectionPipeline.ts:1927-1928`.

Bootstrap now starts from the minimum cursor across all projectors, but calls `readFromSequence(replayFrom)` without a limit. That API emits at most **1,000 events**, not the whole remaining history (`apps/server/src/persistence/Layers/OrchestrationEventStore.ts:67,211-260`).

Concrete newly accepted shape:

- sessions and turns at sequence 1,500;
- threads at 1,499, a permitted partial interruption;
- legacy runtime-items cursor absent/zero.

The guard accepts this. Replay reads sequences 1–1,000, applies none of the coupled group’s outstanding tail, then reports success. Engine startup proceeds immediately after bootstrap (`apps/server/src/orchestration/Layers/OrchestrationEngine.ts:356-359`). A subsequent live projection can advance cursors past the skipped events without applying them.

Even with the coupled group fully current, runtime-item observations or closures beyond event 1,000 remain unreplayed.

The API cap predates this commit. The new compatibility path exposes it because a distant unrelated cursor now determines the shared replay starting point. This is distinct from the disclosed derived-view limitations.

Required bounded correction: consume the complete bootstrap catch-up through the existing paginated reader, without its default total-event cap. Extend the existing regression beyond 1,000 events, including runtime-item evidence beyond the boundary and a supported coupled partial tail.

### What the correction does support

- Migration 040 creates the runtime-items table without a projection cursor; missing cursor correctly resolves to zero.
- The narrower guard preserves ordered lockstep/one-event admission for sessions, turns and threads, and still refuses unsupported coupled skew before writes.
- The new **12-event** fixture covers retained rows and fixture-empty runtime-item rows, comparing runtime-item identity/state, session, turns, latest pointer, pending start and settlements.
- Runtime-items-only replay does not write turn/session/pending/settlement rows or trigger attachment cleanup. I found no additional outcome-admission dependency requiring runtime-items to join that coupled guard.

### Remaining limits

- Runtime-item revert catch-up reads current/final turn rows rather than historical turn evidence.
- Runtime-items-only catch-up does not refresh existing shell summaries; those refresh on a later applicable thread event.
- Those are pre-existing derived-view limitations, not new findings against this delta.
- The fixtures simulate the upgrade shape; they do not establish universal older-profile, migration-history or live-upgrade compatibility. Previous historical-identity and unknown/provenance limits remain.

No files changed and no tests, builds, installs, provider/process operations or delegation were performed. The reported 33 pipeline and 30 related test passes are implementer evidence. This is not whole-app or core-exit acceptance.
