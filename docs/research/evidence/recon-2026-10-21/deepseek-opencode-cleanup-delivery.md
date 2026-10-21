# DeepSeek ACP lane: opencode-cleanup

Worker report retained verbatim. Later central integration and correction status is in plan.md section 16.8.

I'll start by reading the key documents and the plan cards.Implemented X-5 and X-6 on `work/core-opencode-cleanup`, one commit per card, and pushed to origin. No builds, packaging, runtime launch, Docker or Playwright were run.

## Commits

- `96653e07c` `fix(opencode): settle a user Stop as interrupted instead of failing on the abort echo [skip ci]`
  - `apps/server/src/provider/Layers/OpenCodeAdapter.ts`
  - `apps/server/src/provider/Layers/OpenCodeAdapter.test.ts`
- `a5088f13d` `fix(opencode): authenticate spawned servers with a per-spawn password and reap orphans after a crash [skip ci]`
  - `apps/server/src/provider/opencodeRuntime.ts`
  - `apps/server/src/provider/opencodeRuntime.test.ts`
  - `apps/server/src/provider/OpenCodeServerLedger.ts` (new)
  - `apps/server/src/provider/OpenCodeServerLedger.test.ts` (new)
  - `apps/server/src/provider/Layers/OpenCodeAdapter.ts`
  - `apps/server/src/provider/Layers/OpenCodeAdapter.test.ts`
  - `apps/server/src/provider/Layers/OpenCodeProvider.ts`
  - `apps/server/src/textGeneration/OpenCodeTextGeneration.ts`
  - `apps/server/src/server.ts` (OpenCode layer wiring only)

Remote verification: `git ls-remote origin refs/heads/work/core-opencode-cleanup` returns `a5088f13d8e6da6d761d6e20640ce82e562d3ef5`, matching local HEAD. Branch tracks origin. Working tree is clean.

## Behaviour

X-5:

- `interruptTurn` marks the requested turn before calling `session.abort`, emits the existing `turn.aborted` boundary event, then settles the active turn once as `interrupted`.
- A requested abort echoed as `MessageAbortedError` or as an `idle` status produces exactly one `turn.completed` with `state: "interrupted"`, no `runtime.error`, and a `ready` session with cleared active turn and error.
- An unrequested `MessageAbortedError` still settles as failed.
- The terminal-retry abort is marked so its late echo is absorbed.
- A fresh turn clears the mark; a steer keeps it.
- Pending permissions and questions resolve on interrupt.

X-6:

- Each spawned `opencode serve` gets a 32-byte random base64url password in the child environment only, never argv.
- Child environment removes `NEOKOD_*`, `T3CODE_*`, `OPENCODE_SERVER_PASSWORD`, `OPENCODE_SERVER_USERNAME` and `OPENCODE_PASSWORD`, with `extendEnv: false`; provider keys, `HOME`, `PATH`, `XDG_*` and `OPENCODE_CONFIG_*` pass through.
- Spawned-local clients in the adapter, provider probe and text generation use the generated password; external servers keep the configured password.
- New atomic ledger at `<stateDir>/opencode-servers/<pgid>.json` records pid, pgid, start time, command, port, state directory and owner identity. Orphans are signalled only on full identity match; unproven entries are left unsignalled and removed. Live owners keep their entries.
- Ledger startup reconciliation is forked so it cannot delay startup.

## Verification evidence

Pre-change baseline (`X-5`, `src/provider/Layers/OpenCodeAdapter.test.ts`): 5 failed, 20 passed. Failures were `AssertionError` deep-equal mismatches: failed/`Aborted` instead of `interrupted`, `completed` instead of `interrupted`, duplicate `runtime.error` after terminal retry, no second-turn settlement, and no pending-permission resolution. Log: `/tmp/neokod-core-symphony-2026-10-21/acp/lane-opencode-cleanup-x5-baseline.log`.

Pre-change baseline (`X-6`, runtime plus adapter): 4 failed, 31 passed. Failures were behavioural assertions: missing `OPENCODE_SERVER_PASSWORD`, `extendEnv` true, `serverPassword` undefined, and spawned-local auth header `null`. Log: `/tmp/neokod-core-symphony-2026-10-21/acp/lane-opencode-cleanup-x6-baseline.log`. The ledger module did not exist before the change, so its 10 tests have no pre-change behavioural baseline; that gap is not represented as before/after evidence.

Post-change focused tests, exact HEAD:

```text
vp test run src/provider/opencodeRuntime.test.ts src/provider/OpenCodeServerLedger.test.ts \
  src/provider/Layers/OpenCodeAdapter.test.ts src/provider/Layers/OpenCodeProvider.test.ts \
  src/textGeneration/OpenCodeTextGeneration.test.ts src/provider/Layers/ProviderRegistry.test.ts

Test Files  6 passed (6)
Tests  108 passed (108)
```

Also passed: `vp run typecheck` in `apps/server` (exit 0), scoped `vp fmt`, scoped `vp lint` (exit 0), `git diff --check` (exit 0). Logs are under `/tmp/neokod-core-symphony-2026-10-21/acp/lane-opencode-cleanup-*.log`.

## Limitations

- The real macOS/Linux process inspector (parsing `ps` or `/proc`, real `process.kill`) was not exercised. Ledger tests use a synthetic inspector and temporary directories only; no real process was observed or signalled.
- No manual `opencode serve` run, no real provider account, no `~/.neokod` or archived data touched.
- No runtime, packaging, Electron, Docker or build proof is claimed. Root `vp check`/`typecheck`, Sol 6.1 and Opus source review, merge to `dev`, and PR creation remain central review steps. I did not open a PR, merge, dispatch workflows, deploy or publish.
