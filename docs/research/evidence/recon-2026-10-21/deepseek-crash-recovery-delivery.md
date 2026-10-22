Implemented both cards on `work/core-crash-recovery` from `cc054117d` and pushed to `neokod`.

## Commits

- `5caa00e24` `fix(provider): settle threads left running by a hard crash as interrupted with an orphan-possible binding [skip ci]`
- `4690f3307` `fix(provider): settle unrecoverable threads on Stop and approval, expire approvals, and scrub provider error text [skip ci]`

Branch upstream: `neokod/work/core-crash-recovery`. No force push. Working tree clean.

## Behaviour

**2.3**

- A projected running session with an active turn, no matching live session, and a matching `running`/`starting`/undefined binding now plans `interrupted` with `HOST_LOST_SESSION_ERROR` and `bindingSettlement: "host_lost"`.
- The binding is written first as `error`, with `activeTurnId: null`, `stopPhase: "settled"`, and `orphanPossible({ reason: "host_lost" })`. A failed write is logged and the session is still settled.
- Live sessions, provider/instance mismatches, missing bindings, starting projected sessions, terminal-turn settlement, and the existing stopped/error binding branch are preserved. The turn is never marked completed/error and the binding is never marked stopped.
- `hostLostCount` is added to the reconciliation completion log. The 2.4 command-read-model path is unchanged.

**X-7**

- Added typed `ProviderSessionNotRecoverableError`; `recoverSessionForThread` returns it when no live session and no resume cursor exist.
- Stop on that condition settles `running`/`starting` to `interrupted` with the typed message and emits no failure activity. Idle `ready` sessions are untouched.
- Approve/Decline/user-input on that condition write the existing stale-pending detail first, then settle the session. Existing stale-request handling remains.
- Added `scrubErrorText` and `userFacingFailureDetail`. Reactor failure details now store sanitised text while the full cause stays in `provider.command.failed` logs.
- Live `thread.session-set` events with status `interrupted` now use the same durable `closeItemsOfSettledSession` closure as startup, with the deterministic reconciliation IDs and `startedNoLaterThan` fence. Provider-terminal items keep precedence and termination remains `orphaned` when unconfirmed.
- `runtime.error`, `session.state.changed` error reasons, and failed `turn.completed` messages are scrubbed before storage.

## Verification

Focused baseline failures recorded before production fixes:

- Reconciler: `2 failed | 9 passed` (host-lost plan empty; no binding-before-session order).
- ProviderService: failed with `ProviderValidationError` instead of the typed error.
- Sanitiser: missing helper module (`Cannot find module './userFacingErrorText.ts'`), recorded separately from behavioural failures.
- Reactor: `4 failed | 34 passed` (two settlement timeouts, idle thread got a failure activity, `Cause.pretty` stack/path stored).
- Ingestion: `2 failed | 49 passed` (live interruption did not close the approval; absolute path not scrubbed). The newer-item fence test passed at baseline as expected.

Final checks, all passing:

- Focused suites: reconciler, reaper, ProviderService, sanitiser, reactor, ingestion, and `ProjectionPipeline.test.ts`: `7 files, 167 tests passed`.
- `apps/server` `tsgo --noEmit`: exit 0, no errors. Output contained only existing repo-wide suggestions, including pre-existing ones in `ProviderService.ts`.
- Scoped `vp fmt --check` and `vp lint` on all changed files: clean.
- `git diff --check`: clean.

No dependency install, root `vp check`/`vp run typecheck`, builds, app/provider launches, browser, Docker/Electron, or other worktrees were touched.

## Residual gaps

- No live PV-10 runtime repro or first-restart restart validation was run; closure is proven at unit level only, including subscription timing inferred from startup ordering, not exercised end to end.
- Stop/approval settlement updates the projected session only; the binding keeps its prior status until the next boot, where 2.3 writes `error` plus `orphan_possible`.
- Rows already stored before this change still contain unsanitised text; the card deliberately does not add a display-time filter.
- The interrupted banner still uses the error banner path; no web change was made.
- This does not establish full Phase 1 completion.
