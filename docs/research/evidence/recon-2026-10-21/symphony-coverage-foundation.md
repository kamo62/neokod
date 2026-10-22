# Symphony board coverage foundation (B-2 data layer, staged)

Branch `work/symphony-read-coverage`, based on `8c0fc44c8`. This is an independently staged B-2 data foundation, not whole B-2 and not Symphony delivery. The board projection is not yet wired to it, no UI was changed, and no layout or prototype was selected.

## Scope delivered

- Additive, optional board contracts in `packages/contracts/src/symphony.ts`: `SymphonyBoardColumnSchema.totalCount` and `SymphonyProjectBoardSchema.truncated`. Older payloads still decode without either field.
- `WorkItemRepositoryShape.listForBoard(projectId, { activeLimit, terminalLimit })` in `apps/server/src/symphony/Persistence/Services/WorkItemRepository.ts`.
- `listForBoard` in `apps/server/src/symphony/Persistence/Layers/WorkItemRepository.ts`:
  - one project-scoped snapshot using `sql.withTransaction`;
  - exact `GROUP BY lifecycle` counts for the whole project;
  - active rows (`draft` through `validation_failed`, excluding the three terminal lifecycles) ordered `created_at ASC, id ASC`;
  - terminal rows (`completed`, `cancelled`, `failed`) ordered `updated_at DESC, id DESC`;
  - both slices bounded by the caller's options, which must be positive integers;
  - decoded lifecycle totals and named-row failures.
- Shared local `decodeRows` helper now backs both `listByLifecycle` and `listForBoard`. A malformed work-item row fails with `SymphonyPersistenceDecodeError` naming the row and work-item id; it is never returned as an empty or partial success.
- `projectBoardFromWorkItems` in `apps/server/src/symphony/Orchestrator/ProjectBoard.ts` accepts optional `lifecycleTotals`. It sums canonical lifecycles into the existing five columns, sets `totalCount` per column, and sets `truncated` only when a total exceeds the returned cards. Without totals it omits both coverage fields; unavailable counts are never presented as complete coverage.
- Existing `listByLifecycle` ordering and default limit are unchanged. The only orchestrator change is the dispatch occupancy block in `SymphonyOrchestratorLive.ts`, which now refuses dispatch when occupancy cannot be decoded rather than treating it as zero.
- No migration, index, database schema, `ws.ts`, web, settings, Git or crash file was touched.

## Tests

- `WorkItemRepository.test.ts`: project isolation, active limit below the number of active rows (retained IDs plus totals for omitted rows), active ordering tie, terminal cutoff and ordering tie, exact totals, malformed JSON, and a syntactically valid `source_json = 'null'` failure.
- `ProjectBoard.test.ts`: totals/truncation regression, omission of coverage metadata when totals are unavailable, and decoding a legacy board payload with neither field.
- `SymphonyOrchestratorLive.test.ts`: corrupt active evidence refuses a dispatch instead of letting occupancy read as zero.

Commands run with Node `v24.22.1` from `/tmp/neokod-core-symphony-2026-10-21/node-v24.22.1-darwin-arm64/bin`:

- `apps/server`: `vp test run src/symphony/Persistence/Layers/WorkItemRepository.test.ts src/symphony/Orchestrator/ProjectBoard.test.ts` — 2 files, 30 tests passed.
- `apps/server`: `vp test run src/symphony/Orchestrator/Layers/SymphonyOrchestratorLive.test.ts` — 1 file, 47 tests passed.
- `packages/contracts`: `vp test run src/symphony.test.ts` — 1 file, 8 tests passed.
- `apps/server`: `tsgo --noEmit` — exit 0. Output contained existing Effect/tsgo suggestions elsewhere; no diagnostics in the changed files.
- `packages/contracts`: `tsgo --noEmit` — exit 0 with one pre-existing `Schema.Struct` suggestion in `src/symphony.ts`.
- Scoped `vp fmt --check`, `vp lint --report-unused-disable-directives` on the changed source/test files, and `git diff --check` — clean. Lint retains one pre-existing unused-variable warning in an unrelated Live test and the pre-existing contracts accessor-recursion warning.

The review regressions were run before the fixes and failed for the intended reasons: the null-source read returned success, the no-totals board reported `truncated: false`, and the corrupt-occupancy dispatch reached the dispatcher.

Not run, per the staged gate: root `vp check` / `vp run typecheck`, builds, packaging, installs, dependency or lockfile updates, app/Electron/Docker/browser launches, real provider prompts, and real user repository mutations. Web typecheck was not run; no web file changed and the contract additions are optional.

## Outstanding integration gates

- `SymphonyOrchestratorLive.getProjectBoard` still calls `listByLifecycle(..., { limit: 1_000 })`. Wiring it to `listForBoard` with 5,000 active and 100 newest terminal items belongs to the scheduling/integration lane.
- B-1 read-error propagation remains outstanding: the current `getProjectBoard` still swallows repository failures, so the typed decode failure added here is not yet surfaced to RPC callers.
- The web board does not consume `totalCount` or `truncated`; badges and truncation notices are UI work owned elsewhere.
