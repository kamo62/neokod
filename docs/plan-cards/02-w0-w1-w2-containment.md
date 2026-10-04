# S2 cards: W0 0.5, W1 1.9 to 1.15, W2 2.2 to 2.6c

Base commit da7655bb2, branch fix/symphony-runner-and-config-wip. Cards H0 and 1.1 to 1.8 are in S1-w1-runner-1.md and are not repeated here.

## Plan corrections found while reading the code

- 0.5: `effect_sql_migrations` has the columns `migration_id`, `created_at`, `name`, and the Migrator keeps only `id <= latest` out of the run (it never compares names or gaps). The check is a pre-step in `runMigrations`, reusing `MigrationError` kind `BadState`, so no layer types change.
- 1.9: the child-pid recording that the plan asks for already exists (`setClaimOwnerPid`) but is dead code: the Dispatcher reads `agent.pid()` before the lazy spawn, so it is always null. The fix is a spawn callback, not a new repository method. The contract also declares `ownerPgid` and `ownerBirthToken` that nothing persists (see Unverified).
- 1.10: `acquireLock` is not re-entrant, so "retry the lock each tick" needs a holds-lock ref and `renewLock` for a current leader. Followers also ran recovery at construction; that call moves behind the gate. The role is surfaced as one optional contract field on the overview.
- 1.11: no schema column, contract field or migration is needed (`base_branch` and `WorkItem.baseBranch` exist). Two defects hid the fix: the poll upsert overwrites `base_branch` on every poll, and `Projection.ts` stores the tracker's branch name as the base branch (and `Projection.test.ts` pins that).
- 1.12: the check runs only for items with a tracker id and not for `changes_requested` review continuations. An existing test (`pause-1`) dispatches an issue that is ineligible by label and needs its config adjusted.
- 1.14: `resolveSpawnCommand` needs no change. The fail-open path is `Live.ts` catching resolution errors into an empty list; the fix is a `null` sentinel that makes the runtime refuse to spawn. The server's own push goes through `Evidence/PullRequest.ts` with the server environment, so scrubbing the child does not break delivery.
- 1.15: `Config.ts` has no warning channel, so the `app-server` warning is logged from `Live.ts` with a pure helper in `Config.ts`.
- 2.2: the revert folder is the provider session `cwd` (not `resolveThreadWorkspaceCwd`). The busy check uses provider sessions with status `running` or `connecting`.
- 2.3: the plan says "treat a running binding as interrupted". The state written is session `interrupted` plus binding `error` with an `orphan_possible` outcome of reason `host_lost`, not `stopped`, because a child process may survive the crash (state-and-evidence principle 4).
- 2.5: all three approval checkboxes are inert, not two. `docs/architecture/symphony.md:46-51` already says so.
- 2.6a: the guard is aggregate identity only; the receipts table has no command type to compare.
- 2.6b/2.6c: split into 2.6b-i (shared worker), 2.6b-ii (Manager) and 2.6c (byte cap), each one commit.

---

### 0.5 (M1) Refuse to start when the recorded migration history does not match the repo

- Problem: `Migrator.make({})` (`apps/server/src/persistence/Migrations.ts:125`) records rows in `effect_sql_migrations` with columns `migration_id integer PRIMARY KEY`, `created_at datetime`, `name VARCHAR(255)` (`.repos/effect-smol/packages/effect/src/unstable/sql/Migrator.ts:180-184`, sqlite `orElse` branch). Its `run` reads only the latest `migration_id` and skips every loader entry with `id <= latest` (`Migrator.ts:285-287`); it never compares names and never looks at gaps. A real database holding 40 `SymphonyOwnerProcessGroup` and 41 `ProjectionRuntimeItems` therefore skipped this repo's 040 `ProjectionRuntimeItems` and 041 `SymphonyProjects`. `runMigrations` is called once at startup from `apps/server/src/persistence/Layers/Sqlite.ts:39` (the `setup` layer, so every `makeSqlitePersistenceLive` and `SqlitePersistenceMemory` goes through it).
- Files to change:
  - `apps/server/src/persistence/Migrations.ts` : new `MIGRATIONS_TABLE`, `findMigrationIdentityProblems`, `verifyMigrationIdentity`; call from `runMigrations` (line 141) before `run(...)` (line 149); add `import * as SqlClient from "effect/unstable/sql/SqlClient";`
  - `apps/server/src/persistence/Migrations.test.ts` : new
- Change:
  1. Reuse the existing error type, no new error class and no change to the layer error types: `Migrator.MigrationError` already is in the error channel of `runMigrations` (`MigrationError | SqlError`) and its `kind` union contains `"BadState"` (`Migrator.ts:117-122`). Construct it as `new Migrator.MigrationError({ kind: "BadState", message })` (the `_tag` field is not passed, as in `Migrator.ts:275`).
  2. Add to `Migrations.ts` after `makeMigrationLoader`:

     ```ts
     /** Table name used by Migrator.make({}) when no `table` option is passed. */
     const MIGRATIONS_TABLE = "effect_sql_migrations";

     export interface AppliedMigration {
       readonly id: number;
       readonly name: string;
     }

     /** Pure comparison of the recorded history against this build. Returns one line per problem. */
     export const findMigrationIdentityProblems = (
       applied: ReadonlyArray<AppliedMigration>,
       entries: ReadonlyArray<readonly [number, string, unknown]> = migrationEntries,
       throughId?: number,
     ): ReadonlyArray<string> => {
       const repoNameById = new Map(entries.map(([id, name]) => [id, name] as const));
       const appliedIds = new Set(applied.map((row) => row.id));
       const problems: Array<string> = [];
       for (const row of applied) {
         const repoName = repoNameById.get(row.id);
         if (repoName === undefined) {
           problems.push(
             `id ${row.id}: the database records "${row.name}", this build has no migration with that id`,
           );
         } else if (repoName !== row.name) {
           problems.push(
             `id ${row.id}: the database records "${row.name}", this build has "${repoName}"`,
           );
         }
       }
       const latestApplied = applied.reduce((max, row) => Math.max(max, row.id), 0);
       const gapLimit =
         throughId === undefined ? latestApplied : Math.min(latestApplied, throughId);
       for (const [id, name] of entries) {
         if (id <= gapLimit && !appliedIds.has(id)) {
           problems.push(
             `id ${id}: this build has "${name}", the database has no record of it (it would be skipped)`,
           );
         }
       }
       return problems;
     };
     ```

     The unknown-id and name rules use the full entry list even when `throughId` is set, so a partial run on a database at a higher version still reports the real state. Only the gap rule is limited by `throughId` and by the latest applied id.

  3. Add the effect (sqlite only, which is the only dialect the server uses; `Sqlite.ts` loads node or bun sqlite clients):
     ```ts
     export const verifyMigrationIdentity = Effect.fn("verifyMigrationIdentity")(function* (
       throughId?: number,
     ) {
       const sql = yield* SqlClient.SqlClient;
       const tables = yield* sql<{ readonly name: string }>`
         SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${MIGRATIONS_TABLE}
       `;
       if (tables.length === 0) return; // fresh database, nothing recorded yet
       const rows = yield* sql<{ readonly id: number; readonly name: string }>`
         SELECT migration_id AS "id", name FROM effect_sql_migrations ORDER BY migration_id
       `;
       const problems = findMigrationIdentityProblems(
         rows.map((row) => ({ id: Number(row.id), name: row.name })),
         migrationEntries,
         throughId,
       );
       if (problems.length === 0) return;
       return yield* new Migrator.MigrationError({
         kind: "BadState",
         message: [
           "Neokod refused to start: the migration history recorded in this database does not match this build.",
           ...problems.slice(0, 20).map((problem) => `  - ${problem}`),
           ...(problems.length > 20 ? [`  - and ${problems.length - 20} more`] : []),
           "Migrations recorded under a different name or id were skipped or never run, so the schema can be incomplete. Neokod does not repair this automatically.",
           "To repair: stop Neokod, back up state.sqlite, state.sqlite-wal and state.sqlite-shm from the state directory (<home>/userdata, or <home>/dev for a dev build), then move those three files away and start again to create a fresh database. To keep the data, start the build that created this database instead.",
         ].join("\n"),
       });
     });
     ```
     Use the literal table name in the second query; the first query binds the constant as a parameter. Selecting `migration_id AS "id"` mirrors the aliasing used by the 041 test (no name transform is configured on `NodeSqliteClient`).
  4. In `runMigrations` (line 141), after the existing start `Effect.log` and before `const executedMigrations = yield* run(...)`, add `yield* verifyMigrationIdentity(toMigrationInclusive);`.
  5. Update the header comment of `runMigrations` ("then runs any migrations with ID greater than the latest recorded migration") to add: "First verifies that every recorded (id, name) pair matches this build and that no id at or below the latest recorded id is missing; otherwise fails with `MigrationError` kind `BadState`."

- Do not:
  - Do not rename or renumber any migration, and do not auto-repair (no UPDATE of names, no re-running skipped migrations). The schema effects of a skipped migration are not known to have happened.
  - Do not read the table through `Migrator` internals or pass a custom `table` option. `MIGRATIONS_TABLE` must stay the Migrator default.
  - Do not run the check inside the migrator's transaction or after `run`. After `run` the rows 40 and 41 would already be accepted.
  - Do not fail on a missing `effect_sql_migrations` table (a fresh database has none until `run` creates it).
- Tests (`apps/server/src/persistence/Migrations.test.ts`, new). A shared `it.layer` would reuse one in-memory database across tests, so use `it.effect` with a fresh database each time, copying imports from `Migrations/041_SymphonyProjects.test.ts:1-9`:
  ```ts
  const withMemoryDb = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    effect.pipe(Effect.provide(NodeSqliteClient.layerMemory()));
  ```
  - `describe("findMigrationIdentityProblems")` (pure, `it`): matching list gives `[]`; a swapped name at id 40 gives one line containing `id 40`, `"SymphonyOwnerProcessGroup"` and `"ProjectionRuntimeItems"`; an applied id 99 not in the repo gives one line containing `id 99`; applied `[1,2,4]` against entries `[1,2,3,4]` gives one line containing `id 3` and `skipped`; with `throughId` 2 and applied `[1,2]` against entries up to 4 gives `[]`.
  - `refuses a database whose migration 40 and 41 carry another branch's names` (the real incident): `yield* runMigrations({ toMigrationInclusive: 39 }); yield* sql\`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (40, 'SymphonyOwnerProcessGroup'), (41, 'ProjectionRuntimeItems')\`;`then`const error = yield\* Effect.flip(runMigrations());`Assert`error.\_tag === "MigrationError"`, `error.kind === "BadState"`, message contains `id 40`, `"SymphonyOwnerProcessGroup"`, `id 41`and`state.sqlite`. Then assert the schema was not touched: `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'symphony_projects'`returns`[]`. Fails on the base commit: `runMigrations()`succeeds and`symphony_projects`is not created, so`Effect.flip`returns the success value and the`\_tag` assertion fails.
  - `refuses an applied id this build does not have`: `yield* runMigrations(); INSERT INTO effect_sql_migrations (migration_id, name) VALUES (99, 'FromTheFuture')`; flip `runMigrations()`; message contains `id 99`. Fails at base (succeeds).
  - `refuses a gap below the latest applied id`: `yield* runMigrations(); DELETE FROM effect_sql_migrations WHERE migration_id = 40`; flip; message contains `id 40` and `skipped`. Fails at base.
  - `accepts a database that was migrated in two steps and a repeated run`: `runMigrations({ toMigrationInclusive: 40 })`, then `runMigrations()` returns `[[41, "SymphonyProjects"]]`, then `runMigrations()` again returns `[]`. Passes at base and guards against false refusals.
- Verify: from `apps/server`: `PATH=/var/folders/b6/87d2msqd6fdbtcddcw5k8gbw0000gn/T/opencode/node-v24.21.0-darwin-arm64/bin:$PATH pnpm exec vp test run src/persistence/Migrations.test.ts src/persistence/Migrations/041_SymphonyProjects.test.ts` (all pass; confirmed the command runs, 041 test passes at base). Then run the whole persistence folder `pnpm exec vp test run src/persistence` because every database test goes through the new check. `pnpm exec tsgo --noEmit` from `apps/server`; `vp check` from the repo root.
- Depends on: none. Effort: S. Commit message: `fix(persistence): refuse to start when recorded migration names or ids do not match the build`

---

### 1.9 (N8) Never store the server pid on a claim; record the child pid after spawn; skip the kill for the server's own pid

- Problem: `WorkItemRepository.claim` writes `ownerPid: process.pid` (`WorkItemRepository.ts:464`, SQL `owner_pid = ${request.ownerPid}` at line 307). `Recovery.terminateOrphanAgent` (`Recovery.ts:64-83`) probes the stored pid with `kill -0` and then runs `kill -15`. A claim therefore holds the server's own pid, and after a restart the stored value is the previous server's pid. In a container the new server often has the same pid (for example 1), so recovery signals itself, and a recycled pid can hit an unrelated process. The fix that was meant to replace the server pid exists but never runs: `Dispatcher.ts:291-301` reads `agent.pid()` right after `factory.make(config)`, but the Codex child is spawned lazily inside the first `runTurn` (`AgentRuntime.ts:139-166`, `activePid = Number(child.pid)` at line 166), so `pid()` is always `null` there and `setClaimOwnerPid` (`WorkItemRepository.ts:474-493`) is never called. No test calls `setClaimOwnerPid`.
- Seam chosen: the dispatcher owns the fence (`ownerToken`, `generation`), the runtime owns the child handle. The runtime gets an optional callback that the dispatcher supplies through the factory, called once right after the spawn. One call site, no change to `runTurn` input or to the three `runTurn` calls.
- Files to change:
  - `apps/server/src/symphony/Persistence/Layers/WorkItemRepository.ts` : `ClaimRequestSchema` (line 198-203, drop `ownerPid`), `claimRow` SQL (line 307, `owner_pid = NULL`), `claim` (line 464, drop `ownerPid: process.pid`)
  - `apps/server/src/symphony/Persistence/Services/WorkItemRepository.ts` : doc comment of `setClaimOwnerPid` (lines 74-79, says "the claim row starts with the server PID")
  - `apps/server/src/symphony/Runner/AgentRuntime.ts` : `AgentRuntimeDeps` (line 104), `spawnAppServer` after `activePid = Number(child.pid)` (line 166)
  - `apps/server/src/symphony/Runner/Dispatcher.ts` : `AgentRuntimeFactory` `make` type (lines 94-101), the `agent.pid()` block (lines 288-301)
  - `apps/server/src/symphony/Runner/Live.ts` : `make` (line 29) and the `makeCodexAgentRuntime({...})` deps (line 34)
  - `apps/server/src/symphony/Orchestrator/Recovery.ts` : `RecoveryDeps` (line 39), `terminateOrphanAgent` (line 64)
- Change:
  1. `WorkItemRepository.ts`: remove `ownerPid: Schema.Int` from `ClaimRequestSchema`; in `claimRow` replace `owner_pid = ${request.ownerPid},` with `owner_pid = NULL,`; in `claim` delete the `ownerPid: process.pid,` line. New claims then hold no pid until the child is known. Update the `setClaimOwnerPid` comment to "the claim row starts with no pid; once the agent child is spawned the dispatcher records the child's pid here".
  2. `AgentRuntime.ts`: add to `AgentRuntimeDeps`:
     ```ts
     /** Called once, right after the app-server child is spawned, with its pid. Failures are ignored. */
     readonly onChildSpawned?: (pid: number) => Effect.Effect<void>;
     ```
     In `spawnAppServer`, directly after `activePid = Number(child.pid);` add `if (deps.onChildSpawned !== undefined) { yield* deps.onChildSpawned(activePid).pipe(Effect.catch(() => Effect.void)); }`.
  3. `Dispatcher.ts` factory type:
     ```ts
     readonly make: (
       config: EffectiveWorkflowConfig,
       options?: { readonly onChildSpawned?: (pid: number) => Effect.Effect<void> },
     ) => Effect.Effect<AgentRuntimeService, never, Scope.Scope>;
     ```
     Replace lines 287-301 (`const agent = yield* factory.make(config);` plus the `agent.pid()` block and its comment) with:
     ```ts
     // The agent child is spawned lazily inside the first turn. Record its pid on the claim as soon as
     // it exists so recovery can find a surviving orphan after a crash. The claim stores no pid before that.
     const agent =
       yield *
       factory.make(config, {
         onChildSpawned: (pid) =>
           workItems.setClaimOwnerPid(workItemId, ownerToken, claimed.generation, pid).pipe(
             Effect.asVoid,
             Effect.catch(() => Effect.void),
           ),
       });
     ```
     Keep `AgentRuntimeService.pid` (still used by tests and diagnostics); do not remove it.
  4. `Live.ts`: change `const make = (config: EffectiveWorkflowConfig) =>` to `const make = (config: EffectiveWorkflowConfig, options?: { readonly onChildSpawned?: (pid: number) => Effect.Effect<void> }) =>` and add `...(options?.onChildSpawned !== undefined ? { onChildSpawned: options.onChildSpawned } : {}),` to the deps object passed to `makeCodexAgentRuntime`. (The repo uses conditional spreads for optional props, for example `AgentRuntime.ts:146`.)
  5. `Recovery.ts`: make the signal injectable and add the guards. Extract the existing `spawnSync` block into a named default and add a dep:
     ```ts
     /** Test seam. Default signals the real process (probe with kill -0, then SIGTERM). */
     readonly terminateProcess?: (pid: number) => Effect.Effect<void>;
     ```
     ```ts
     const signalProcess = (pid: number): Effect.Effect<void> =>
       Effect.tryPromise(() =>
         import("node:child_process").then(({ spawnSync }) => {
           const probe = spawnSync("kill", ["-0", String(pid)], { stdio: "ignore" });
           if (probe.status === 0) spawnSync("kill", ["-15", String(pid)], { stdio: "ignore" });
         }),
       ).pipe(Effect.catch(() => Effect.void));
     ```
     Change `terminateOrphanAgent(item)` to `terminateOrphanAgent(deps, item)` and its body to:
     ```ts
     const pid = item.ownerPid;
     // null: no child was ever recorded. process.pid: a claim written by an older build stored the server's
     // own pid, and after a restart (same pid in a container) signalling it would kill this server.
     // pid <= 1: never signal init.
     if (pid === null || pid === undefined || pid <= 1 || pid === process.pid) return;
     yield * (deps.terminateProcess ?? signalProcess)(pid);
     ```
     Update the stale comment block above it (it claims the pid "was recorded at spawn"): "The claim records the agent child pid (written by the dispatcher right after spawn). Claims written by older builds hold the old server pid; those are skipped only when equal to this process's pid."
  6. Fix the call at `Recovery.ts:188`: `yield* terminateOrphanAgent(deps, item);`.
