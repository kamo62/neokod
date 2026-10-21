Corrected the Windows cleanup P2 and closed the status caller gap on `work/core-opencode-cleanup`.

**Windows command termination**

- `runOpenCodeCommand` now branches on `HostProcessPlatform`.
- POSIX keeps the existing bounded TERM-then-KILL escalation and the real fail-first/pass fixture.
- Windows no longer calls `child.kill` twice. It starts one `taskkill /pid <pid> /T /F` worker directly with `shell: false`, retains the native process handle, awaits settlement, and cancels through that handle if it hangs.
- Cancellation and worker exit waits are bounded. A worker or child that cannot be confirmed stopped produces a warning with pid, worker pid, reason and detail. It is never relabelled stopped.
- Preflight skips the worker when the command handle already reports exit.
- `taskkill` targets a pid. The implementation cannot prove pid non-reuse beyond the spawner handle's exit observation, and the comments state that limit. It does remove the abandoned-worker delayed-action path.

**Status `--version` gap**

- `checkOpenCodeProviderStatus` now applies `OPENCODE_VERSION_PROBE_TIMEOUT` to the local `--version` command.
- Timeout preserves unknown version evidence: installed true, version null, auth unknown, explicit error message, and no server connection attempt.
- The configured external-server path remains untouched and unprobed.

**Verification**

- `vp test run` on runtime, provider, driver, maintenance and maintenance-runner tests: 5 files, 81 tests passed.
- `vp run --filter neokod typecheck`: exit 0.
- Scoped `vp fmt --check`, `vp lint`, and `git diff --check`: passed.
- No builds, installs, root gates, live providers, real taskkill, or user processes were run.

**Native Windows limitation**
All Windows behaviour was verified through the injectable fake owned termination handle. No native Windows `taskkill` execution was possible on this Mac, so real Windows process-handle behaviour remains unverified.

**Commits pushed to `neokod work/core-opencode-cleanup`**

- `ab645ca74` fix(opencode): own Windows command termination worker [skip ci]
- `464785c4f` fix(opencode): bound the status version probe [skip ci]
- `8a9e9c15e` docs(opencode): state the Windows worker cancellation limit [skip ci]
