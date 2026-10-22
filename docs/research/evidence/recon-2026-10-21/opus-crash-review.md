Now the closure planner.I found one P1 and four P2s. No P0. This was a source-only review: I did not rerun any repo tests, and I did not edit, build or launch anything.

**Pinned:** HEAD `4690f3307180d3293f6f7b8f21a2d7920735fae2`, base `cc054117d`, 2 commits (`5caa00e24`, `4690f3307`), working tree clean.

## P1

**P1-1. After a hard crash, a settled thread can become permanently unable to start new turns.**

- **Where:** card 2.3 writes `status: "error"` plus `orphan_possible(host_lost)` (`provider/Layers/ProviderSessionReconciler.ts:44-63`). `ProviderService` treats any persisted outcome other than `stopped_confirmed` as an unresolved stop (`ProviderService.ts:208-220`).
- **Trigger A (same boot):** the user does not continue the thread for 30 minutes.
  - The reaper reaps the binding because its status is `error`, not `stopped`, and the thread no longer has an active turn (`ProviderSessionReaper.ts:42-73`).
  - `stopSession` takes the inactive branch and returns the stored `orphan_possible` outcome (`ProviderService.ts:1072-1073`).
  - `releaseBarrier` stays false, so the thread stays in `stoppingThreads` (`:1041`, `:1095`, `:1102-1111`).
- **Trigger B (any later restart):** the startup code adds the thread to `stoppingThreads` (`ProviderService.ts:309-321`).
- **Result:** `startSession` and `sendTurn` fail at `:707` and `:847` with "thread … is stopping (thread barrier)". Nothing clears this; `Errors.ts:215` mentions acknowledging an orphan, but no code does it.
- **Also:** starting a fresh session does not clear the marker. Upserts merge `stopOutcome` instead of resetting it (`ProviderService.ts:136-164`, `ProviderSessionDirectory.ts:47-58`).
- **Side effect:** the reaper rewrites the binding and emits stop events for each such thread about every 30 minutes.
- **Why it matters:** the same evidence lets the thread run in the first boot but blocks it later. Card 2.3's "Not known" and "Do not" sections and the worker's residual gaps don't cover this. X-7's PV-10 expectation ("the thread is idle") only holds until the reaper runs or the server restarts.
- **Owner decision needed:**
  - (a) `host_lost` should block new turns: block immediately, say so in the banner, and add a way to clear it.
  - (b) It should not: exclude `host_lost` from `hasUnresolvedStop`, or clear `stopOutcome` when `startSession` succeeds.
- **Missing test:** no test runs the reaper, or a second `ProviderService` construction, over a `host_lost` binding.

## P2

**P2-1. The newer-item fence only chooses which runtime sessions to close; it does not filter the items that get closed.**

- `closeItemsOfSettledSession` applies `startedNoLaterThan` only to build the set of session IDs (`ProviderRuntimeIngestion.ts:922-930`).
- It then calls `closeRuntimeItems` with `boundary: "session"`. `planRuntimeItemClosures` closes every active item in that session regardless of `startedAt` (`RuntimeItemProjection.ts:210-228`).
- **Trigger:** one old active item and one newer active item share a runtime session, and the `interrupted` event is processed late. Both are orphaned.
- **Test gap:** the fence test (`ProviderRuntimeIngestion.test.ts:828`) has a single newer item in its own session, so that session is never selected. The mixed case is untested.
- **Reachability today:** low. `ProviderService` gives every start, recovery or adoption a new runtime session ID (`ProviderService.ts:357-367`, `:555`, `:579`, `:777`), and the unrecoverable path has no live session. Still, the code does not do what the card and comment claim.
- **Caveat for the fix:** if the fence moves to per-item filtering, the later unfenced startup closure (`:2149`) produces the same deterministic command ID (`:934`). The engine's receipt check (`OrchestrationEngine.ts:141-160`) would then silently drop it. Add the fence value to the ID, or pass the filter into the planner.

**P2-2. If the server crashes between the binding write and the session dispatch, the host-lost message is lost.**

- The binding is written with `activeTurnId: null` (`Layers/ProviderSessionReconciler.ts:56`).
- On the next boot, the `stopped`/`error` branch calls `exactBindingError`. That returns `null` because the binding's `activeTurnId` no longer matches the turn (`Services/ProviderSessionReconciler.ts:36-48`, `:127-134`).
- The thread is settled with `lastError: null`, so the "outcome unknown, process may still be running" warning disappears.
- **Fix:** have that branch return `HOST_LOST_SESSION_ERROR` when the binding's `stopOutcome` is `orphan_possible` with reason `host_lost`.
- The reconciler test (`ProviderSessionReconciler.test.ts`) does not cover this path.