- Do not:
  - Do not write the pid in `claim` from `process.pid` under another name, and do not record `process.pid` anywhere on the claim.
  - Do not make `onChildSpawned` fail the spawn or the run. A refused fence (`setClaimOwnerPid` returns `false`) is not an error.
  - Do not add a data migration in this card (see Open questions).
  - Do not change `reconcileStaleClaims` or `Reconciler.ts`; they never signal a pid (`grep ownerPid` shows only `Recovery.ts:66`).
- Tests:
  - `apps/server/src/symphony/Persistence/Layers/WorkItemRepository.test.ts`, in the first `layer(...)` block next to `"unfenced transition..."` (reuse the `seed` helper used there):
    - `claim does not store the server pid`: `id = yield* seed("workitem-claim-pid-1", "pid1")`; `{ workItem } = yield* repo.claim(id, "owner-a")`; `expect(workItem.ownerPid).toBeUndefined()` (`rowToWorkItem` omits a null pid, `WorkItemRepository.ts:134`). Fails at base (`process.pid`).
    - `setClaimOwnerPid records the pid only for the current owner and generation`: claim, then `setClaimOwnerPid(id, "owner-a", generation, 4321)` is `true` and `getById(id)` has `ownerPid` 4321; `setClaimOwnerPid(id, "owner-a", generation + 1, 9999)` is `false`; `setClaimOwnerPid(id, "other", generation, 9999)` is `false`; the stored pid is still 4321.
  - `apps/server/src/symphony/Orchestrator/Recovery.test.ts`: add a helper `runRecoveryWith = (terminateProcess) => Effect.gen(...)` copying `runRecovery` (lines 126-135) and passing `terminateProcess` in the deps. Seed the pid with SQL because `upsert` always writes a null pid: `const sql = yield* SqlClient.SqlClient; yield* sql\`UPDATE symphony_work_items SET owner_pid = ${pid} WHERE id = ${workItem.id}\`` (`import \* as SqlClient from "effect/unstable/sql/SqlClient";`, the client is provided by `SqlitePersistenceMemory`). Each test seeds workflow, a `running` item (`makeWorkItem`, ids `"3101"`to`"3103"`) and a `streaming_turn`attempt as at lines 175-180, runs recovery with`const killed: Array<number> = []; terminateProcess = (pid) => Effect.sync(() => { killed.push(pid); })`:
    - `signals a recorded orphan child pid`: pid `987654`; `killed` equals `[987654]` and the item is `retry_scheduled`. Fails at base (the dep is ignored, `killed` is `[]`).
    - `does not signal the server's own pid`: pid `process.pid`; `killed` equals `[]`; item still `retry_scheduled`. (At base this test would send a real SIGTERM to the vitest worker. Do not run it against the base commit; the two tests above and the claim test are the failing-at-base proof.)
    - `does not signal when no pid was recorded`: no UPDATE; `killed` equals `[]`.
  - `apps/server/src/symphony/Runner/Dispatcher.test.ts`: `records the agent child pid once it is spawned`: `layer(Layer.succeed(AgentRuntimeFactory, { make: (_config, options) => Effect.succeed({ runTurn: () => (options?.onChildSpawned?.(4321) ?? Effect.void).pipe(Effect.as({ turnId: "t1", threadId: "th1", completed: true })), interrupt: () => Effect.void, pid: () => Effect.succeed(null) } satisfies AgentRuntimeService) }))("Dispatcher child pid", ...)`; dispatch prepare mode like the test at line 258 (seed `"1030"`); `after = yield* workItems.getById(workItem.id)`; `after?.ownerPid` is `4321` (a `transition` to `ready_for_review` keeps the pid column, `transitionRow` at `WorkItemRepository.ts:318-352` does not touch it). Fails at base (`ownerPid` is `process.pid`).
  - Only if H0 (S1) has landed: in `AgentRuntime.test.ts` add `reports the child pid after spawn`: build `makeCodexAgentRuntime` through `makeFakeCodexRuntime` with `onChildSpawned` forwarded (add an optional `onChildSpawned` to `makeFakeCodexRuntime`'s input and `fakeCodexRuntimeFactory`'s `make`), run a turn, assert the callback received `4242`.
- Verify: from `apps/server`: `PATH=/var/folders/b6/87d2msqd6fdbtcddcw5k8gbw0000gn/T/opencode/node-v24.21.0-darwin-arm64/bin:$PATH pnpm exec vp test run src/symphony/Persistence/Layers/WorkItemRepository.test.ts src/symphony/Orchestrator/Recovery.test.ts src/symphony/Runner/Dispatcher.test.ts` all pass; `pnpm exec tsgo --noEmit`; `vp check` from the repo root.
- Depends on: none (H0 optional for the last test). Effort: S to M (six files, small edits). Commit message: `fix(symphony): record the agent child pid after spawn and never signal the server's own pid`

---

### 1.10 (N7) Gate recovery, reconcile and polling on holding the lock; retry the lock; show the role

- Problem: the orchestrator tries the advisory lock once at construction (`SymphonyOrchestratorLive.ts:872-876`, `acquiredLock`, lease `lockLeaseMs = 90_000`). A process that fails keeps `acquiredLock === false` for its whole life. The flag is read in only two places: `prepareDispatch` (line 1354) and the teardown/finalizer (line 1838). Everything else runs for a follower too: `scheduler` runs `runStartupRecovery` unconditionally (lines 826-855), and `runTick` polls, runs `reconcileStaleClaims` (line 726), `retrySweep` and `sweepExpiredApprovals`. A follower's recovery marks the leader's live attempts `interrupted` because the follower's own dispatcher reports `isAgentActive` false for them. The lock API is not re-entrant: `acquireLock` (`Persistence/Layers/OrchestratorStateRepository.ts:170-194`) updates the singleton row only when `lock_token IS NULL OR lock_expires_at IS NULL OR lock_expires_at < now`, so calling it again while holding it returns `false`; `renewLock` (lines 196-212) matches `lock_token = ownerToken` and returns whether it still owns it.
- Files to change:
  - `apps/server/src/symphony/Orchestrator/Layers/SymphonyOrchestratorLive.ts` : lock block (lines 866-876), `runTick` (line 688), `scheduler` (lines 826-863), `prepareDispatch` gate (line 1354), finalizer and renew fiber (lines 1834-1851), `getOverview` return object (lines 936-958)
  - `packages/contracts/src/symphony.ts` : `SymphonyOverviewSchema` (lines 818-835), one new optional field (schema only)
  - `apps/server/src/symphony/Orchestrator/Layers/SymphonyOrchestratorLive.test.ts`
- Change:
  1. Contract: add to `SymphonyOverviewSchema`, after `lastTrackerPollAt`: `orchestratorRole: Schema.optional(Schema.Literals(["leader", "follower"])),` with a comment "follower: another Neokod process holds the orchestrator lock on this database; this process only observes". Optional so existing clients and fixtures stay valid. No web change in this card.
  2. In `makeOrchestrator`, right after `acquiredLock` (line 874-876) add two refs. The first acquire attempt stays as it is and seeds the first ref:
     ```ts
     const holdsLockRef = yield * Ref.make(acquiredLock);
     const recoveredRef = yield * Ref.make(false);
     ```
     `runTick` and `scheduler` reference these inside effect bodies that run later, the same way `runTick` already references `retrySweep` (declared after it). If the linter reports use-before-define, move the lock block (lines 866-876 plus the two refs) up next to `stateRef` (line 578); it only needs `orchestratorState`, `Clock` and `process.pid`.
  3. Extract the existing recovery call (lines 826-855, from `const maybeOwnership` through the `.pipe(Effect.catch(() => Effect.void))`) unchanged into `const recoverStartup = Effect.gen(function* () { ... });` declared above `scheduler`. In `scheduler` delete it, leaving only the `runTick(true)` and the `Effect.repeat` (lines 859-863).
  4. Add the leadership helpers next to `recoverStartup`:

     ```ts
     /** Renew the lease. A refused renewal (another token owns the row) demotes this process.
      *  A SQL error leaves the role unchanged: the state is unknown, not lost. */
     const renewLeadership = Effect.fn("symphonyOrchestrator.renewLeadership")(function* () {
       if (!(yield* Ref.get(holdsLockRef))) return false;
       const renewed = yield* orchestratorState
         .renewLock({ ownerToken: lockToken, leaseMs: lockLeaseMs })
         .pipe(Effect.catch(() => Effect.succeed(true)));
       if (!renewed) {
         yield* Ref.set(holdsLockRef, false);
         yield* Ref.set(recoveredRef, false); // recovery runs again if the lock is ever regained
         yield* Effect.logWarning("symphony.orchestrator.leadership_lost", { lockToken });
       }
       return renewed;
     });

     /** True when this process may orchestrate on this tick. Retries the lock while a follower. */
     const ensureLeadership = Effect.fn("symphonyOrchestrator.ensureLeadership")(function* () {
       if (yield* Ref.get(holdsLockRef)) {
         if (!(yield* renewLeadership())) return false;
       } else {
         const acquired = yield* orchestratorState
           .acquireLock({ ownerToken: lockToken, leaseMs: lockLeaseMs })
           .pipe(Effect.catch(() => Effect.succeed(false)));
         if (!acquired) return false;
         yield* Ref.set(holdsLockRef, true);
         yield* Effect.logInfo("symphony.orchestrator.leadership_acquired", { lockToken });
       }
       if (!(yield* Ref.get(recoveredRef))) {
         yield* recoverStartup;
         yield* Ref.set(recoveredRef, true);
       }
       return true;
     });
     ```

     `lockToken` stays the per-launch token (it already carries `process.pid` and the start time, line 872); do not change it.

  5. `runTick` (line 688): make the first statement `if (!(yield* ensureLeadership())) { return; }`, before `reloadWorkflowFiles()`. A follower now neither reloads workflow files, polls, reconciles, sweeps retries or approvals, nor launches work. `refreshNow` (line 878, `runTick(true, false)`) goes through the same gate.
  6. `prepareDispatch` (line 1354): replace `if (!acquiredLock) { return null; }` with `if (!(yield* Ref.get(holdsLockRef))) { return null; }` (defence in depth for an explicit dispatch RPC on a follower). Update the comment above it.
  7. Teardown and renew fiber (lines 1834-1851): register the release unconditionally, because `releaseLock` is fenced on the token (`WHERE ... lock_token = ${ownerToken}`) and is a no-op for a follower: `yield* Effect.acquireRelease(Effect.void, () => orchestratorState.releaseLock(lockToken).pipe(Effect.catch(() => Effect.void)));`. Keep the 30 second renew fiber because a single tick can exceed the 5 second cadence, but call `renewLeadership()` from it so it also demotes: `Effect.repeat(renewLeadership().pipe(Effect.asVoid), Schedule.spaced("30 seconds"))`.
  8. `getOverview` (line 936): add `orchestratorRole: (yield* Ref.get(holdsLockRef)) ? "leader" : "follower",` to the returned object. Read the ref once into a local before the `return`.

- Do not:
  - Do not call `acquireLock` while holding the lock (it returns `false` and would look like a loss). The holds-lock ref decides which call to make.
  - Do not change the repository (`OrchestratorStateRepository`) or the lock column semantics; the existing tests at `OrchestratorStateRepository.test.ts` must pass untouched.
  - Do not stop in-flight dispatches when leadership is lost in this card (see Open questions). Do not add a UI for the role.
  - Do not gate read-only RPCs (`listQueue`, `getRun`, `getProjectBoard`); a follower keeps serving reads.
