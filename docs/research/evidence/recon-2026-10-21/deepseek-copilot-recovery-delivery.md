# DeepSeek ACP lane: copilot-recovery

Worker report retained verbatim. Central integration/review status is recorded in plan.md section 16.8.

X-4 implemented, committed, and pushed. Report follows.

## Changed files (task-owned only)

- `apps/server/src/provider/copilot/CopilotRuntimeSupervisor.ts` (new)
- `apps/server/src/provider/copilot/CopilotRuntimeSupervisor.test.ts` (new)
- `apps/server/src/provider/copilot/CopilotAdapter.ts`
- `apps/server/src/provider/copilot/CopilotAdapter.test.ts`
- `apps/server/src/provider/copilot/CopilotDriver.ts`
- `apps/server/src/provider/copilot/CopilotDriver.test.ts`

No schemas, shared provider paths, configuration/auth, dependencies, lockfiles, `.repos`, or user data touched.

## Behaviour implemented

- New supervisor: `ping` is the only liveness authority. A rejecting ping is `dead`; a 5s timeout is `unknown` and never restarts. `restartIfDead` runs under a one-permit semaphore, re-probes inside the permit, ignores `forceStop` errors, then `start`s. Success increments `restartCount`; failure logs and returns false.
- Adapter runtime loss: each live session settles pending approvals/user inputs, closes an active turn once as `failed`, emits `runtime.error` with no `turnId` (`transport_error`, `{ kind: "runtime_lost" }`), then `session.exited` with `exitKind: "error"`, deleting the session. Restart is forked in the adapter scope so Stop/send are not delayed.
- Watchdog every 3s probes only while a turn is active; idle sessions are never pinged.
- `interruptTurn` now surfaces abort failures on a live/unknown runtime as `session/abort` request errors; an abort failure on a dead runtime settles the turn and returns success.
- `sendTurn` settles an already-announced turn when the send fails and the runtime is dead; live-runtime failures keep prior behaviour.
- Driver: enabled instances get the supervisor wired into the adapter; provider checks recover a dead runtime first; `restartCount` changes republish the snapshot so Settings returns to ready without waiting for the 5-minute refresh. Disabled instances get no supervisor.

## Fail/pass evidence

- Pre-edit (production files reverted, tests kept), clean behavioural failures in `/tmp/neokod-core-symphony-2026-10-21/acp/lane-copilot-recovery-base-fail.log`: 5 failed, 42 passed. Failures: runtime-death settle, abort failure surfaced, abort-on-dead settle, send-on-dead settle, driver restart-on-refresh (`forceStopCalls 0 !== 1`). The idle no-ping test passes on base as a guard.
- Post-edit (`lane-copilot-recovery-postcommit-test.log`): 3 files, 51 tests passed.
- `apps/server` `tsgo --noEmit`: 0 errors in changed files (pre-existing repo-wide suggestions only; no new errors).
- `vp fmt --check` clean on all six files; scoped `vp lint` clean; `git diff --check` clean.

New focused tests cover the four supervisor behaviours (single serialized restart, alive no-op, timeout = unknown, failed start) and the five adapter fault-injection cases plus driver restart-on-refresh, using fake SDK sessions only.

## Commit and remote

- Commit `fe55a196628a81627836fa8593242b9281c800ac`
- Message: `fix(copilot): settle turns and restart the runtime when the Copilot CLI child dies [skip ci]`
- Branch `work/core-copilot-recovery`, pushed without force; `git ls-remote` matches the local SHA. Worktree clean.

## Limitations

- No build, packaging, Electron, Docker, Playwright, runtime launch, or live Copilot child kill was performed, per the no-build instruction. The PV-12 manual repro on a real runtime remains unproven.
- Central root `vp check` / `vp run typecheck`, dev merge, PR creation, and Sol 6.1 / Opus review remain with main; I do not claim those gates passed.