**P2-3. Sanitiser gaps (`userFacingErrorText.ts:7-10`, `:17-24`).** I checked these by running the copied regexes in a scratch `node -e`, outside the repo test suite.

- **Not scrubbed:**
  - `C:/Users/kamogelo/proj/a.ts` (Windows with forward slashes): `POSIX_PATH` excludes a slash after `:`, and `WINDOWS_PATH` requires a backslash.
  - UNC paths: both `\\server\share\…` and `//server/share/…`.
  - `path:/Users/…` (a path directly after a colon).
  - `~/…` paths.
- **Username leak:** keeping the last segment exposes the user name for home directories. `mkdir '/Users/kamogelo'` and `/home/kamogelo/` both become `[path]/kamogelo`.
- **Paths with spaces leak in part:** `'/Users/me/My Projects/secret/a.ts'` becomes `'[path]/My Projects/secret/a.ts'`.
- **URLs not fully preserved:** a URL whose query contains an absolute path is changed. `?file=/Users/k/x/y` becomes `?file=[path]/y`.
- **Text lost:** `STACK_FRAME_LINE` drops any line that starts with "at ", so "Rate limited.\nat most 5 requests per minute" becomes "Rate limited.". A reason made only of "at" lines scrubs to `""`, and that empty string is stored as `lastError` because the default text only applies when the value is `undefined` (`ProviderRuntimeIngestion.ts:1680-1688`, `:2005`).
- **Useful message degraded:** `ProviderCommandReactor.ts:534` ("This thread's folder no longer exists: … Move it back") now loses the path it was written to show.
- **Working as intended:** full HTTP URLs, `a/b` model IDs, and `./` and `../` relative paths are kept. `describeFailure` logs the full `Cause.pretty` and stores only the safe text.

**P2-4. Boot time is used as if it were the turn's end time.**

- The reconciler sets the session's `updatedAt` to now (`Layers/ProviderSessionReconciler.ts:89`).
- The projection uses that as the interrupted turn's `completedAt` (`ProjectionPipeline.ts:1118`), and the live closure uses it as `closedAt` for orphaned items.
- A crash overnight therefore shows as a turn lasting many hours. That conflicts with `state-and-evidence.md:53` (orphaned elapsed time ends at the last observation).
- The binding's `lastSeenAt` or `lastRuntimeEventAt` would be the honest end time. Weigh that against keeping `updatedAt` in order.

## No finding in scope

- **Binding written before session:** order is correct, and a failed write is logged while the thread is still settled. The degraded state is P2-2.
- **2.4 command read model:** unchanged; still uses `getCommandReadModel` with the comment.
- **Live, provider and instance guards:** kept. A missing binding and a projected `starting` session are still skipped.
- **Ready and idle threads:** left alone by both the planner and `settleUnrecoverableSession`.
- **Typed error:** `recoverSessionForThread` fails with `ProviderSessionNotRecoverableError`. It passes unchanged through `resolveRoutableSession` and `withMetrics` (`Metrics.ts:133-136`) to the reactor's `Cause.findErrorOption` check.
- **Stop:** settles a running or starting session with no failure activity.
- **Approve, Decline and user-input:** write the stale-request detail first, then settle. The existing stale-request branch is kept.
- **No completion invented:** the turn becomes `interrupted`, never `completed` or `error`. Closure uses `terminationGuaranteed: false`, so items become orphaned, and provider-confirmed terminal items are skipped. Closure IDs are deterministic and match between the live path and the startup path.
- **Stale interruption after a replacement session:** the per-session fence works because each replacement gets a new runtime session ID. The reactor processes events one at a time, so a Stop cannot settle over a session started by an earlier queued turn start.

## Not verified

- **First-boot closure has not been shown to work.** It depends on the ingestion domain subscription being active before the reconciler dispatches. `Stream.fromPubSub` subscribes lazily inside a fiber started with `forkScoped` and no `startImmediately` (`OrchestrationEngine.ts:344-346`, `serverRuntimeStartup.ts:340-345`). It is very likely ready in practice because of the async database reads in between, and if it misses, the next boot's startup closure catches it.
- **Test evidence:** the worker reports 7 files and 167 tests passing, plus `tsgo`, fmt and lint clean. I read the added tests but did not rerun them. No root `vp check` or `vp run typecheck` and no live PV-10 reproduction were run, by the worker or by me.

None of this approves Phase 1 as a whole.