- Tests (`SymphonyOrchestratorLive.test.ts`). Add a new `layer("SymphonyOrchestrator leadership", (it) => ...)` block using the file's existing `layer` (line 351); each `layer(...)` block builds a fresh in-memory database and the layer's own orchestrator is instance A and holds the lock. Build instance B over the same database and repositories with a fresh memo map so it is not the memoized A: `const second = Context.get(yield* Layer.build(Layer.fresh(SymphonyOrchestratorLive)), SymphonyOrchestrator);` (`import * as Context from "effect/Context";`; `Layer.fresh` is `Layer.ts:2141`, and it is needed because `Layer.build` uses the current memo map, `Layer.ts:706-715`). Use `SqlClient.SqlClient` from the test context for raw SQL (`import * as SqlClient from "effect/unstable/sql/SqlClient"`). Helper `seedHeldRun(id)`: upsert a `lifecycle: "running"` work item with `claimedAt` (copy `makeWorkItem` from `Recovery.test.ts:55-75`, or the seeding in this file) and a `streaming_turn` attempt with `startedAt: yield* nowIso`.
  - `a second orchestrator on the same database is a follower and leaves the leader's runs alone`: `first = yield* SymphonyOrchestrator`; `(yield* first.getOverview()).orchestratorRole` is `"leader"`. `seedHeldRun("lead-1")` and `seedWorkflow("wf-lead-1", "/repo/lead-1")`; `pollCountsByRepository.clear()`. Build B, then let its forked scheduler start with `yield* Effect.repeat(Effect.yieldNow, { times: 20 })`; `(yield* second.getOverview()).orchestratorRole` is `"follower"`. `yield* second.refreshNow()`. Assert: the `lead-1` attempt is still `streaming_turn` with no `interrupted` event (`RunEventRepository.listForAttempt`), the item is still `running`, and `pollCountsByRepository.get("/repo/lead-1")` is `undefined`. Fails at base: B's construction runs `runStartupRecovery` (attempt becomes `interrupted`) and `refreshNow` polls.
  - `a follower takes the lock when the lease expires and then runs recovery`: continue in the same block with a new item `seedHeldRun("lead-2")`. `yield* sql\`UPDATE symphony_orchestrator_state SET lock_expires_at = '1969-01-01T00:00:00.000Z'\``; `yield* second.refreshNow()`; B's overview role is `"leader"`; the `lead-2`attempt is now`interrupted`(recovery ran once B became leader). Then`yield* first.refreshNow()`; A's role is `"follower"`(A's renew returned`false` because the token changed). Fails at base: no role field, B never acquires, and recovery ran at B's construction.
  - `a demoted process regains the lock on a later tick`: same block, after the previous test (A is a follower, B is the leader). Expire the lease again with the same `UPDATE`, then `yield* first.refreshNow()`; A's role is `"leader"`. `yield* second.refreshNow()`; B's role is `"follower"`. Use `refreshNow` and no `TestClock.adjust`, so the 5 second schedulers of A and B do not run and race for the lock. This proves a follower retries the lock on every tick (`refreshNow` runs the same `runTick`).
  - `OrchestratorStateRepository.test.ts` stays as is and is part of the verify command.
- Verify: from `apps/server`: `PATH=/var/folders/b6/87d2msqd6fdbtcddcw5k8gbw0000gn/T/opencode/node-v24.21.0-darwin-arm64/bin:$PATH pnpm exec vp test run src/symphony/Orchestrator/Layers/SymphonyOrchestratorLive.test.ts src/symphony/Persistence/Layers/OrchestratorStateRepository.test.ts src/symphony/Orchestrator/Recovery.test.ts`; `pnpm exec tsgo --noEmit` in `apps/server` and in `packages/contracts`; `vp check` from the repo root. Every existing orchestrator test must still pass unchanged because each block's orchestrator is the leader of its own fresh database.
- Depends on: none. It conflicts textually with card 1.8 (S1: `runTick`, `retrySweep`, `launchNextQueuedWork`); apply 1.8 first, then this card at its own line numbers. Effort: M. Commit message: `fix(symphony): gate recovery, reconcile and polling on the orchestrator lock and retry it each tick`

---

### 1.11 (N9) Persist the workspace base branch on the work item and stop taking it from the tracker

- Problem: `projectWorkItem` writes `baseBranch: issue.branchName` (`Orchestrator/Projection.ts:71`). `branchName` is the tracker's suggested working branch (Linear only; the GitHub, GitLab, Jira, Asana and Azure adapters hard-code `branchName: null`, for example `GitHubIssuesAdapter.ts:158`), and nothing ever uses it as a branch (`ensureWorkspace` is called without `trackerBranch`). `refreshPullRequest` (`SymphonyOrchestratorLive.ts:1634-1642`) and `approveMerge` (`:1726-1734`) return `false` when `item.baseBranch === undefined`, so for most trackers a PR can never be refreshed or approved. The real base branch is known at dispatch: `WorkspaceManager.ensureWorkspace` returns `baseBranch` (`Workspaces/Manager.ts:23`, computed at `:187-189` as the repository default branch with fallback `"main"`) and the Dispatcher passes it on to the finalizer (`Dispatcher.ts:381`, `:454`) but never stores it. A second defect would hide any fix: the re-poll path `updateRow` overwrites the column on every poll (`WorkItemRepository.ts:288`, `base_branch = ${row.baseBranch}`).
- Plan correction: the plan asks to "persist `workspace.baseBranch` on the item" and the task asked whether a schema column, contract field or migration is needed. None is. `symphony_work_items.base_branch` exists (`persistence/Migrations/035_SymphonyWorkItems.ts:58`), `WorkItem.baseBranch` exists (`packages/contracts/src/symphony.ts:474`), and `rowToWorkItem`/`workItemToRow` already map it (`WorkItemRepository.ts:121`, `:161`). The work is a fenced write at dispatch, a non-destructive upsert, and removing the wrong source.
- Files to change:
  - `apps/server/src/symphony/Persistence/Services/WorkItemRepository.ts` : new `setBaseBranch` in the shape (next to `setClaimOwnerPid`, line 80)
  - `apps/server/src/symphony/Persistence/Layers/WorkItemRepository.ts` : new `setBaseBranch` (next to `setClaimOwnerPid`, line 474) and its entry in the returned object (line 564); `updateRow` SQL (line 288)
  - `apps/server/src/symphony/Runner/Dispatcher.ts` : after the `workspace_created` event (line 283)
  - `apps/server/src/symphony/Orchestrator/Projection.ts` : remove line 71; add `resolveBaseBranch`
  - `apps/server/src/symphony/Orchestrator/Layers/SymphonyOrchestratorLive.ts` : `refreshPullRequest` (line 1634), `approveMerge` (line 1726), `refreshIssueSnapshot` (line 249)
  - tests: `Projection.test.ts`, `WorkItemRepository.test.ts`, `Dispatcher.test.ts`, `SymphonyOrchestratorLive.test.ts`
- Change:
  1. Service shape: add
     ```ts
     /** Record the base branch the run's workspace was created from. Fenced like setClaimOwnerPid. */
     readonly setBaseBranch: (id: WorkItemId, ownerToken: string, generation: number, baseBranch: string) => Effect.Effect<boolean, SymphonyPersistenceError>;
     ```
  2. Layer: implement with the same fence as `setClaimOwnerPid` (copy its structure, lines 474-493):
     ```ts
     UPDATE symphony_work_items SET base_branch = ${baseBranch}, updated_at = ${now}
     WHERE id = ${id} AND owner_token = ${ownerToken} AND generation = ${generation}
       AND lifecycle IN ('preparing', 'running', 'testing')
     RETURNING ${cols}
     ```
     mapped with `toBusyOrSqlError("WorkItemRepository.setBaseBranch")`, returning `row.length > 0`. Add `setBaseBranch,` to the returned object.
  3. `updateRow` (line 288): change to `base_branch = COALESCE(${row.baseBranch}, base_branch),`. A tracker re-poll builds its row without a base branch and must not erase the recorded one. `HandoffService.ts:536` still seeds `baseBranch` from the chat thread branch on insert and keeps working; the dispatch write below replaces that seed with the branch the worktree was actually created from.
  4. `Dispatcher.ts`: directly after `yield* appendEvent(runAttemptId, "workspace_created", {...});` (line 280-283) add
     ```ts
     // The finalizer and the merge gate need the branch the worktree was created from.
     yield *
       workItems
         .setBaseBranch(workItemId, ownerToken, claimed.generation, workspace.baseBranch)
         .pipe(Effect.catch(() => Effect.void));
     ```
     The `workspace` value is the `SymphonyWorkspace` already in scope (line 238).
  5. `Projection.ts`: delete the line `...(issue.branchName !== null ? { baseBranch: issue.branchName } : {}),` (line 71) and the words "baseBranch," in the comment above it (lines 64-67). Add and export:
     ```ts
     /** Base branch for PR lookups: the one recorded at dispatch, else the base branch of the stored PR evidence
      *  (items dispatched before the dispatch write existed). Undefined means unknown: callers must refuse. */
     export const resolveBaseBranch = (
       item: Pick<WorkItem, "baseBranch">,
       evidence: Pick<EvidenceBundle, "pullRequest"> | null,
     ): string | undefined => item.baseBranch ?? evidence?.pullRequest?.baseBranch;
     ```
     (`EvidenceBundle` is exported from `@neokod/contracts`, `symphony.ts:455`; import it as a type.)
  6. `SymphonyOrchestratorLive.ts`: in `refreshPullRequest`, move the `bundle` read (currently at line 1655, `evidenceRepository.getByWorkItem(id)`) above the config check and replace `const baseBranch = item.baseBranch;` (line 1634) with `const baseBranch = resolveBaseBranch(item, bundle);`. Keep the later `if (bundle === null) return false;`. In `approveMerge` (line 1726) replace `const baseBranch = item.baseBranch;` with
     ```ts
     const baseBranch = resolveBaseBranch(
       item,
       yield * evidenceRepository.getByWorkItem(id).pipe(Effect.catch(() => Effect.succeed(null))),
     );
     ```
     The existing later `storedEvidence` read (after the host refresh) stays, because the gate must use evidence read after the host refresh. Both functions still `return false` when `baseBranch === undefined`. Import `resolveBaseBranch` from `../Projection.ts` (the file already imports from it).
  7. `refreshIssueSnapshot` (line 249): change `branchName: item.baseBranch ?? null,` to `branchName: null,`. The base branch is not the tracker branch.
- Do not:
  - Do not add a migration or a contract field.
  - Do not default to `"main"` or to `item.workspaceKey` when the base branch is unknown. An unknown base branch must keep refusing the merge gate.
  - Do not change `workspace_path` handling in `updateRow` (same overwrite pattern, line 287, but out of scope here).
  - Do not make `setBaseBranch` unfenced; a stale dispatch must not write after the claim moved.
- Tests:
  - `Projection.test.ts`: change the two assertions at lines 55 and 65 from `toBe("fix-login")` to `toBeUndefined()` and rename the tests (`accumulates description, priority, and blocked onto one row` and `keeps priority and blocked when a description is present`); the third test (`omits absent fields`) stays. Add `resolveBaseBranch` cases: item value wins; falls back to `{ pullRequest: { baseBranch: "develop", ... } }`; `undefined` when both are absent. Fails at base: `run.baseBranch` is `"fix-login"`.
  - `WorkItemRepository.test.ts` (first `layer` block, reuse `seed`): `setBaseBranch records the branch for the current claim only`: seed, `claim(id, "owner-a")` gives `generation`; `setBaseBranch(id, "owner-a", generation, "develop")` is `true`; `getById(id)?.baseBranch` is `"develop"`; `setBaseBranch(id, "owner-a", generation + 1, "x")` is `false`. `a tracker re-poll keeps the recorded base branch`: after the above, `repo.upsert(yield* makeWorkItem(sameId, sameTrackerIssue, "queued"))` (a row with no `baseBranch`, like `"tracker re-discovery updates metadata..."` at line 188-ish) and `getById(id)?.baseBranch` is still `"develop"`. Fails at base (`setBaseBranch` does not exist; the upsert would also null it).
  - `Dispatcher.test.ts`: `records the workspace base branch on the work item`: inside the first layer block (`layer(scriptedFactory(scriptedAgent(true)))("Dispatcher prepare mode", ...)`, line 258) add a test seeded `"1031"` that dispatches like the first test and asserts `(yield* workItems.getById(workItem.id))?.baseBranch` is `"main"` (the fake workspace manager returns `baseBranch: "main"`, line 218). Fails at base (`undefined`).
  - `SymphonyOrchestratorLive.test.ts`: `approveMerge falls back to the stored PR evidence base branch for an item with none recorded`: copy the setup of the test at line 1298 (`approveMerge requires positive host-enriched evidence`) with new ids (`merge-legacy-1`, workflow `wf-merge-legacy-1`, repository `/repo/merge-legacy`), but upsert the work item WITHOUT `baseBranch` and keep `evidence.pullRequest.baseBranch: "m"`. After `setPullRequestRefresh` with all-positive evidence (`ciStatus: "success"`, `reviewState: "approved"`, `mergeable: "mergeable"`, `unresolvedComments: 0`), `approveMerge("merge-legacy-1")` is `true` and the lifecycle is `ready_to_merge`. Second test in the same block: `approveMerge refuses when neither the item nor the evidence records a base branch`: same seed but evidence whose `pullRequest` is `null`; result `false`. The first fails at base (`false`).
- Verify: from `apps/server`: `PATH=/var/folders/b6/87d2msqd6fdbtcddcw5k8gbw0000gn/T/opencode/node-v24.21.0-darwin-arm64/bin:$PATH pnpm exec vp test run src/symphony/Orchestrator/Projection.test.ts src/symphony/Persistence/Layers/WorkItemRepository.test.ts src/symphony/Runner/Dispatcher.test.ts src/symphony/Orchestrator/Layers/SymphonyOrchestratorLive.test.ts`; `pnpm exec tsgo --noEmit`; `vp check` from the repo root.
- Depends on: none (1.9 also touches `Dispatcher.ts` and `WorkItemRepository.ts`; apply in any order, the edits do not overlap). Effort: M. Commit message: `fix(symphony): record the workspace base branch at dispatch and use it for the merge gate`

---

### 1.12 (N11) Re-evaluate eligibility on the fresh issue before dispatch

- Problem: `prepareDispatch` (`SymphonyOrchestratorLive.ts:1350`) refreshes the issue from the tracker (`refreshIssueSnapshot`, line 1441, defined at line 222) but then only checks the stored `item.excluded === true || item.eligibilityReasons.length > 0` (line 1399). The stored reasons come from the last poll (`pollWorkflow` calls `evaluateEligibility`, lines 539-544). An issue that was closed, lost its required label or left the active states after the last poll is therefore dispatched with a fresh snapshot nobody evaluated.
- Details that shape the fix (all read):
  - Poll calls `evaluateEligibility({ config, issue, claimedIssueIds: new Set<string>(), dispatchPaused: false })` (`Eligibility.ts:31`). Claims and pauses are handled elsewhere in `prepareDispatch` (the DB claim and the pause checks at lines 1376-1395), so dispatch must pass the same two neutral values.
  - `refreshIssueSnapshot` has two branches. With a tracker id it returns the fresh issue or `null`. Without one it returns a synthetic snapshot with `state: "queued"` (line 241-256). `evaluateEligibility` on the synthetic one would always fail (`state_not_active:queued`), so the re-check applies only to items that have a tracker issue id.
  - A `changes_requested` item is moved back to `queued` earlier in `prepareDispatch` (lines 1364-1371) for a review continuation. Its tracker issue may legitimately sit in a review state that is not in `trackerActiveStates`, so it is exempt.
- Files to change:
  - `apps/server/src/symphony/Orchestrator/Layers/SymphonyOrchestratorLive.ts` : `prepareDispatch`, directly after the `refreshIssueSnapshot` null check (line 1441-1444)
  - `apps/server/src/symphony/Orchestrator/Layers/SymphonyOrchestratorLive.test.ts` : new tests, and one existing test's config (line 1075)
- Change:
  1. After `if (issue === null) { return null; }` add:
     ```ts
     // Re-check eligibility on the fresh issue: the stored reasons are from the last poll.
     // Items without a tracker id use a synthetic snapshot, and review continuations may sit in a
     // review state, so both keep the stored decision.
     const hasTrackerIssue = item.trackerIssueId !== undefined && item.trackerIssueId.length > 0;
     if (hasTrackerIssue && item.lifecycle !== "changes_requested") {
       const fresh = evaluateEligibility({
         config,
         issue,
         claimedIssueIds: new Set<string>(),
         dispatchPaused: false,
       });
       if (!fresh.eligible) {
         // Record why, so the queue explains it and the scheduler stops picking the item every tick.
         // A queued item goes back to `eligible`; other lifecycles keep theirs (the upsert only moves
         // draft, eligible and queued, see updateRow's CASE). Non-empty stored reasons make the
         // pre-check above refuse the item until a poll finds it eligible again.
         yield *
           workItems
             .upsert({
               ...item,
               lifecycle: item.lifecycle === "queued" ? "eligible" : item.lifecycle,
               eligibilityReasons: [...fresh.reasons],
             })
             .pipe(Effect.catch(() => Effect.void));
         yield *
           Effect.logInfo("symphony.dispatch.refused_ineligible", {
             workItemId: String(item.id),
             reasons: fresh.reasons,
           });
         return null;
       }
     }
     ```
     `item.lifecycle` is still the value read at the top of the function, so for the review continuation it is still `"changes_requested"` even though the row was moved to `queued`. `evaluateEligibility` is already imported in this file (used at line 539).
  2. Do not touch `refreshIssueSnapshot`, `Eligibility.ts` or the poll code.
- Do not:
  - Do not run the check on the synthetic snapshot branch (it would block every item without a tracker id, including the review tests at lines 1591-1720).
  - Do not clear stored reasons when the fresh result is eligible; polling owns that.
  - Do not pass `dispatchPaused: true` or a real claimed set; the pause and claim gates already exist in `prepareDispatch`.
  - Do not call a tracker write or change the tracker issue. This is a local decision.
- Tests (`SymphonyOrchestratorLive.test.ts`, in the block that already holds the `pause-1` test; the memory tracker holds issue `"1"` open and labelled, `"2"` closed, `"3"` open without the `agent-ready` label, see `memoryFactory` at line 217 and `makeConfig` at line 87). Use a distinct `projectId: SymphonyProjectId.make("stale-project")` for the new items because the unique key is (project, kind, tracker issue id) and `pause-1` already uses `"3"` under `TEST_PROJECT_ID`. Each test seeds a workflow with `yield* seedWorkflow("wf-stale-N", "/repo/stale-N", { autonomy: "execute" })`, upserts a `source: { kind: "manual" }` item with `workflowId`, `eligibilityReasons: []`, and calls `dispatchedIds.length = 0; yield* orchestrator.dispatchWorkItem(id)`:
  - `refuses a queued item whose tracker issue is closed`: `trackerIssueId: "2"`, `lifecycle: "queued"`. Assert `dispatchedIds` does not contain the id, lifecycle is `"eligible"`, and `eligibilityReasons.some((r) => r.startsWith("state_terminal:"))`. Fails at base (it is dispatched and left in `preparing`).
  - `refuses a queued item whose required label was removed`: `trackerIssueId: "3"`; reasons include `missing_label:agent-ready`; lifecycle `"eligible"`.
  - `keeps a retry_scheduled item and records the reasons`: `lifecycle: "retry_scheduled"`, `trackerIssueId: "2"`; not dispatched, lifecycle still `"retry_scheduled"`, reasons non-empty.
  - `does not re-check a review continuation`: `lifecycle: "changes_requested"`, `trackerIssueId: "2"`; it is dispatched (`dispatchedIds` contains it). If `buildReviewFeedback` needs stored evidence, seed it the way `seedReviewItem` does (line 1591).
  - Existing test to adapt: `pause-1` (line 1075-1113) dispatches tracker issue `"3"`, which is ineligible by label. Change its workflow config at line 1082 to `effectiveConfig: { ...makeConfig("/repo/pause"), autonomy: "execute", trackerRequiredLabels: [] }` so it still proves the pause gate. All other tests that expect a dispatch use issue `"1"`, a polled item, or no tracker id (checked with `grep dispatchedIds).toContain`: lines 585, 994, 1113, 1720).
- Verify: from `apps/server`: `PATH=/var/folders/b6/87d2msqd6fdbtcddcw5k8gbw0000gn/T/opencode/node-v24.21.0-darwin-arm64/bin:$PATH pnpm exec vp test run src/symphony/Orchestrator/Layers/SymphonyOrchestratorLive.test.ts src/symphony/Orchestrator/Eligibility.test.ts`; `pnpm exec tsgo --noEmit`; `vp check` from the repo root.
- Depends on: none. It edits `prepareDispatch`, as do cards 1.5 (S1, signature and guard) and 1.10; apply after 1.5. Effort: S. Commit message: `fix(symphony): re-run eligibility on the refreshed issue before dispatching`

---

### 1.13 (N12) An unrecognised heading must not erase the collected summary

- Problem: in `parseEvidenceFile` (`apps/server/src/symphony/Evidence/HandoffFile.ts:54`), every markdown heading runs
  ```ts
  current = headingToSection(heading); // null for an unknown heading
  sections.set(current ?? "summary", []); // line 77
  ```
  For an unknown heading (for example `## Validation` or `## Files changed`) `current` is `null`, so line 77 resets the `summary` section to `[]`. A file `# Implementation Summary ... ## Validation ... ## Risks` loses its summary. `Service.ts:91-92` then computes `hasSubstantiveEvidence = parsed.implementationSummary.trim().length > 0`, so `assess` (`Service.ts:197-208`) returns `insufficient` and merge approval refuses the evidence. The agent prompt only asks for four headings (`Runner/Prompt.ts:152`), but agents add others.
- Files to change:
  - `apps/server/src/symphony/Evidence/HandoffFile.ts` : heading branch, lines 75-79
  - `apps/server/src/symphony/Evidence/HandoffFile.test.ts` : new (no parser test file exists; the only coverage is `Service.test.ts:175` and `:235`, both through `assemble`)
  - `apps/server/src/symphony/Evidence/Service.test.ts` : one end-to-end assertion
- Change:
  1. Replace the heading branch (lines 75-79):
     ```ts
     if (heading !== null) {
       current = headingToSection(heading);
       // Only a recognised heading starts (and resets) a section. An unknown heading ends the current
       // section: its lines are skipped until the next recognised heading, and nothing collected so far is lost.
       if (current !== null) {
         sections.set(current, []);
       }
       continue;
     }
     ```
     Everything else in the function is unchanged; the later `if (current === null) { continue; }` already skips lines under an unknown heading.
  2. Duplicate recognised headings still reset their own section (existing behaviour, unchanged).
- Do not:
  - Do not change `headingToSection` or add new recognised headings.
  - Do not treat unknown headings as part of the summary (that would pull validation logs and file lists into `implementationSummary`).
  - Do not make a missing summary a hard error; the assessment logic stays as is.
- Tests:
  - `Evidence/HandoffFile.test.ts` (new, plain `it` from `@effect/vitest` like `Glob.test.ts:1`; import `parseEvidenceFile` from `./HandoffFile.ts`):
    - `keeps the summary when an unknown heading follows it`: input

      ```
      # Implementation Summary
      Added caching.

      ## Validation
      - ran npm test

      ## Risks
      - [high] cold start regression
      ```

      Assert `implementationSummary` is `"Added caching."`, `risks` equals `[{ severity: "high", text: "cold start regression", source: "agent" }]`, and `assumptions` is `[]`. Fails at base (`implementationSummary` is `""`).

    - `ignores bullets under an unknown heading`: add `## Files changed\n- a.ts` between the sections; `unresolved`, `assumptions` and `risks` do not contain `a.ts`. Passes at base and after (guards against the lines leaking into a section).
    - `an unknown heading before any known heading is harmless`: `# Handoff\n\n# Implementation Summary\nDone.`; summary is `"Done."`.
    - `parses the canonical shape` with the four headings (copy `EVIDENCE_FILE` from `Service.test.ts:112-122`); summary, assumptions, risks and unresolved all populated.

  - `Evidence/Service.test.ts`: `a handoff file with an extra heading still counts as substantive evidence`: copy the test at line 175 but pass `evidenceFileContent: "# Implementation Summary\nImplemented it.\n\n## Validation\n- ran tests\n"` with `validationResults: [{ command: "npm test", status: "passed", exitCode: 0 }]`; assert `bundle.overallAssessment` is `"ready_for_review"` and `bundle.implementationSummary` is `"Implemented it."`. Fails at base (`"insufficient"`).

- Verify: from `apps/server`: `PATH=/var/folders/b6/87d2msqd6fdbtcddcw5k8gbw0000gn/T/opencode/node-v24.21.0-darwin-arm64/bin:$PATH pnpm exec vp test run src/symphony/Evidence`; `pnpm exec tsgo --noEmit`; `vp check` from the repo root.
- Depends on: none. Effort: S. Commit message: `fix(symphony): keep the evidence summary when the handoff file has an unknown heading`

---

### 1.14 (S08) Agent child environment: no `extendEnv`, and fail closed when the secret list is unknown

- Problem:
  1. `spawnAppServer` (`AgentRuntime.ts:139-166`) builds `scrubbed = scrubEnvironment(deps.env, secretNames)` and passes it as `env`, but with `extendEnv: true` both to `resolveSpawnCommand` (line 148-151) and to `ChildProcess.make` (line 157). The Node spawner computes `options.extendEnv ? { ...globalThis.process.env, ...options.env } : options.env` (`.repos/effect-smol/packages/platform-node-shared/src/NodeChildProcessSpawner.ts:80-85`), so every name removed by the scrub is put back from the server's real `process.env`. The scrub never reaches the child. `scrubEnvironment` has unit tests (`AgentRuntime.scrub.test.ts:9-34`), but none looks at what the spawner receives.
  2. `Live.ts:35-38` does `Effect.map((adapter) => adapter.secretEnvironmentNames()), Effect.catch(() => Effect.succeed([]))`. If the tracker adapter cannot be resolved (tracker disabled in Settings, missing token, unsupported kind) the secret list is empty and the agent starts with an unfiltered environment: fail open. Items without a tracker id skip `refreshIssueSnapshot` (`SymphonyOrchestratorLive.ts:241-256`), so they reach `factory.make` without any earlier resolution check.
- What the Code-mode path does (the pattern to copy): `CodexSessionRuntime.ts:735-748` builds `env = { ...options.environment, CODEX_HOME }`, sets `extendEnv = options.environment === undefined`, and passes the same `{ env, extendEnv }` to `resolveSpawnCommand` and to `ChildProcess.make`. An explicit complete environment therefore means `extendEnv: false`. `opencodeRuntime.ts:337` does the same (`input.environment ? { env } : { extendEnv: true }`).
- `resolveSpawnCommand` (`packages/shared/src/shell.ts:575-600`) needs no change. On POSIX it returns before looking at the environment; on win32 it uses `options.env` alone when `extendEnv` is not true (`options.extendEnv ? { ...hostEnvironment, ...options.env } : options.env`). Passing `extendEnv: false` with a complete `env` is already supported.
- Files to change:
  - `apps/server/src/symphony/Runner/AgentRuntime.ts` : `AgentRuntimeDeps.secretEnvironmentNames` (line 110), `spawnAppServer` (lines 139-161)
  - `apps/server/src/symphony/Runner/Live.ts` : `make` (lines 29-38)
  - `apps/server/src/symphony/Runner/AgentRuntime.scrub.test.ts` : new tests
  - `apps/server/src/symphony/Runner/Live.test.ts` : new
- Change:
  1. `AgentRuntimeDeps`: change the field to `readonly secretEnvironmentNames?: ReadonlyArray<string> | null;` and extend its comment: "`undefined` means no secrets to remove (tests). `null` means the secret list could not be resolved: the runtime refuses to spawn, so no unscrubbed child starts."
  2. `spawnAppServer`: at the top of the generator add
     ```ts
     if (deps.secretEnvironmentNames === null) {
       return (
         yield *
         Effect.fail(
           new AgentRuntimeSpawnError(
             "tracker credentials could not be resolved, so the agent environment cannot be scrubbed; fix the tracker configuration and retry",
           ),
         )
       );
     }
     ```
     Then change both `extendEnv: true` to `extendEnv: false` (the one passed to `resolveSpawnCommand`, line 150, and the one in `ChildProcess.make`, line 157), and change `scrubEnvironment(deps.env, deps.secretEnvironmentNames ?? [])` so it type-checks with the narrowed value (after the `null` check the value is `ReadonlyArray<string> | undefined`, so `?? []` is still correct). `env` already contains the whole scrubbed parent environment plus `CODEX_HOME`, so nothing else changes. Add a short comment: "`env` is the complete child environment. `extendEnv: true` would merge `process.env` back in and undo the scrub."
  3. `Live.ts` `make`: keep the structure and change the failure branch:
     ```ts
     resolveTrackerAdapter(registry, enablement, config).pipe(
       Effect.map((adapter): ReadonlyArray<string> | null => adapter.secretEnvironmentNames()),
       // Unknown is not "none": a null list makes the runtime refuse to spawn (fail closed).
       Effect.tapError((cause) =>
         Effect.logWarning("symphony.agent.secret_names_unresolved", { cause: String(cause) }),
       ),
       Effect.catch(() => Effect.succeed(null as ReadonlyArray<string> | null)),
       Effect.flatMap((secretNames) => makeCodexAgentRuntime({ ..., secretEnvironmentNames: secretNames, ... })),
     ```
     Update the doc comment above `makeAgentRuntimeFactory` ("Any adapter that cannot be resolved contributes nothing rather than failing the dispatch") to say the opposite. A refused spawn surfaces as `AgentRuntimeSpawnError` from the first `runTurn`; `Dispatcher` maps it to `RunDispatchError`, `markFailed` category `agent`, which is retryable (`Retry.ts:19-27`), so the run retries after the operator fixes the tracker.
- What is preserved and what is lost (state this in the commit body):
  - Preserved: the full scrubbed `process.env` copy: `PATH`, `HOME`, `USER`, `SHELL`, `TMPDIR`, `LANG`, proxy variables, `CODEX_HOME` (set from `codexHomePath` when configured), and provider authentication such as `OPENAI_API_KEY` or Codex login state under `HOME`. Only the names returned by `adapter.secretEnvironmentNames()` are removed.
  - Names removed per adapter: Linear `LINEAR_API_KEY` plus the configured env name (`LinearAdapter.ts:264-269`); GitHub Projects always `GITHUB_PAT` and `GITHUB_TOKEN` (`GitHubProjectsAdapter.ts:246`); GitHub Issues only the configured `tracker.provider.tokenEnv` when no direct token is set (`GitHubIssuesAdapter.ts:315-316`, `tokenEnv` default is null, so by default nothing is removed); Jira, GitLab, Asana and Azure Boards their configured names.
  - Risk for agent-side `git push` and `gh`: the server does its own push and PR creation with the server's environment (`Evidence/PullRequest.ts:154`, `deps.git.pushCurrentBranch`), so the delivery path is not affected. An agent that runs `git push` or `gh` itself and relied on one of the removed variables (for example `GITHUB_TOKEN` with the GitHub Projects adapter, or `GH_TOKEN` when `tokenEnv: GH_TOKEN`) will lose that credential after this change. SSH keys, git credential helpers and `gh auth login` credentials stored under `HOME` keep working. This is the intended trade (SPEC 15.3).
- Do not:
  - Do not keep `extendEnv: true` and delete keys by setting them to `undefined` in `env`; the merge order `{ ...process.env, ...env }` makes an `undefined` value shadow the real one only on some platforms, and relying on that is fragile.
  - Do not add the removed names to `HostProcessEnvironment` or edit `resolveSpawnCommand`.
  - Do not fall back to a hard-coded list of secret names on failure; unknown must refuse, so the operator fixes the configuration.
  - Do not change `CodexSessionRuntime.ts` or `CodexProvider.ts` (Code mode, no tracker secrets).
- Tests:
  - `AgentRuntime.scrub.test.ts`, new `describe("agent child environment")`. Use a capturing spawner like `provider/opencodeRuntime.test.ts:60-96`: `ChildProcessSpawner.make((command) => Effect.sync(() => { captured.push(command as unknown as CapturedSpawn); }).pipe(Effect.andThen(Effect.die("captured"))))` with `CapturedSpawn = { options: { env?: Record<string, string | undefined>; extendEnv?: boolean } }`. The runtime is built with `makeCodexAgentRuntime({ codexCommand: "codex", codexHomePath: "/tmp/codex-home", env: { PATH: "/usr/bin", HOME: "/home/u", GH_TOKEN: "s3cret", KEEP: "k" }, secretEnvironmentNames: ["GH_TOKEN"], liveRequests: yield* makeLiveRequests }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner), Effect.provideService(HostProcessPlatform, "linux"))` (`HostProcessPlatform` from `@neokod/shared/hostProcess`, as card H0 does), and the spawn is triggered with `yield* Effect.exit(runtime.runTurn({} as never))` (the first statement of `runTurn` is the lazy initialize, which spawns before any input field is read). Add the helper `finalSpawnEnvironment = (options) => (options.extendEnv ? { ...process.env, ...options.env } : options.env)` in the test file, copying the documented merge rule of the Node spawner (`NodeChildProcessSpawner.ts:80-85`, `ChildProcess.ts:415-419`). Tests:
    - `the child receives the scrubbed environment and CODEX_HOME`: `process.env.NEOKOD_SCRUB_TEST_SECRET = "leak"` (restore in `Effect.ensuring`), pass `secretEnvironmentNames: ["GH_TOKEN", "NEOKOD_SCRUB_TEST_SECRET"]`. Assert `captured[0].options.extendEnv` is not `true`; `captured[0].options.env` deep equals `{ PATH: "/usr/bin", HOME: "/home/u", KEEP: "k", CODEX_HOME: "/tmp/codex-home" }`; `finalSpawnEnvironment(captured[0].options).NEOKOD_SCRUB_TEST_SECRET` is `undefined` and `.GH_TOKEN` is `undefined`; `.PATH` and `.HOME` are preserved. Fails at base: `extendEnv` is `true` and the final environment contains `leak`.
    - `refuses to spawn when the secret list is unresolved`: same runtime with `secretEnvironmentNames: null`; the `Exit` is a failure (`Exit.isFailure`) whose error is an `AgentRuntimeSpawnError` with a message containing `"cannot be scrubbed"`, and `captured` is empty. Fails at base (it spawns).
    - `no secrets means the whole environment is passed`: `secretEnvironmentNames: undefined`; `finalSpawnEnvironment(...)` has `KEEP: "k"` and `GH_TOKEN: "s3cret"` (documents that `undefined` means nothing to remove).
  - `Runner/Live.test.ts` (new): `fails closed when the tracker adapter cannot be resolved`. Build `AgentRuntimeFactoryLive` with `Layer.provide` of: `TrackerRegistryEmptyLive` (`Trackers/Registry.ts:71`, every `resolve` fails with unsupported kind), `Layer.succeed(TrackerEnablement, makeTrackerEnablement(() => Effect.succeed({})))` (`Orchestrator/TrackerEnablement.ts:56`), `LiveRequestsLive`, a stub `Layer.succeed(ApprovalService, {} as never)`, and the capturing spawner as `ChildProcessSpawner.ChildProcessSpawner`. Inside `Effect.scoped`, `factory = yield* AgentRuntimeFactory`, `runtime = yield* factory.make(config)` (config from `Dispatcher.test.ts:41-62` or the H0 `makeRunnerTestConfig`), `exit = yield* Effect.exit(runtime.runTurn({} as never))`; assert failure with `"cannot be scrubbed"` and `captured` empty. Fails at base (it spawns with an empty secret list).
- Verify: from `apps/server`: `PATH=/var/folders/b6/87d2msqd6fdbtcddcw5k8gbw0000gn/T/opencode/node-v24.21.0-darwin-arm64/bin:$PATH pnpm exec vp test run src/symphony/Runner/AgentRuntime.scrub.test.ts src/symphony/Runner/Live.test.ts src/symphony/Runner/Dispatcher.test.ts`; `pnpm exec tsgo --noEmit`; `vp check` from the repo root.
- Depends on: none technically. It edits `spawnAppServer`, as do 1.1 (S1, `layerChildProcess` options) and 1.9; apply after them and re-read the current lines. Effort: S. Commit message: `fix(symphony): stop re-merging process.env into the agent child and fail closed on unresolved secrets`

---

### 1.15 Model review timeout and a warning for a configured `app-server` command

- Problem:
  1. `SymphonyModelReviewer.review` calls `instance.textGeneration.generateCodeReview(...)` with no timeout (`ModelReviewer.ts:258-283`, inside `Effect.forEach(models, ..., { concurrency: 2 })`). A provider that never answers keeps the finalizer, and with it the dispatch and the work item claim, waiting forever.
  2. `AgentRuntime` spawns `<codex.command> app-server` itself (`AgentRuntime.ts:148` passes `["app-server"]`). A workflow that sets `codex.command: "codex app-server"` (read at `Workflow/Config.ts:231`, default at `:39`) produces the command `codex app-server` with an extra `app-server` argument, or an executable named `codex app-server` that cannot be resolved, so the first turn fails with a spawn error that does not say why. The config resolver only reports empty commands (`Config.ts:232-234`) and has no warning channel (`resolveEffectiveConfig` returns `{ config, errors }` only), so the warning is logged where the command is used, in `Live.ts:40`.
- Files to change:
  - `apps/server/src/symphony/Review/ModelReviewer.ts` : new constant, the `generateCodeReview` pipe (lines 258-283), imports
  - `apps/server/src/symphony/Review/ModelReviewer.test.ts` : new test
  - `apps/server/src/symphony/Workflow/Config.ts` : new exported helper `codexCommandWarning` next to `WORKFLOW_DEFAULTS`
  - `apps/server/src/symphony/Workflow/Config.test.ts` : helper test
  - `apps/server/src/symphony/Runner/Live.ts` : log the warning in `make` (line 29)
  - `apps/server/src/symphony/Runner/Live.test.ts` : warning test (the file is created by card 1.14; create it here if 1.14 has not landed)
- Change:
  1. `ModelReviewer.ts`: add `import * as Duration from "effect/Duration"; import * as Option from "effect/Option";` and
     ```ts
     /** Upper bound for one reviewer model. A provider that never answers must not hold the finalizer. */
     export const MODEL_REVIEW_TIMEOUT = Duration.minutes(10);
     ```
     Replace the `.pipe(Effect.map(...), Effect.catch(...))` that follows `generateCodeReview({...})` with:
     ```ts
     .pipe(
       Effect.timeoutOption(MODEL_REVIEW_TIMEOUT),
       Effect.map((generated) =>
         Option.isNone(generated)
           ? failureResult({
               model,
               provider: String(instance.instanceId),
               error: `Model review timed out after ${Duration.toMinutes(MODEL_REVIEW_TIMEOUT)} minutes.`,
               reviewedAt,
             })
           : normalizeCompletedResult({ instance, model, reviewedAt, generated: generated.value }),
       ),
       Effect.catch((cause) => /* unchanged */),
     )
     ```
     A timeout is a `failed` reviewer result, which `aggregateReview` (line 132) already counts as not approving, so `all-approve` stays unpassed and `any-approve` needs another approval (fail closed). `Effect.timeoutOption` interrupts the provider call.
  2. `Config.ts`: add below `WORKFLOW_DEFAULTS`:
     ```ts
     /** Neokod appends `app-server` to `codex.command` itself. Returns a message when the command already contains it. */
     export const codexCommandWarning = (command: string | undefined): string | null =>
       command !== undefined && command.trim().split(/\s+/).includes("app-server")
         ? `codex.command "${command}" already contains "app-server". Neokod appends it, so set codex.command to the executable only (for example "codex").`
         : null;
     ```
  3. `Live.ts` `make`: before `makeCodexAgentRuntime`, log it. Inside the existing `Effect.flatMap((secretNames) => ...)` wrap the runtime construction as
     ```ts
     (secretNames) =>
       Effect.gen(function* () {
         const warning = codexCommandWarning(config.codexCommand);
         if (warning !== null) {
           yield* Effect.logWarning("symphony.agent.codex_command_contains_app_server", { warning });
         }
         return yield* makeCodexAgentRuntime({ ...existing deps... }).pipe(/* existing mapError and provideService */);
       })
     ```
     (If card 1.14 has landed, the same `flatMap` already receives `secretNames` that may be `null`; keep that handling unchanged.) Import `codexCommandWarning` from `../Workflow/Config.ts`.
  4. Do not reject the command: this card only warns. See Open questions for promoting it to a validation error.
- Do not:
  - Do not add a configurable review timeout field to `EffectiveWorkflowConfigSchema` (contracts change, not asked).
  - Do not wrap the whole `Effect.forEach` in one timeout; the bound is per reviewer so one slow model does not discard the others.
  - Do not log from `resolveEffectiveConfig`; it runs on every workflow reload and would repeat the warning every poll.
  - Do not match `app-server` as a substring: a path such as `/opt/app-server-tools/codex` is valid. The helper splits on whitespace.
- Tests:
  - `ModelReviewer.test.ts`: `fails a reviewer that never answers and does not block the others`: `makeInstance({ id: "codex_review", models: ["slow-model"], review: () => Effect.never })` and a second instance with an approving review for `"fast-model"`; `fiber = yield* Effect.forkChild(runReview([slow, fast], makeConfig(["slow-model", "fast-model"], "any-approve")))`; `yield* TestClock.adjust("11 minutes")`; `result = yield* Fiber.join(fiber)` (`import * as TestClock from "effect/testing/TestClock"; import * as Fiber from "effect/Fiber";`). Assert the reviewer for `slow-model` has `status: "failed"` and `error` containing `"timed out"`, the other is `completed`, and `result?.passed` is `true` (any-approve). A second test with `makeConfig(["slow-model"], "all-approve")` gives `passed: false`. Fails at base (the fiber never completes, so the join hangs and the test times out).
  - `Config.test.ts`: `codexCommandWarning` returns `null` for `undefined`, `"codex"`, `"/opt/app-server-tools/codex"`, `"/usr/local/bin/codex --profile x"`; returns a string containing `"app-server"` for `"codex app-server"` and for `"  codex   app-server  "`.
  - `Live.test.ts`: `warns once per runtime when codex.command contains app-server`: capture logs with `Logger.make` and `Logger.layer([logger], { mergeWithExisting: false })` (pattern at `serverRuntimeState.test.ts:63-101`; messages are in `message`, annotations in `fiber.getRef(References.CurrentLogAnnotations)`). Build the factory as in card 1.14's Live test, call `factory.make({ ...config, codexCommand: "codex app-server" })` and assert one captured log whose message contains `"codex_command_contains_app_server"`; with `codexCommand: "codex"` no such log. Fails at base (no log).
- Verify: from `apps/server`: `PATH=/var/folders/b6/87d2msqd6fdbtcddcw5k8gbw0000gn/T/opencode/node-v24.21.0-darwin-arm64/bin:$PATH pnpm exec vp test run src/symphony/Review/ModelReviewer.test.ts src/symphony/Workflow/Config.test.ts src/symphony/Runner/Live.test.ts`; `pnpm exec tsgo --noEmit`; `vp check` from the repo root.
- Depends on: none (shares `Live.ts` and `Live.test.ts` with 1.14; apply after it). Effort: S. Commit message: `fix(symphony): bound model review time and warn when codex.command contains app-server`

---

### 2.2 (S05) Checkpoint revert: honest copy, a recovery ref before restoring, refuse a busy shared folder

- Problem:
  1. `handleRevertRequested` (`orchestration/Layers/CheckpointReactor.ts:715-847`) calls `checkpointStore.restoreCheckpoint({ cwd: sessionRuntime.value.cwd, ... })` (line 783). In `GitVcsDriver.checkpoints.restoreCheckpoint` (`vcs/GitVcsDriver.ts:868-895`) that runs `git restore --source <oid> --worktree --staged -- .`, then `git clean -fd -- .`, then `git reset --quiet -- .`. It rewrites every tracked file and deletes every untracked, non-ignored file under the folder, whoever changed it. Nothing saves the pre-revert state, so unsaved work is lost for good.
  2. The folder is the provider session's `cwd`. Threads share the project folder by default (`resolveThreadWorkspaceCwd`, `checkpointing/Utils.ts:13-27`: `thread.worktreePath ?? project.workspaceRoot`), so a revert in one thread rewrites files another thread's agent may be editing right now. Nothing checks that.
  3. The confirm text (`apps/web/src/components/ChatView.tsx:3966-3971`) says "discard newer messages and turn diffs in this thread" and "This action cannot be undone." It does not say that files are reset, that new files are deleted, or that other threads are affected.
- Facts used (read): `captureCheckpoint` (`GitVcsDriver.ts:774-858`) snapshots tracked and untracked non-ignored files with a temporary index and writes a hidden ref with `update-ref`; ignored files are neither captured nor cleaned. `ProviderSession` has `threadId`, optional `cwd` and `status` in `connecting | ready | running | error | closed` (`packages/contracts/src/provider.ts:26-45`); `connecting` is the starting state. `providerService.listSessions()` is already used by `resolveSessionRuntimeForThread` (line 140). Activities with `turnId: null` survive a revert (`ProjectionPipeline.ts:328-345`). Ref names cannot contain `:`, so the timestamp is epoch milliseconds, and the thread id is base64url encoded like `checkpointRefForThreadTurn` does (`Utils.ts:6-10`).
- Files to change:
  - `apps/server/src/checkpointing/Utils.ts` : new `RECOVERY_REFS_PREFIX`, `recoveryRefForThreadRevert`, `findActiveSessionsSharingCwd`
  - `apps/server/src/orchestration/Layers/CheckpointReactor.ts` : `handleRevertRequested` (between lines 770 and 783), new `appendRevertRecoveryActivity` next to `appendRevertFailureActivity` (line 94)
  - `apps/web/src/components/ChatView.logic.ts` : new `buildRevertCheckpointConfirmMessage`
  - `apps/web/src/components/ChatView.tsx` : `onRevertToTurnCount` (lines 3966-3972)
  - tests: `apps/server/src/checkpointing/Utils.test.ts` (new), `apps/server/src/orchestration/Layers/CheckpointReactor.test.ts`, `apps/web/src/components/ChatView.logic.test.ts`
- Change:
  1. `Utils.ts`:

     ```ts
     export const RECOVERY_REFS_PREFIX = "refs/neokod/recovery";

     /** Hidden ref that holds the workspace as it was just before a revert. `epochMillis` keeps the name valid for git. */
     export function recoveryRefForThreadRevert(
       threadId: ThreadId,
       epochMillis: number,
     ): CheckpointRef {
       return CheckpointRef.make(
         `${RECOVERY_REFS_PREFIX}/${Encoding.encodeBase64Url(threadId)}/${epochMillis}`,
       );
     }

     const trimTrailingSeparators = (value: string): string => value.replace(/[\\/]+$/, "");

     /** Threads, other than `threadId`, whose provider session is starting or running in `cwd`. */
     export function findActiveSessionsSharingCwd(input: {
       readonly threadId: ThreadId;
       readonly cwd: string;
       readonly sessions: ReadonlyArray<{
         readonly threadId: ThreadId;
         readonly cwd?: string | undefined;
         readonly status: string;
       }>;
     }): ReadonlyArray<ThreadId> {
       const target = trimTrailingSeparators(input.cwd);
       return input.sessions
         .filter(
           (session) =>
             session.threadId !== input.threadId &&
             (session.status === "running" || session.status === "connecting") &&
             session.cwd !== undefined &&
             trimTrailingSeparators(session.cwd) === target,
         )
         .map((session) => session.threadId);
     }
     ```

     The comparison does not resolve symlinks (see Unverified).

  2. `CheckpointReactor.ts`: add `appendRevertRecoveryActivity` (copy of `appendRevertFailureActivity`, lines 94-122) with `tone: "info"`, `kind: "checkpoint.revert.recovery-saved"`, `summary: "Files saved before revert"`, `payload: { turnCount, recoveryRef, cwd }`, `turnId: null`, `commandId: serverCommandId("checkpoint-revert-recovery")`. Its input is `{ threadId, turnCount, recoveryRef: CheckpointRef, cwd: string, createdAt: string }`.
  3. In `handleRevertRequested`, insert after the `!targetCheckpointRef` block (ends line 780) and before `const restored = ...` (line 783):
     ```ts
     const cwd = sessionRuntime.value.cwd;
     // 1. Refuse while another thread is starting or running a turn in the same folder.
     const sessions = yield * providerService.listSessions();
     const busyThreads = findActiveSessionsSharingCwd({
       threadId: event.payload.threadId,
       cwd,
       sessions,
     });
     if (busyThreads.length > 0) {
       yield *
         appendRevertFailureActivity({
           threadId: event.payload.threadId,
           turnCount: event.payload.turnCount,
           detail: `Revert refused: ${busyThreads.join(", ")} ${busyThreads.length === 1 ? "has" : "have"} an active session in the same folder (${cwd}). Wait for it to finish or interrupt it, then try again. Nothing was changed.`,
           createdAt: now,
         }).pipe(Effect.catch(() => Effect.void));
       return;
     }
     // 2. Save the current files to a hidden ref first. If that fails, change nothing.
     const recoveryRef = recoveryRefForThreadRevert(
       event.payload.threadId,
       yield * Clock.currentTimeMillis,
     );
     const saved =
       yield *
       checkpointStore.captureCheckpoint({ cwd, checkpointRef: recoveryRef }).pipe(
         Effect.as(true),
         Effect.catch((error) =>
           appendRevertFailureActivity({
             threadId: event.payload.threadId,
             turnCount: event.payload.turnCount,
             detail: `Revert refused: the current files could not be saved to a recovery ref, so nothing was changed. ${error.message}`,
             createdAt: now,
           }).pipe(
             Effect.catch(() => Effect.void),
             Effect.as(false),
           ),
         ),
       );
     if (!saved) {
       return;
     }
     yield *
       appendRevertRecoveryActivity({
         threadId: event.payload.threadId,
         turnCount: event.payload.turnCount,
         recoveryRef,
         cwd,
         createdAt: now,
       }).pipe(Effect.catch(() => Effect.void));
     ```
     Then keep `restoreCheckpoint({ cwd: sessionRuntime.value.cwd, ... })` as is (or use `cwd`). Imports: `Clock` from `effect/Clock`, `findActiveSessionsSharingCwd` and `recoveryRefForThreadRevert` from `../../checkpointing/Utils.ts` (the file already imports `resolveThreadWorkspaceCwd` from there, line 28).
  4. Recovery refs are never deleted by this change. `deleteCheckpointRefs` only receives stale `refs/neokod/checkpoints/...` refs (line 802-815).
  5. Web: in `ChatView.logic.ts` add
     ```ts
     export function buildRevertCheckpointConfirmMessage(turnCount: number): string {
       return [
         `Revert this thread to checkpoint ${turnCount}?`,
         "Files: the folder this thread works in is reset to how it was after that turn. Edited files go back, and files created later are deleted unless git ignores them. This covers every change made in that folder since then, including changes made by other threads or by you.",
         "Chat: newer messages and turn diffs in this thread are discarded and cannot be restored.",
         "Git history and branches are not changed. A snapshot of the current files is saved first under refs/neokod/recovery/ in the repository, so they can be recovered with git.",
       ].join("\n");
     }
     ```
     In `ChatView.tsx` replace the array passed to `localApi.dialogs.confirm` (lines 3966-3971) with `buildRevertCheckpointConfirmMessage(turnCount)` and add the import from `./ChatView.logic` (the file already imports from it).

- Do not:
  - Do not change `GitVcsDriver.restoreCheckpoint` (the restore semantics stay; only what happens around it changes) and do not use `git clean -x`.
  - Do not delete recovery refs automatically (see Open questions).
  - Do not run a real revert against any repository other than a temporary one in tests.
  - Do not block when the other thread's session is `ready`, `error` or `closed`; only `running` and `connecting` count.
  - Do not use an ISO timestamp in the ref name (`:` is invalid in git ref names).
- Tests:
  - `checkpointing/Utils.test.ts` (new, plain vitest like other server tests): `recoveryRefForThreadRevert(ThreadId.make("thread-1"), 1700000000000)` equals `refs/neokod/recovery/<base64url of thread-1>/1700000000000` (compute the middle with `Encoding.encodeBase64Url("thread-1")`). `findActiveSessionsSharingCwd`: returns `["thread-2"]` for a running session in the same cwd even with a trailing slash; `connecting` counts; `ready`, `error`, `closed` do not; a different cwd does not; the thread's own session is ignored; a session without `cwd` is ignored.
  - `CheckpointReactor.test.ts` (vitest, real temporary git repo from `createGitRepository`, line 209; no other repo is touched). Extend the harness: `createProviderServiceHarness(cwd, hasSession, sessionCwd, providerName, extraSessions: ReadonlyArray<ProviderSession> = [])` appends `extraSessions` to the array returned by `listSessions` (line 83-96), and `createHarness` gets `readonly otherSessions?: ReadonlyArray<{ readonly threadId: string; readonly status: ProviderSession["status"]; readonly cwd?: string }>` that maps to `extraSessions` with `cwd` defaulting to the repository `cwd`, `provider: ProviderDriverKind.make("codex")`, `runtimeMode: "full-access"`, `createdAt`/`updatedAt` as in the existing session. Add a local helper `revertToTurnOne(harness)` that runs the dispatches of the test at line 999-1064 (session set, two `thread.turn.diff.complete`, then `thread.checkpoint.revert` with `turnCount: 1`). Helper `listRecoveryRefs(cwd) = runGit(cwd, ["for-each-ref", "--format=%(refname)", "refs/neokod/recovery/"]).split("\n").filter(Boolean)`.
    - `saves the current files to a recovery ref before reverting`: `harness = await createHarness()`; after the seeds (README is `v3`), `NodeFS.writeFileSync(join(cwd, "README.md"), "v4-unsaved\n")` and `NodeFS.writeFileSync(join(cwd, "scratch.txt"), "mine\n")`; run `revertToTurnOne`; `await waitForEvent(harness.engine, (event) => event.type === "thread.reverted")`. Assert: README is `"v2\n"`, `scratch.txt` does not exist; `listRecoveryRefs(cwd)` has length 1 and starts with `refs/neokod/recovery/`; `gitShowFileAtRef(cwd, ref, "README.md")` is `"v4-unsaved\n"` and `gitShowFileAtRef(cwd, ref, "scratch.txt")` is `"mine\n"`; the thread has an activity with `kind: "checkpoint.revert.recovery-saved"` (use `waitForThread` with `entry.activities.some(...)`). Fails at base (no ref, no activity).
    - `refuses to revert while another thread is running in the same folder` (loop over `status` values `"running"` and `"connecting"`): `createHarness({ secondThreadSharingWorktree: true, otherSessions: [{ threadId: "thread-2", status }] })`; run `revertToTurnOne`; `await waitForThread(harness.readModel, (entry) => entry.activities.some((a) => a.kind === "checkpoint.revert.failed"))`; assert README is still `"v3\n"`, `harness.provider.rollbackConversation` was not called, `listRecoveryRefs(cwd)` is empty, and the thread still has 2 checkpoints (the diffs from the helper). Also assert the failure activity detail contains `"thread-2"` by reading the read model snapshot (`snapshot.threads.find(...).activities` has `payload.detail`; if the harness type for activities only exposes `kind`, widen the `waitForThread` type to include `payload`). Fails at base (the revert happens, README is `"v2\n"`).
    - `does not refuse for a ready session or for a running session in another folder`: two `otherSessions` (`ready` same cwd; `running` with `cwd: "/somewhere/else"`); the revert completes (`thread.reverted` event) and README is `"v2\n"`.
  - `ChatView.logic.test.ts`: `buildRevertCheckpointConfirmMessage(3)` contains `"checkpoint 3"`, `"deleted"`, `"other threads"`, `"refs/neokod/recovery/"`, and does not contain `"cannot be undone"`. Fails at base (function missing).
- Verify: from `apps/server`: `PATH=/var/folders/b6/87d2msqd6fdbtcddcw5k8gbw0000gn/T/opencode/node-v24.21.0-darwin-arm64/bin:$PATH pnpm exec vp test run src/checkpointing src/orchestration/Layers/CheckpointReactor.test.ts` and `pnpm exec tsgo --noEmit`. From `apps/web`: `pnpm exec vp test run --project unit src/components/ChatView.logic.test.ts` (the `--project unit` flag is needed; the run took about 40 seconds here because the web project transforms slowly) and `pnpm exec tsgo --noEmit`. From the repo root `vp check`.
- Depends on: none. Effort: M. Commit message: `fix(checkpoints): save a recovery ref before revert, refuse a busy shared folder and state what revert changes`

---

### 2.3 (S02 crash) Settle a thread whose provider binding was left `running` by a hard crash

- Problem: `planProviderSessionReconciliation` (`provider/Services/ProviderSessionReconciler.ts:114`) only settles a thread when its binding is `stopped` or `error`: `(binding.status !== "stopped" && binding.status !== "error") ||` returns `[]`. A graceful shutdown writes `stopped` (`ProviderService.ts:1080`), but after a hard crash the binding keeps the last status it had, `running` or `starting`. The thread's projected session stays `running` with its `activeTurnId`, so the thread shows a turn in progress forever. The reaper cannot help: `ProviderSessionReaper.ts:64` skips any binding whose thread has `session.activeTurnId != null`. The test `skips live, starting, unsettled, missing, and still-running bindings` (`ProviderSessionReconciler.test.ts:232-266`) pins the stuck behaviour for the `running` binding.
- What is knowable at boot (state this in the code comment, it follows `docs/architecture/state-and-evidence.md`, principle 4 and the fail-closed rule):
  - Known: `reconcile` runs once at startup (`serverRuntimeStartup.ts:353`). Provider sessions live in adapter memory (`ProviderService.listSessions`, `ProviderService.ts:1123-1156`, reads `adapter.listSessions()`), so every session of the previous server process is gone from this process. A thread whose projected session is `running` with an active turn, whose binding is `running` or `starting`, and which has no live session here cannot make progress through this server. The server that was tracking it no longer exists (the `host_lost` stop reason, `providerRuntime.ts:126-132`).
  - Not known: whether the turn finished before the crash, which files it changed, and whether its child process is still running. So the turn must not be marked `completed` or `error`, and the binding must not be marked `stopped` (that would claim a confirmed stop). The honest states are session `interrupted` and binding `error` with a persisted `orphan_possible` outcome of reason `host_lost`, the same pair `stopSession` writes for an unconfirmed stop (`ProviderService.ts:1078-1086`, `outcome.status === "stopped_confirmed" ? "stopped" : "error"`).
  - Not settled: a thread with no binding row at all keeps being skipped (no evidence about a provider), and a projected session in `starting` keeps being skipped (existing test). See Open questions.
- Files to change:
  - `apps/server/src/provider/Services/ProviderSessionReconciler.ts` : `ProviderSessionReconcileAction` (line 10), the binding check (lines 111-129), new exported constant
  - `apps/server/src/provider/Layers/ProviderSessionReconciler.ts` : `reconcile` (lines 24-58)
  - `apps/server/src/provider/Services/ProviderSessionReconciler.test.ts`
- Change:
  1. Planner module: add
     ```ts
     /** Shown on a thread whose provider session was lost with the server process. */
     export const HOST_LOST_SESSION_ERROR =
       "Neokod restarted while this turn was running. The turn's outcome is unknown and its process may still be running.";
     ```
     and add to `ProviderSessionReconcileAction` the optional field `readonly bindingSettlement?: "host_lost";`.
  2. Replace the binding check (lines 111-129). Keep the provider and instance mismatch rules, and split the status rule:
     ```ts
     const binding = bindingsByThreadId.get(thread.id);
     if (
       binding === undefined ||
       binding.provider !== session.providerName ||
       (session.providerInstanceId !== undefined &&
         binding.providerInstanceId !== undefined &&
         binding.providerInstanceId !== session.providerInstanceId)
     ) {
       return [];
     }
     if (binding.status === "stopped" || binding.status === "error") {
       return [
         { ...action, status: "interrupted", lastError: exactBindingError(binding, turn.turnId) },
       ];
     }
     // `running` or `starting` with no live session: the previous server process was lost.
     return [
       {
         ...action,
         status: "interrupted",
         lastError: HOST_LOST_SESSION_ERROR,
         bindingSettlement: "host_lost",
       },
     ];
     ```
     A binding with `status === undefined` (the field is optional, `ProviderSessionDirectory.ts:27`) takes the last branch; the persistence layer always fills it, so treat undefined like `running`.
  3. Layer (`reconcile`): inside the `for (const action of actions)` loop, before the `thread.session.set` dispatch, add
     ```ts
     if (action.bindingSettlement === "host_lost") {
       const binding = bindings.find((entry) => entry.threadId === action.threadId);
       if (binding !== undefined) {
         yield *
           directory
             .upsert({
               threadId: binding.threadId,
               provider: binding.provider,
               ...(binding.providerInstanceId !== undefined
                 ? { providerInstanceId: binding.providerInstanceId }
                 : {}),
               status: "error",
               runtimePayload: {
                 activeTurnId: null,
                 stopPhase: "settled",
                 stopOutcome: orphanPossible({
                   stoppedAt: DateTime.formatIso(yield * DateTime.now),
                   reason: "host_lost",
                 }),
               },
             })
             .pipe(
               Effect.catch((cause) =>
                 Effect.logWarning("provider.session.reconciliation-binding-failed", {
                   threadId: action.threadId,
                   cause,
                 }),
               ),
             );
       }
     }
     ```
     `orphanPossible` comes from `../providerStopOutcome.ts`. The binding is written first so a crash between the two writes is repaired by the next boot: the next run sees an `error` binding and the existing branch settles the thread. A failed binding write is logged and the thread is still settled, because the thread is what the user sees stuck.
  4. Add `host_lost` to the `provider.session.reconciliation-complete` log: `hostLostCount: actions.filter((a) => a.bindingSettlement === "host_lost").length`.
- Do not:
  - Do not mark the turn `completed` or `error` and do not set the binding to `stopped`.
  - Do not touch bindings of threads that are not in the plan (an idle `ready` thread also has a `running` binding, `toRuntimeStatus` maps `ready` to `running`, `ProviderService.ts:120-133`).
  - Do not change `ProviderSessionReaper`. After this change the thread has no active turn, so the reaper's normal idle path applies.
  - Do not read the live child pid or try to kill orphans here.
- Tests (`ProviderSessionReconciler.test.ts`, reuse `projected`, `stoppedBinding`, `providerSession`, `threadId`, `turnId`, `provider`, `providerInstanceId`):
  - Flip the existing test `skips live, starting, unsettled, missing, and still-running bindings`: rename it `skips live, starting, unsettled and missing bindings` and delete its last case (`bindings: [{ ...stoppedBinding(), status: "running" as const }]`, lines 255-259). The trailing assertion that a stopped binding still produces exactly one action stays.
  - New `plans a host_lost settlement for a running or starting binding with no live session`: for each `status` in `["running", "starting"]`, `planProviderSessionReconciliation({ projected: projected(), liveSessions: [], bindings: [{ ...stoppedBinding(), status }] })` deep equals `[{ threadId, turnId, providerName: provider, providerInstanceId, runtimeMode: "full-access", status: "interrupted", lastError: HOST_LOST_SESSION_ERROR, bindingSettlement: "host_lost" }]`. Fails at base (`[]`).
  - New `leaves a running binding alone while a live session exists`: same input with `liveSessions: [providerSession]` gives `[]`.
  - New `does not settle again once the thread session is interrupted`: `projected({ sessionStatus: "interrupted", activeTurnId: null })` with a `status: "error"` binding gives `[]`.
  - New `settles a crashed running binding in the right order` (Effect test copying the layer of the existing `dispatches terminal-turn settlement...` test at line 268, with `listBindings: () => Effect.succeed([{ ...stoppedBinding(), status: "running" as const }])`, a recording `upsert`, and `getSnapshot` replaced as in card 2.4): record events in one array. Assert the order `["binding", "session"]`, the upsert has `status: "error"`, `threadId`, and `runtimePayload` deep equal to `{ activeTurnId: null, stopPhase: "settled", stopOutcome: { status: "orphan_possible", stoppedAt: <string>, reason: "host_lost", knownExternalRunIds: [] } }`, and the dispatched command has `session.status` `"interrupted"`, `session.activeTurnId` `null` and `session.lastError` equal to `HOST_LOST_SESSION_ERROR`. Fails at base (no command, no upsert).
- Verify: from `apps/server`: `PATH=/var/folders/b6/87d2msqd6fdbtcddcw5k8gbw0000gn/T/opencode/node-v24.21.0-darwin-arm64/bin:$PATH pnpm exec vp test run src/provider/Services/ProviderSessionReconciler.test.ts src/provider/Layers/ProviderSessionReaper.test.ts src/provider/Layers/ProviderService.test.ts`; `pnpm exec tsgo --noEmit`; `vp check` from the repo root.
- Depends on: none (2.4 touches the same layer file; apply 2.4 first or merge carefully, they edit different lines). Effort: M. Commit message: `fix(provider): settle threads left running by a hard crash as interrupted with an orphan-possible binding`

---

### 2.4 (S10) Boot reconciliation reads the command read model, not the full snapshot

- Problem: `ProviderSessionReconciler` layer calls `projectionSnapshotQuery.getSnapshot()` (`provider/Layers/ProviderSessionReconciler.ts:26`). `getSnapshot` hydrates every message, activity and checkpoint of every thread at startup. The planner never reads them. `getCommandReadModel` (`orchestration/Services/ProjectionSnapshotQuery.ts:62-65`, implemented at `orchestration/Layers/ProjectionSnapshotQuery.ts:1233-1420`) returns the same thread rows with `messages: []`, `activities: []`, `checkpoints: []`.
- Fields the planner reads (verified in `planProviderSessionReconciliation`, `Services/ProviderSessionReconciler.ts:44-129`): `projected.threads[].id`; `.latestTurn.{turnId, state, completedAt}`; `.session.{status, activeTurnId, providerName, providerInstanceId, runtimeMode, lastError}`. The command read model fills `latestTurn` from `listLatestTurnRows` and `session` from `listThreadSessionRows` (`ProjectionSnapshotQuery.ts:1269-1276`, `:1346-1360`, `:1399-1409`), so all of them are present. The planner uses nothing else.
- Files to change:
  - `apps/server/src/provider/Layers/ProviderSessionReconciler.ts` : line 26
  - `apps/server/src/provider/Services/ProviderSessionReconciler.test.ts` : the layer stub (line 273-277)
  - `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.test.ts` : one parity test
- Change:
  1. Replace `projectionSnapshotQuery.getSnapshot()` with `projectionSnapshotQuery.getCommandReadModel()`. The result type is the same `OrchestrationReadModel`, so `planProviderSessionReconciliation` is untouched.
  2. In `ProviderSessionReconciler.test.ts` change the stub in `dispatches terminal-turn settlement as a thread.session.set command` to `{ getCommandReadModel: () => Effect.succeed(projected({ turnState: "interrupted" })), getSnapshot: () => Effect.die("getSnapshot must not be used by boot reconciliation") }`.
  3. Add a short comment above the call: "Boot reconciliation only needs thread, latest turn and session rows."
- Do not:
  - Do not add fields to `getCommandReadModel` for this card, and do not change the planner input type.
  - Do not call `getShellSnapshot`; it drops archived threads and does not carry `session.lastError` in the same shape.
- Tests:
  - `ProviderSessionReconciler.test.ts`: the stub above. The existing dispatch test now fails if `getSnapshot` is called. Fails at base (it dies in `getSnapshot`, which the layer still calls).
  - `ProjectionSnapshotQuery.test.ts`, inside the same `projectionSnapshotLayer(...)` block: `command read model carries the session and latest turn the boot reconciler reads`. Seed one project, one thread with `latest_turn_id = 'turn-running'`, a `projection_turns` row (`state 'running'`, `completed_at NULL`) and a `projection_thread_sessions` row (`status 'running'`, `provider_name 'codex'`, `runtime_mode 'full-access'`, `active_turn_id 'turn-running'`, `last_error 'boom'`) with the SQL shapes already used at lines 1161-1300 and 179-201, plus the `projection_state` rows from line 1281. Assert that for `thread-1`, `commandReadModel.threads[0]` and `fullSnapshot.threads[0]` agree on `id`, `latestTurn?.turnId`, `latestTurn?.state`, `latestTurn?.completedAt`, `session?.status`, `session?.activeTurnId`, `session?.providerName`, `session?.runtimeMode` and `session?.lastError` (use `assert.deepStrictEqual` on a picked object). This test passes at base and after; it pins the contract the reconciler now depends on.
- Verify: from `apps/server`: `PATH=/var/folders/b6/87d2msqd6fdbtcddcw5k8gbw0000gn/T/opencode/node-v24.21.0-darwin-arm64/bin:$PATH pnpm exec vp test run src/provider/Services/ProviderSessionReconciler.test.ts src/orchestration/Layers/ProjectionSnapshotQuery.test.ts`; `pnpm exec tsgo --noEmit`; `vp check` from the repo root. `src/server.test.ts` or other tests that stub `ProjectionSnapshotQuery` for startup should still pass; if one fails because its stub lacks `getCommandReadModel`, add that method to the stub.
- Depends on: none. Effort: S. Commit message: `perf(provider): use the command read model for boot session reconciliation`

---

### 2.5 (B2, S07) Remove the three approval checkboxes that no code reads

- Problem: `SymphonyProjectConfigurationForm.tsx:591-608` renders three checkboxes, "Approve before push", "Approve before PR" and "Approve before merge", bound to `approvalsBeforePush`, `approvalsBeforePullRequest` and `approvalsBeforeMerge`. `grep -rnE "approvalsBefore(Push|PullRequest|Merge)" apps packages` finds only the form defaults (`:170-172`), the config parser (`Workflow/Config.ts:345-347`), the project repository default (`Persistence/Layers/SymphonyProjectRepository.ts:156-158`), the copy into the effective config (`SymphonyOrchestratorLive.ts:161-163`) and the contract (`packages/contracts/src/symphony.ts:683-685`, `:758-760`). No code reads any of the three to make a decision. The server pushes and opens the PR unconditionally in `finalize` (`Evidence/PullRequest.ts:150-160`), and there is no code path that merges at all (`approveMerge` only moves the item to `ready_to_merge`, `SymphonyOrchestratorLive.ts:1803`). `docs/architecture/symphony.md:46-51` already says `approvals.before_*` do not enforce anything.
- Plan correction: the plan says two checkboxes do nothing. All three do nothing. "Approve before merge" looks enforced only because merge approval is always a human action.
- Cheapest honest fix: remove the controls and state the facts in one note. Keep the contract fields, the form defaults and the stored values untouched, so no migration, no schema change and no data loss. The three keys stay in `value`, so saving a project still round-trips them.
- Files to change:
  - `apps/web/src/components/symphony/SymphonyProjectConfigurationForm.tsx` : replace the grid at lines 591-608, add an exported `ApprovalSettingsNote`
  - `apps/web/src/components/symphony/SymphonyProjectConfigurationForm.test.tsx` : new render test (the existing `SymphonyProjectConfigurationForm.test.ts` is a pure-function file and stays as is)
- Change:
  1. Add above `SymphonyProjectConfigurationForm` (before line 254):
     ```tsx
     export function ApprovalSettingsNote() {
       return (
         <p className="text-xs text-muted-foreground">
           Pushing the branch and opening the pull request are not gated by an approval setting yet.
           Merging always needs your approval, and Neokod never merges on its own.
         </p>
       );
     }
     ```
  2. Replace the whole `<div className="grid gap-2 text-sm sm:grid-cols-3">...</div>` block (lines 591-608, from `<div className="grid gap-2 text-sm sm:grid-cols-3">` through its closing `</div>`) with `<ApprovalSettingsNote />`.
  3. Leave `defaultSymphonyProjectConfiguration` (lines 154-173) unchanged, including the three `approvals*` defaults.
- Do not:
  - Do not remove the contract fields or change their defaults; stored projects and the WORKFLOW.md path (`approvals.before_*`) still carry them.
  - Do not leave the checkboxes disabled "for later"; a disabled control still reads as a setting.
  - Do not add enforcement of push or PR approval in this card (that is a feature, see Open questions).
- Tests:
  - `SymphonyProjectConfigurationForm.test.tsx` (new, same style as `PullRequestPanel.test.tsx:1-5`: `renderToStaticMarkup` from `react-dom/server`, `describe`/`it`/`expect` from `vite-plus/test`): `renders the approval note and no approval checkboxes`: `html = renderToStaticMarkup(<ApprovalSettingsNote />)`; assert it contains `"not gated by an approval setting"` and `"never merges on its own"`. Add a source guard that proves the controls are gone without rendering the whole form: read the component source with `readFileSync(new URL("./SymphonyProjectConfigurationForm.tsx", import.meta.url), "utf8")` and assert it does not contain `"Approve before push"`, `"Approve before PR"` or `"Approve before merge"`. Fails at base (no `ApprovalSettingsNote` export, and the labels are present).
  - Existing `SymphonyProjectConfigurationForm.test.ts` keeps passing (the three keys still exist on `SymphonyProjectConfiguration`).
- Verify: from `apps/web`: `PATH=/var/folders/b6/87d2msqd6fdbtcddcw5k8gbw0000gn/T/opencode/node-v24.21.0-darwin-arm64/bin:$PATH pnpm exec vp test run --project unit src/components/symphony/SymphonyProjectConfigurationForm.test.tsx src/components/symphony/SymphonyProjectConfigurationForm.test.ts` (the `--project unit` flag is required; a single web file took about 40 seconds here) and `pnpm exec tsgo --noEmit`; from the repo root `vp check`.
- Depends on: none. Effort: S. Commit message: `fix(web): remove the approval checkboxes that no code enforces`

---

### 2.6a (S01) A reused command id must not return another aggregate's receipt

- Problem: `processEnvelope` (`orchestration/Layers/OrchestrationEngine.ts:138-150`) reads the receipt for `envelope.command.commandId` and returns `{ sequence: existingReceipt.value.resultSequence }` for an `accepted` one, or `OrchestrationCommandPreviouslyRejectedError` for a rejected one. It never compares the receipt's `aggregateKind` and `aggregateId` with the aggregate of the incoming command (`commandToAggregateRef`, line 59). A client that reuses a command id for another thread or project gets a success for work that never ran. The writes use `upsert` with `ON CONFLICT (command_id) DO UPDATE` (`persistence/Layers/OrchestrationCommandReceipts.ts:31-47`), so two writers that raced on the same id would overwrite each other's aggregate and status silently, and a rejected-receipt write (line 280) can replace an accepted one. Severity is low (every client mints a fresh UUID, plan section 3), so this card is a small guard, not a redesign.
- Files to change:
  - `apps/server/src/orchestration/Errors.ts` : new `OrchestrationCommandIdReusedError`, `OrchestrationDispatchError` union (line 82)
  - `apps/server/src/orchestration/Layers/OrchestrationEngine.ts` : imports (line 36-41), guard (line 48-51), receipt check (lines 138-150), accepted receipt write (line 190), failure handler (lines 265-293)
  - `apps/server/src/persistence/Services/OrchestrationCommandReceipts.ts` : `upsert` becomes `insert` (lines 36-48)
  - `apps/server/src/persistence/Layers/OrchestrationCommandReceipts.ts` : SQL (lines 17-47) and the method (lines 65-69)
  - tests: `orchestration/Layers/OrchestrationEngine.test.ts`, `persistence/Layers/OrchestrationCommandReceipts.test.ts` (new)
- Change:
  1. `Errors.ts`: add, following `OrchestrationCommandPreviouslyRejectedError` (lines 43-54):
     ```ts
     export class OrchestrationCommandIdReusedError extends Schema.TaggedErrorClass<OrchestrationCommandIdReusedError>()(
       "OrchestrationCommandIdReusedError",
       {
         commandId: Schema.String,
         detail: Schema.String,
         cause: Schema.optional(Schema.Defect()),
       },
     ) {
       override get message(): string {
         return `Command id reused (${this.commandId}): ${this.detail}`;
       }
     }
     ```
     and add `| OrchestrationCommandIdReusedError` to `OrchestrationDispatchError`. `ws.ts` wraps any engine error into `OrchestrationDispatchCommandError` using `cause.message` (`ws.ts:1307-1313`), so no contract change is needed.
  2. `OrchestrationEngine.ts`: import the new class, add `const isOrchestrationCommandIdReusedError = Schema.is(OrchestrationCommandIdReusedError);` next to the other two guards, and change the receipt block:
     ```ts
     if (Option.isSome(existingReceipt)) {
       const receipt = existingReceipt.value;
       if (
         receipt.aggregateKind !== aggregateRef.aggregateKind ||
         receipt.aggregateId !== aggregateRef.aggregateId
       ) {
         return (
           yield *
           new OrchestrationCommandIdReusedError({
             commandId: envelope.command.commandId,
             detail: `already used for ${receipt.aggregateKind} ${receipt.aggregateId}, not ${aggregateRef.aggregateKind} ${aggregateRef.aggregateId}`,
           })
         );
       }
       /* unchanged: accepted returns the stored sequence, rejected fails PreviouslyRejected */
     }
     ```
     The check runs before the status branches, so it covers both accepted and rejected receipts.
  3. In the failure handler (line 265) change the condition to `if (!isOrchestrationCommandPreviouslyRejectedError(error) && !isOrchestrationCommandIdReusedError(error)) {` so a reuse error does not run read-model reconciliation or write a rejected receipt (it is not an invariant error, so `isOrchestrationCommandInvariantError` at line 279 would not match anyway).
  4. Insert-or-fail. In the service shape rename `upsert` to `insert`, with the doc comment "Insert a command receipt. Fails when a receipt for the command id already exists; it never overwrites." In the layer, remove the `ON CONFLICT (command_id) DO UPDATE SET ...` clause so the statement is a plain `INSERT INTO orchestration_command_receipts (...) VALUES (...)`, rename `upsertReceiptRow` to `insertReceiptRow` and the method to `insert` with operation name `"OrchestrationCommandReceiptRepository.insert:query"`. A primary key conflict is a `SqlError` that `toPersistenceSqlError` already maps to `PersistenceSqlError`. In the engine, call sites at lines 190 and 280 change from `.upsert(` to `.insert(`. At line 190 the insert is inside `sql.withTransaction`, so a conflict rolls back the events appended in that command and the dispatch fails with the persistence error. At line 280 the existing `Effect.catch(() => Effect.void)` stays, so a conflicting rejected receipt is dropped instead of overwriting the first one.
  5. Update `docs`-style header of `persistence/Layers/OrchestrationCommandReceipts.ts` is not needed; the file has none.
- Do not:
  - Do not add `command_type` or a payload hash column in this card (needs a migration; see Open questions). The check is aggregate identity only.
  - Do not return the typed error as `OrchestrationCommandInvariantError`; invariant errors write a rejected receipt (line 279-292), which would collide with the original receipt.
  - Do not change `commandToAggregateRef` (line 59).
  - Do not delete the table's `PRIMARY KEY`; it is what makes `insert` fail on a duplicate.
- Tests:
  - `OrchestrationEngine.test.ts` (vitest style like `rejects duplicate thread creation`, line 1247; `createOrchestrationSystem` at line 49):
    - `rejects a command id that was already used for another aggregate`: `system = await createOrchestrationSystem()`; dispatch `project.create` with `commandId: CommandId.make("cmd-reused")` for `project-reuse-a`; then `error = await system.run(engine.dispatch({ type: "project.create", commandId: CommandId.make("cmd-reused"), projectId: asProjectId("project-reuse-b"), title: "B", workspaceRoot: "/tmp/project-reuse-b", defaultModelSelection: ..., createdAt }).pipe(Effect.flip))`; `expect(error._tag).toBe("OrchestrationCommandIdReusedError")`; `expect(error.message).toContain("project project-reuse-a")`; `readModel = await system.readModel()`; the projects list contains `project-reuse-a` and not `project-reuse-b`. Fails at base (the second dispatch succeeds with the first sequence and `flip` puts the success in the error channel, so the `_tag` assertion fails).
    - `returns the stored sequence for a retry of the same command on the same aggregate`: dispatch the same `project.create` (same command id and project id) twice; the two results have the same `sequence`, and the read model has exactly one such project. Passes at base and after; it guards the idempotent path.
  - `persistence/Layers/OrchestrationCommandReceipts.test.ts` (new; layer `OrchestrationCommandReceiptRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory))` like `OrchestratorStateRepository.test.ts:9-11`, `it.layer` from `@effect/vitest`): `insert keeps the first receipt and fails on a duplicate command id`: insert `{ commandId: "cmd-1", aggregateKind: "thread", aggregateId: "thread-a", acceptedAt, resultSequence: 1, status: "accepted", error: null }`; a second `insert` with `aggregateId: "thread-b"`, `resultSequence: 2` fails (`Effect.flip`, `_tag` is `"PersistenceSqlError"`); `getByCommandId` still returns `thread-a` and sequence 1. Fails at base (the method is named `upsert` and overwrites).
- Verify: from `apps/server`: `PATH=/var/folders/b6/87d2msqd6fdbtcddcw5k8gbw0000gn/T/opencode/node-v24.21.0-darwin-arm64/bin:$PATH pnpm exec vp test run src/orchestration/Layers/OrchestrationEngine.test.ts src/persistence/Layers/OrchestrationCommandReceipts.test.ts` and then the neighbours that build the engine: `src/orchestration/Layers/CheckpointReactor.test.ts src/orchestration/Layers/ProviderCommandReactor.test.ts`; `pnpm exec tsgo --noEmit`; `vp check` from the repo root. Also `grep -rn "\.upsert(" src/orchestration src/persistence/Layers/OrchestrationCommandReceipts.ts` must find no remaining receipt `upsert` call.
- Depends on: none. Effort: S. Commit message: `fix(orchestration): refuse a command id reused for another aggregate and stop overwriting receipts`

---

### 2.6b-i (S03, part 1) KeyedCoalescingWorker keeps a value whose processing failed

- Problem: `cleanupFailedKey` (`packages/shared/src/KeyedCoalescingWorker.ts:55-70`) only clears the key's active flag and re-queues the key when newer work is already waiting in `latestByKey`. The value that was being processed when `process` failed or died is not stored anywhere (`:94-103`, `processKey(item.key, item.value).pipe(Effect.catchCause(() => cleanupFailedKey(item.key)))`). So a failed unit of work is lost unless a newer value happens to arrive. The terminal history writer needs the failed snapshot retained (card 2.6b-ii). The worker has one other user, `terminal/Manager.ts:1352`, whose `process` currently catches every error, so nothing reaches `cleanupFailedKey` today; this card changes the shared worker first so the Manager can rely on it.
- Files to change:
  - `packages/shared/src/KeyedCoalescingWorker.ts` : state, `processKey` (line 38), take step (lines 72-95), `enqueue` unchanged, new `retryFailed`, interface (lines 17-20)
  - `packages/shared/src/KeyedCoalescingWorker.test.ts`
- Change:
  1. Add `readonly failedByKey: Map<K, V>;` to `KeyedCoalescingWorkerState` and `failedByKey: new Map()` to the initial `TxRef.make` state (line 33-37). Every `{ ...state, ... }` spread already keeps it.
  2. Retain on failure. Add
     ```ts
     const retainFailed = (key: K, value: V): Effect.Effect<void> =>
       TxRef.update(stateRef, (state) => {
         const failedByKey = new Map(state.failedByKey);
         const existing = failedByKey.get(key);
         failedByKey.set(key, existing === undefined ? value : options.merge(existing, value));
         return { ...state, failedByKey };
       }).pipe(Effect.tx);
     ```
     and in `processKey` change `options.process(key, value).pipe(Effect.flatMap(...))` to `options.process(key, value).pipe(Effect.tapCause(() => retainFailed(key, value)), Effect.flatMap(...))` (the existing flatMap body is unchanged). The `value` captured here is the exact value that failed, including values taken from `latestByKey` inside the recursion.
  3. Merge on the next take. In the take step (`TxRef.modify` at lines 74-91), after reading `value`, compute `const failed = state.failedByKey.get(key); const merged = failed === undefined ? value : options.merge(failed, value);`, delete `key` from a copy of `failedByKey`, and return `{ key, value: merged }` with the updated state. `merge(current, next)` keeps its meaning: the retained failed value is the older one, so the newer value wins in a "latest wins" merge such as the terminal's (`merge: (current, next) => ({ history: next.history, ... })`).
  4. `drainKey` stays as it is. A retained failed value is not pending work, so `drainKey` must not wait for it (it reads only `latestByKey`, `queuedKeys`, `activeKeys`).
  5. Add `retryFailed` to the interface and implementation:
     ```ts
     /** Re-run a value retained after a failure, once. No-op when nothing is retained or newer work is pending
      *  (the next take merges the retained value into that work). */
     readonly retryFailed: (key: K) => Effect.Effect<void>;
     ```
     ```ts
     const retryFailed: KeyedCoalescingWorker<K, V>["retryFailed"] = (key) =>
       TxRef.modify(stateRef, (state) => {
         const failed = state.failedByKey.get(key);
         if (
           failed === undefined ||
           state.latestByKey.has(key) ||
           state.queuedKeys.has(key) ||
           state.activeKeys.has(key)
         ) {
           return [false, state] as const;
         }
         const failedByKey = new Map(state.failedByKey);
         failedByKey.delete(key);
         const latestByKey = new Map(state.latestByKey);
         latestByKey.set(key, failed);
         const queuedKeys = new Set(state.queuedKeys);
         queuedKeys.add(key);
         return [true, { ...state, failedByKey, latestByKey, queuedKeys }] as const;
       }).pipe(
         Effect.flatMap((shouldOffer) => (shouldOffer ? TxQueue.offer(queue, key) : Effect.void)),
         Effect.tx,
         Effect.asVoid,
       );
     ```
     Return `{ enqueue, drainKey, retryFailed }`. Update the module header comment: "A value whose processing fails is retained per key and merged into the next work for that key, or retried with `retryFailed`; it is not dropped."
- Do not:
  - Do not re-queue a failed value automatically; a persistent failure would then spin. Retry happens on the next `enqueue` for the key or an explicit `retryFailed`.
  - Do not make `drainKey` wait for failed keys.
  - Do not change `merge` semantics or add a retry counter here; the caller owns bounded retry.
- Tests (`KeyedCoalescingWorker.test.ts`, same `it.live` plus `Effect.scoped` style as the existing two; keep them unchanged, they must still pass):
  - `retains a failed value and merges it into the next enqueue`: `merge: (current, next) => \`${current}+${next}\``; `process`pushes`value`to`processed`and fails with`"boom"`only for`"a"`. `yield* worker.enqueue("k", "a"); yield* worker.drainKey("k");`(must return, not hang);`yield* worker.enqueue("k", "b"); yield* worker.drainKey("k");` `processed`equals`["a", "a+b"]`. Fails at base (`["a", "b"]`).
  - `retryFailed reprocesses a retained value once`: process fails only on its first call. `enqueue("k", "a")`, `drainKey`, `retryFailed("k")`, `drainKey`: `processed` equals `["a", "a"]`; a second `retryFailed("k")` leaves it at length 2. Fails at base (`retryFailed` does not exist).
  - `retryFailed does nothing while newer work is pending`: first call fails; `enqueue("k","a")`, `drainKey`; hold the next call open with a `Deferred`, `enqueue("k","b")`, then `retryFailed("k")` while `b` is active; release; `processed` equals `["a", "a+b"]` (the retained value was merged by the take step, not run twice).
- Verify: from `packages/shared`: `PATH=/var/folders/b6/87d2msqd6fdbtcddcw5k8gbw0000gn/T/opencode/node-v24.21.0-darwin-arm64/bin:$PATH pnpm exec vp test run src/KeyedCoalescingWorker.test.ts` and `pnpm exec tsgo --noEmit`; from the repo root `vp check`; from `apps/server` `pnpm exec tsgo --noEmit` (the Manager's call site must still type-check).
- Depends on: none. Effort: S. Commit message: `fix(shared): keep a failed value in KeyedCoalescingWorker and add retryFailed`

---

### 2.6b-ii (S03, part 2) Terminal history: atomic write, bounded retry, retry on flush, compare the process object

- Problem:
  1. The persist worker (`terminal/Manager.ts:1352-1380`) writes with `fileSystem.writeFileString(historyPath(...), request.history)` (line 1370), which truncates and rewrites the file in place. A crash or a full disk in the middle leaves a truncated history. `apps/server/src/atomicWrite.ts` (`writeFileStringAtomically`: temp directory in the target directory, write, rename) already exists and is used by `serverSettings.ts:883`, `serverRuntimeState.ts:64`, `provider/providerStatusCache.ts:13`.
  2. The write error is swallowed with a warning (`Effect.catch((error) => Effect.logWarning(...))`, lines 1370-1377), so a failed write is dropped: no retry, and `flushPersist`/`persistHistory` (lines 1395-1412) return success. Only the final scrollback tail is at risk (plan: P3).
  3. Process identity is checked by pid alone: `enqueueProcessEvent` (`:421-436`, `session.pid !== expectedPid`), `drainProcessEvents` (`:1627-1634`, same test), and `checkSubprocessActivity` (`:2045`, `liveSession.value.pid !== terminalPid`). A stale callback from a previous process whose pid was reused by the new one is accepted as an event of the new process (for example a late `exit` marks the new session exited). The pty callbacks capture `processPid = ptyProcess.pid` (line 1873) and the session already holds the process object in `session.process` (line 1892).
- Files to change:
  - `apps/server/src/terminal/Manager.ts` : imports, options (line 1122-1140), constants (line 78), `persistWorker` (lines 1352-1380), `flushPersist` (line 1395), `enqueueProcessEvent` (line 421), `drainProcessEvents` (line 1627), the pty callbacks (lines 1873-1884), `checkSubprocessActivity` (lines 2012-2050)
  - `apps/server/src/terminal/Manager.test.ts`
- Change:
  1. Atomic write. Import `writeFileStringAtomically` from `../atomicWrite.ts`. In the persist worker replace the `fileSystem.writeFileString(...)` with
     ```ts
     writeFileStringAtomically({
       filePath: historyPath(threadId, terminalId),
       contents: request.history,
     }).pipe(
       Effect.provideService(FileSystem.FileSystem, fileSystem),
       Effect.provideService(Path.Path, path),
     );
     ```
     (`fileSystem` and `path` are captured at `makeWithOptions`, lines 1155-1156.)
  2. Bounded retry and failing visibly. Add the constant `const DEFAULT_PERSIST_RETRY_DELAY_MS = 100;` next to `DEFAULT_PERSIST_DEBOUNCE_MS` (line 78), the option `persistRetryDelayMs?: number;` to `TerminalManagerOptions` (test seam, like `processKillGraceMs`), `const persistRetryDelayMs = options.persistRetryDelayMs ?? DEFAULT_PERSIST_RETRY_DELAY_MS;`, and `const PERSIST_RETRY_TIMES = 2;` (three attempts in total). Import `* as Schedule from "effect/Schedule"` and `type * as PlatformError from "effect/PlatformError"`. The worker becomes
     ```ts
     const persistWorker = yield* makeKeyedCoalescingWorker<string, PersistHistoryRequest, PlatformError.PlatformError, never>({
       merge: /* unchanged */,
       process: Effect.fn("terminal.persistHistoryWorker")(function* (sessionKey, request) {
         if (!request.immediate) { yield* Effect.sleep(DEFAULT_PERSIST_DEBOUNCE_MS); }
         const [threadId, terminalId] = sessionKey.split("\u0000");
         if (!threadId || !terminalId) { return; }
         yield* writeFileStringAtomically({ /* step 1 */ }).pipe(
           Effect.provideService(FileSystem.FileSystem, fileSystem),
           Effect.provideService(Path.Path, path),
           Effect.retry({ times: PERSIST_RETRY_TIMES, schedule: Schedule.spaced(`${persistRetryDelayMs} millis`) }),
           Effect.tapError((error) => Effect.logWarning("failed to persist terminal history", { threadId, terminalId, attempts: PERSIST_RETRY_TIMES + 1, error })),
         );
       }),
     });
     ```
     The error is no longer swallowed: after the last attempt `process` fails and the worker (card 2.6b-i) retains the snapshot.
  3. Retry a retained failure when flushing. `flushPersist` becomes
     ```ts
     yield * persistWorker.retryFailed(toSessionKey(threadId, terminalId));
     yield * persistWorker.drainKey(toSessionKey(threadId, terminalId));
     ```
     Every close, restart and clear path already calls `persistHistory` (which enqueues a fresh snapshot, and a fresh enqueue supersedes any retained older snapshot through the merge) and then `flushPersist`; `retryFailed` additionally covers a flush with no newer snapshot, for example `close` after the output stopped. A retry that fails again is retained again and logged; flush callers never fail because of it.
  4. Compare the process object. Change the helpers to take the process object:
     - `enqueueProcessEvent(session, expectedProcess: PtyAdapter.PtyProcess, event)`: condition `!session.process || session.status !== "running" || session.process !== expectedProcess`.
     - `drainProcessEvents(session, expectedProcess: PtyAdapter.PtyProcess)`: condition `session.process !== expectedProcess || !session.process || session.status !== "running"`.
     - In `startSession`, `const processPid = ptyProcess.pid;` is still used for `session.pid = processPid` (line 1893); the callbacks pass `ptyProcess` (the local `ptyProcess` is assigned `spawnResult.process`, non-null inside this block, bind it to a `const spawned = spawnResult.process;` and use `spawned` in the closures and in `session.process = spawned`).
     - `checkSubprocessActivity`: capture `const terminalProcess = session.process;` next to `const terminalPid = session.pid;` (line 2014) and replace `liveSession.value.pid !== terminalPid` (line 2045) with `liveSession.value.process !== terminalProcess`. Keep `terminalPid` for the inspector call and the log fields.
- Do not:
  - Do not change `persistHistory`'s signature or make `close` fail on a history write failure.
  - Do not widen `TerminalHistoryError` (contracts) for this; the worker's error type is `PlatformError`.
  - Do not remove the `pid` fields from `TerminalSessionState`; snapshots and the subprocess inspector still use them.
  - Do not retry inside `writeFileStringAtomically` itself (it serves settings and status cache too).
- Tests (`Manager.test.ts`; the suite uses real time, `excludeTestServices: true` at line 273, and `FakePtyProcess`/`FakePtyAdapter` at lines 37-135; `createManager` at line 224). Add `persistRetryDelayMs` to `CreateManagerOptions` (line 207-220) and pass it through to `makeWithOptions` like `processKillGraceMs`. Add to `FakePtyAdapter` a constructor parameter `pids: ReadonlyArray<number> = []` used as `this.pids.shift() ?? this.nextPid++`, and to `FakePtyProcess` a constructor flag `leakListeners = false`; when true, `onData`/`onExit` also push the callback to `leakedExitListeners`/`leakedDataListeners` arrays and return a no-op disposer, plus methods `emitLeakedExit(event)`/`emitLeakedData(data)` that call the leaked callbacks. The adapter takes a `leakListeners` option and passes it to the processes.
  - Failure-injecting file system for the first three tests: a helper `withFlakyFileSystem(shouldFail: () => boolean, method: "writeFileString" | "rename")` that reads the real `FileSystem.FileSystem` from the context and provides `{ ...fileSystem, [method]: (...args) => (shouldFail() ? Effect.fail(PlatformError.systemError({ _tag: "PermissionDenied", module: "FileSystem", method, pathOrDescriptor: String(args[0]), description: "injected failure" })) : fileSystem[method](...args)) }`, the same pattern as `secrets/ServerSecretStore.test.ts:20-45`. In the test: `const real = yield* FileSystem.FileSystem;` build `flaky` from it and run `createManager(...)` with `Effect.provideService(FileSystem.FileSystem, flaky)` (the manager captures the file system when it is made, `Manager.ts:1155`); `PlatformError` is already imported in the test file (line 21).
  - `retries a failed history write and persists it` : fail the first two `writeFileString` calls (counter), `persistRetryDelayMs: 5`; `manager.open(openInput())`, `process.emitData("hello\n")`; `waitFor(read history file equals "hello\n")`. Fails at base (the first write fails once, is swallowed, and no later write happens, so `waitFor` times out).
  - `never leaves a partial history file when the final rename fails`: first let one write succeed (`emitData("one\n")`, `waitFor` file equals `"one\n"`), then make every `rename` fail and `emitData("two\n")`; wait until a counter shows the rename was attempted 3 times; read the history file: it is still exactly `"one\n"`. Fails at base (no rename is used, the file becomes `"one\ntwo\n"`).
  - `a close retries a retained failed write`: make every `writeFileString` fail while `emitData("x\n")` runs and until the attempt counter reaches 3; then flip the flag to succeed and `yield* manager.close({ threadId: "thread-1" })`; `manager.open(openInput())` returns `history` equal to `"x\n"`. (Passes after 2.6b-i and this card; at base the output is lost only if `close` did not re-persist, so this test guards the flush path and does not prove a base failure.)
  - `ignores a stale exit callback from a previous process with the same pid`: `ptyAdapter = new FakePtyAdapter("sync", { pids: [7000, 7000], leakListeners: true })`; `manager.open` then `manager.restart(restartInput())` (the second process gets pid 7000); `ptyAdapter.processes[0].emitLeakedExit({ exitCode: 1, signal: 0 })`; `yield* Effect.sleep("30 millis")`; the events list has no `exited` event and `(yield* manager.open(openInput())).status` is `"running"`. Fails at base (the stale exit passes the pid check and marks the new session exited).
  - The existing tests (`emits subprocess activity events when child-process state changes`, `preserves queued PTY output ordering through exit callbacks`, `scoped runtime shutdown stops active terminals cleanly`) must keep passing unchanged.
- Verify: from `apps/server`: `PATH=/var/folders/b6/87d2msqd6fdbtcddcw5k8gbw0000gn/T/opencode/node-v24.21.0-darwin-arm64/bin:$PATH pnpm exec vp test run src/terminal` and `pnpm exec tsgo --noEmit`; from the repo root `vp check`.
- Depends on: 2.6b-i. Effort: M. Commit message: `fix(terminal): write history atomically with bounded retry and compare the pty process object`

---

### 2.6c (F06) Cap terminal history by bytes so one newline-free line cannot grow without bound

- Problem: `capHistory` (`terminal/Manager.ts:855-866`) caps only the number of lines. A single line with no newline is one "line", so it is never truncated, and every output chunk re-splits and re-joins the whole history in `drainProcessEvents` (line 1661-1664, `capHistory(\`${session.history}${sanitized.visibleText}\`, historyLineLimit)`), which is quadratic in the line length. The plan measured a 3 MB single line taking 9.9 s to finish (RUN, headless Chromium). The same unbounded string is persisted (card 2.6b) and read back (`readHistory`, `:1435`and`:1475`).
- Files to change:
  - `apps/server/src/terminal/Manager.ts` : `capHistory` (line 855, also export it), constant (line 77), options (line 1122-1140), `historyLineLimit` binding (line 1165), the three call sites (lines 1435, 1475, 1661)
  - `apps/server/src/terminal/Manager.test.ts`
- Change:
  1. Add `const DEFAULT_HISTORY_BYTE_LIMIT = 1024 * 1024;` after `DEFAULT_HISTORY_LINE_LIMIT` (line 77), the option `historyByteLimit?: number;` in `TerminalManagerOptions`, and `const historyByteLimit = options.historyByteLimit ?? DEFAULT_HISTORY_BYTE_LIMIT;` next to `historyLineLimit` (line 1165).
  2. Replace `capHistory` with an exported version that applies the line cap first (existing logic) and then a UTF-8 byte tail cap:
     ```ts
     export function capHistory(history: string, maxLines: number, maxBytes: number): string {
       const lineCapped = capHistoryLines(history, maxLines); // the existing body, renamed
       // A UTF-16 code unit is at most 3 UTF-8 bytes, so this skips the encoding for normal sizes.
       if (lineCapped.length * 3 <= maxBytes) return lineCapped;
       const bytes = Buffer.from(lineCapped, "utf8");
       if (bytes.length <= maxBytes) return lineCapped;
       let start = bytes.length - maxBytes;
       // Do not start inside a multi-byte character: skip UTF-8 continuation bytes (10xxxxxx).
       while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
       return bytes.subarray(start).toString("utf8");
     }
     ```
     Keep the old line-count function as a private `capHistoryLines(history, maxLines)` containing the body that exists today (lines 855-866).
  3. Update the three call sites to `capHistory(x, historyLineLimit, historyByteLimit)`: `readHistory` (line 1435), the second read path (line 1475) and `drainProcessEvents` (line 1661-1664). For the two read paths the existing `if (capped !== raw) { rewrite }` logic then also trims an oversized file left by an older build.
- Do not:
  - Do not cap by `String.length` alone (the plan and the stored file are bytes), and do not cut inside a multi-byte sequence.
  - Do not cap the live wire output (`publishEvent` `data` chunks); only the retained history is capped.
  - Do not change `DEFAULT_HISTORY_LINE_LIMIT` or the sanitizer.
- Tests:
  - `Manager.test.ts` pure tests for the exported function (plain `it`, import `capHistory` from `./Manager.ts`): `capHistory("a".repeat(5000), 5, 1000)` has length 1000 and is all `a`; `capHistory("a".repeat(400) + "b".repeat(800), 5, 1000)` equals `"a".repeat(200) + "b".repeat(800)` (tail kept); `capHistory("é".repeat(2000), 5, 1001)` has 500 characters, all `é`, and `Buffer.byteLength` of 1000 (start moved past the continuation byte); a short string and a 3-line string under both limits are returned unchanged; line cap still applies (`capHistory("1\n2\n3\n4\n", 2, 1000)` equals `"3\n4\n"`). Fails at base (`capHistory` is not exported and takes two arguments).
  - `Manager.test.ts` Effect test `caps one newline-free line to the byte limit`: add `historyByteLimit?: number` to `CreateManagerOptions` and pass it through; `createManager(5, { historyByteLimit: 1000 })`; `manager.open`; `emitData("a".repeat(600))`, `emitData("b".repeat(600))`; `manager.close({ threadId: "thread-1" })`; `reopened = yield* manager.open(openInput())`; `reopened.history` has length 1000 and ends with `"b".repeat(600)`. Fails at base (length 1200).
- Verify: from `apps/server`: `PATH=/var/folders/b6/87d2msqd6fdbtcddcw5k8gbw0000gn/T/opencode/node-v24.21.0-darwin-arm64/bin:$PATH pnpm exec vp test run src/terminal` and `pnpm exec tsgo --noEmit`; from the repo root `vp check`. The 9.9 s figure is not re-measured by this card (see Unverified).
- Depends on: none (apply after 2.6b-ii if both are in flight, they touch neighbouring lines). Effort: S. Commit message: `fix(terminal): cap retained history by bytes as well as lines`

---

## Recommended commit order

Cards in W0 and W2 do not depend on the W1 runner cards in `S1-w1-runner-1.md`, so they can ship first. Each line is one commit.

1. 0.5 migration identity check (protects the database before anything else touches it)
2. 1.13 evidence parser keeps the summary (small, no dependencies)
3. 2.5 remove the inert approval checkboxes (web only)
4. 2.4 boot reconciliation reads the command read model
5. 2.3 settle threads left running by a hard crash (after 2.4, same layer file)
6. 2.6a command receipt aggregate check and insert-or-fail
7. 2.6b-i KeyedCoalescingWorker retains failed values
8. 2.6b-ii terminal history atomic write, retry, process identity (needs 2.6b-i)
9. 2.6c terminal history byte cap (after 2.6b-ii, neighbouring lines in `Manager.ts`)
10. 2.2 checkpoint revert copy, recovery ref and busy-folder refusal

Then, after S1 cards H0 and 1.1 to 1.8 have landed (the S1 order stays as written there):

11. 1.9 child pid on the claim (after S1 1.1; it edits `spawnAppServer`)
12. 1.11 persist the workspace base branch (any time after 1.9; both edit `Dispatcher.ts` and `WorkItemRepository.ts` on different lines)
13. 1.14 agent child environment and fail-closed secrets (after 1.9 and S1 1.1; edits `spawnAppServer` and `Live.ts`)
14. 1.15 model review timeout and `app-server` warning (after 1.14; shares `Live.ts` and `Live.test.ts`)
15. 1.10 orchestrator lock gating (after S1 1.8; edits `runTick`, `retrySweep` neighbours)
16. 1.12 eligibility re-check on the fresh issue (after S1 1.5; edits `prepareDispatch`)

Line numbers in each card are at base commit da7655bb2. Cards 1.9 to 1.15 touch files that S1 cards 1.1 to 1.8 also edit (`AgentRuntime.ts`, `Dispatcher.ts`, `SymphonyOrchestratorLive.ts`), so re-read the current lines before editing.

## Open questions

1. 0.5: repair of `~/.neokod/dev`. Plan section 8 item 1 still awaits a yes (archive and start fresh, or repair from the backup). The new check will refuse to start on that database until one of the two is done.
2. 1.9: older builds stored the server pid in `owner_pid` for claims that are still held at upgrade time. Recovery now skips a pid equal to this process, but an old pid that is dead and was recycled would still be probed and signalled once. Add a migration that sets `owner_pid` to NULL for held lifecycles? Recommendation: no, the exposure is one restart and the rows clear when released.
3. 1.10: when a leader loses the lock (a stalled process, a lease taken over) its in-flight dispatches keep running and the new leader's recovery will mark them interrupted. Should losing leadership call `dispatcher.stopAllRuns()`? Recommendation: yes, as a follow-up card. Also: should the web UI show the follower role (this card only adds the contract field)?
4. 1.11: items dispatched before this change have no stored base branch. The card falls back to the stored PR evidence; items with neither keep refusing the merge gate. `WorkspaceManager` falls back to `"main"` when default-branch detection fails (`Manager.ts:187-189`), and that guess is what gets stored. Acceptable?
5. 1.12: an ineligible `retry_scheduled` item stays parked in `retry_scheduled` with its reasons until a poll finds it eligible again, and an explicit user dispatch of an ineligible item is refused (as stored reasons already did). Should an explicit dispatch be allowed to override the tracker state?
6. 1.14: an unresolved tracker adapter now blocks the agent spawn, including for manual items that never needed the tracker. Alternative: scrub a fixed list of known secret names and continue. Which do you want? The change also removes credentials such as `GITHUB_TOKEN` (GitHub Projects adapter) from the agent's environment, so agent-side `gh` or HTTPS `git push` that relied on them stops working; SSH keys and stored `gh auth` credentials keep working.
7. 1.15: the review timeout is a fixed 10 minutes. Make it a workflow setting later? And should `codex.command` containing `app-server` become a validation error (it never works) instead of a warning?
8. 2.2: recovery refs are never pruned, so each revert leaves a hidden ref and its objects. Prune policy (keep the last N per thread, delete with the thread)? Should a revert also refuse when this thread's own session is running (the web already blocks it, the server does not)?
9. 2.3: a thread with no binding row, or a projected session in `starting`, still stays stuck after a crash. Settle those too? Also, `liveSessions` is per process, so a second Neokod server on the same state directory would mark the first server's running turns as interrupted at its boot. Is a second server on one state directory supported? If yes, 2.3 needs a liveness check first.
10. 2.5: do you want push and PR approvals enforced (a feature in the finalizer) instead of the settings being removed?
11. 2.6a: add `command_type` or a payload hash to the receipts table (needs a migration) to catch reuse of an id for a different command on the same aggregate?
12. 2.6b: a retained failed history write is retried on the next output, close, restart or clear, but not at server shutdown. Add a final flush to the manager's finalizer?
13. 2.6c: the 1 MiB history byte limit is a choice; the line limit is 5,000 lines.

## Unverified

- Commands actually run: one server test (`src/persistence/Migrations/041_SymphonyProjects.test.ts`, passes) and one web unit test (`pnpm exec vp test run --project unit src/components/ChatView.logic.test.ts`, passes in about 41 seconds; without `--project unit` the run was killed after 110 seconds). No card's new tests were run, nothing was typechecked.
- 1.10: that `Layer.build(Layer.fresh(SymphonyOrchestratorLive))` inside `it.layer` yields a second, independent orchestrator over the same repositories, and that `refreshNow` alone (no `TestClock.adjust`) keeps both schedulers idle, were inferred from `Layer.ts:706-715`, `:2141` and the existing tests that use `TestClock.adjust("5 seconds")`, not run.
- 1.9: the contract declares `ownerPgid` and `ownerBirthToken` (`packages/contracts/src/symphony.ts`, "Issue #101") but `WorkItemRepository` persists neither. Left alone.
- 1.12: whether `buildReviewFeedback` needs stored evidence for the `changes_requested` test was not checked.
- 1.14: the capture test relies on `runTurn({} as never)` reaching the spawn before any input field is read. At base the first statement of `runTurn` is the lazy initialize (`AgentRuntime.ts:190`); S1 card 1.4 adds code after it, so recheck.
- 2.2: same-folder detection compares `session.cwd` strings after trimming trailing separators; symlinked paths to one folder are not unified. That adapters report `connecting` for a starting session was taken from the `ProviderSession` schema (`provider.ts:26-32`), not from adapter code.
- 2.3: that `directory.upsert` with `status: "error"` and the payload shape `{ activeTurnId, stopPhase, stopOutcome }` round-trips through `ProviderSessionRuntimeRepository` was inferred from `ProviderService.ts:1078-1086`, not run.
- 2.4: other server tests that stub `ProjectionSnapshotQuery` for startup may lack `getCommandReadModel` and need it added.
- 2.6b: `writeFileStringAtomically` creates a temporary directory inside the terminal logs directory for each write (`atomicWrite.ts:14-18`). `deleteAllHistoryForThread` removes entries by name prefix (`Manager.ts:1520-1545`), so a concurrent delete could remove a temp directory of a non-default terminal; the write then fails and is retried. Not tested.
- 2.6c: the 9.9 second figure for a 3 MB line is from the plan (RUN in a browser) and was not re-measured; the card bounds the work per chunk by the byte limit.
