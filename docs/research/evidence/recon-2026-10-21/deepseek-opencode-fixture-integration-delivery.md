I have the code and the prior fix. Now reproduce the integration failure with the current fixtures before editing.Reproduced exactly. The recorded group SIGTERM is from the `--version` probe child (pid 69777), not the server group (69796). Now make the fixtures answer `--version` with a supported version and exit 0.Test file passes now. Next, prove the guarded non-zero test still catches the regression by temporarily restoring the server spawner to the caller's scope.Proven: with the server spawner back on the caller's scope, the test fails with a SIGTERM to the server group (70398). Restore the production fix.Formatting, lint and server typecheck pass. Re-run the full runtime file and related OpenCode tests after formatting.Now the required direct Sol review of the scoped diff before completion.No correctness findings in the fixture changes.

1. Test intent and strength are preserved.
   - `apps/server/src/provider/opencodeRuntime.test.ts:542–547`: only `--version` exits successfully; the server invocation still records its PID and exits 7. The assertions still require startup failure, a recorded server PID and no process-group signals (`581–591`).
   - `apps/server/src/provider/opencodeRuntime.test.ts:609–616`: the healthy server still records its PID, announces readiness, installs its TERM trap and loops. Success, PID presence and process exit remain required (`631–638`).

2. The version branches do not modify server-observable state. Both return before PID-file writes, readiness output, trap installation or the server loop. The probe is a separate process; its successful exit avoids the spawner’s non-zero-exit group-cleanup branch without changing the server’s group or cleanup behaviour.

3. No new false-positive or server-bypass path identified. The runtime invokes the probe with `["--version"]` and the server with `["serve", …]` (`opencodeRuntime.ts:536,591`). A probe-only execution cannot satisfy either test’s PID-file assertion, and cannot satisfy healthy startup.

4. No production change is present in the described patch. Independent confirmation of the complete uncommitted diff was unavailable because this subagent has no command-execution tool.

5. The shell branches are valid POSIX `sh`. Quoted `"$1"`, string comparison with `=`, `echo` of this fixed string, and `exit 0` are portable. Neither fixture enables `set -u`, so an absent first argument is also safe.

Residual limitations: source inspection only. No tests, builds, app, CLI or process-signalling commands were run, as instructed. The healthy test’s existing exit assertion observes the server leader, not every possible descendant; this patch does not weaken that coverage.Sol review is clean. Commit only the owned test file and push the same branch without force.Done. The failure was the task-owned integration gap, and the production code was correct.

## Diagnosis

The new `--version` probe ran the shell fixture itself. For `failing-opencode.sh`, that probe wrote its PID and exited 7, so `runOpenCodeCommand`'s scoped spawner finalizer recorded an unrelated group SIGTERM before the server path ran:

```
expected [ { pid: -69777, signal: 'SIGTERM' } ] to deeply equal []
```

The server group (`69796`) was guard-refused correctly. The signal came from the version-probe child (`69777`). The healthy fixture had the same problem in slower form: `--version` entered the server loop and only settled on the probe timeout.

## Change

Only `apps/server/src/provider/opencodeRuntime.test.ts` changed. Both fixtures now answer `--version` with `opencode 1.18.15` and exit 0 before touching PID files, readiness output, traps or loops. No assertion was weakened. `opencodeRuntime.ts` has no diff against `d89fad2f7`.

## Verification

- Before fix: `vp test run src/provider/opencodeRuntime.test.ts` gave 1 failed, 23 passed with the assertion above.
- After fix: same file gave 24 passed.
- Regression proof: temporarily changed the server spawner from `spawnScope` back to `runtimeScope`. The guarded non-zero test failed with `{ pid: -70398, signal: 'SIGTERM' }`. Restored the production fix and re-ran successfully.
- Relevant OpenCode tests: `vp test run` over runtime, version, ledger, driver, adapter, provider and text-generation files: 7 files, 109 tests passed.
- `vp fmt --check apps/server/src/provider/opencodeRuntime.test.ts`: passed.
- `vp lint --report-unused-disable-directives apps/server/src/provider/opencodeRuntime.test.ts`: exit 0.
- `vp run typecheck` in `apps/server`: exit 0.
- `git diff --check`: exit 0.

## Review and delivery

Direct Sol review was attempted at `openai/gpt-6.1-sol#high` (401) and `azure/gpt-6.1-sol#high` (invalid subscription), then completed with `github-copilot/gpt-6.1-sol#high`. It found no correctness issues and confirmed the tests still exercise the server path. That is a documented provider substitution, not the requested direct provider path.

Committed `696f323c6 test(opencode): answer runtime version probes in spawner fixtures [skip ci]` and pushed `work/core-opencode-cleanup` without force. Working tree is clean and only the owned test file is in the commit.

Limitations: no builds, root checks, app run, real OpenCode CLI or external processes were used, per instruction. Verification is scoped source, lint, server typecheck and the relevant runtime/OpenCode tests.
