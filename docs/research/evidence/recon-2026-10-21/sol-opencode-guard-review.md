Two actionable O1 findings. Verified this turn’s `turn_context`: `gpt-6.1-sol`, effort `high`.

1. [P2] Recheck the CLI major before executing maintenance. [OpenCodeDriver.ts:191](/Users/kamogelo/.codex/worktrees/core-symphony/t3code/apps/server/src/provider/Drivers/OpenCodeDriver.ts:191) captures maintenance capabilities once. After a 1.x executable is externally replaced with 2.x, refreshing status detects 2.x but leaves the original updater executable.

   This reaches execution: [ProviderRegistry.ts:476](/Users/kamogelo/.codex/worktrees/core-symphony/t3code/apps/server/src/provider/Layers/ProviderRegistry.ts:476) returns the cached capability, and [providerMaintenanceRunner.ts:342](/Users/kamogelo/.codex/worktrees/core-symphony/t3code/apps/server/src/provider/providerMaintenanceRunner.ts:342) runs it without checking the current version or unsupported status. An npm-managed instance can therefore execute `npm install -g opencode-ai@latest` after detecting 2.x. Where the external upgrade replaced the executable in the existing installation, installing a newer legacy package can restore 1.x. Package-manager collision protection may instead reject some installation layouts.

   This is a reachable legacy-install command, beyond a stale display. Revalidate inside the maintenance lock immediately before execution and reject known unsupported majors. The added tests cover creation-time 2.x, not this transition.

2. [P2] Bound the new version probes. [OpenCodeDriver.ts:170](/Users/kamogelo/.codex/worktrees/core-symphony/t3code/apps/server/src/provider/Drivers/OpenCodeDriver.ts:170) now awaits `--version` synchronously during driver creation. The command waits indefinitely for output streams and process exit. Registry hydration awaits driver creation, so an enabled OpenCode launcher that hangs on `--version` can prevent server initialisation.

   The same unbounded probe precedes the server-start timeout in [opencodeRuntime.ts:521](/Users/kamogelo/.codex/worktrees/core-symphony/t3code/apps/server/src/provider/opencodeRuntime.ts:521). Bound the probe and preserve the documented unknown-version fallback when it times out.

The remaining scoped checks support O1:

- The parser accepts the `v` prefix and classifies the major centrally.
- Known local 2.x status returns before connection or inventory calls. Adapter and text-generation startup reach the runtime guard before spawning `serve` or making SDK requests.
- A driver created with known 2.x disables Symphony review and maintenance; the actual reviewer honours that capability.
- Supported 1.x retains its existing path and minimum-version check. Both readiness banners parse.
- External servers retain their URL/password path, skip local version inference and explicitly report the verification gap.

I reviewed `48769b380` against `f11e40013` across all eight changed paths, with narrow caller tracing. The integrated checkout is `dev@778add365`, not local `main@1d615711e`. Its scoped diff from O1 contains only the later runtime identity guards and corresponding test changes; both O1 and the checks before TERM/KILL survive the merge.

Verdict: fix findings 1 and 2 before closing O1. SDK/CLI 2 compatibility remains unimplemented; O2’s ACP spike remains separate. No builds, tests, installs, app/provider launches, edits or external actions were performed.
