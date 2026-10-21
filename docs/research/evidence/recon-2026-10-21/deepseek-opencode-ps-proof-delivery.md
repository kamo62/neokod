I'll start by inspecting the current worktree state and the relevant files.Now I'll add the failing test first, exercising the real inspector through a fake spawner.Now the test helper and cases:Before-fix failure reproduced (exit 2 → `absent`; clean no-match → `unknown`). Now the source fix:The Apple source has `if (nkept == 0) exit(1)` — Darwin's no-match exit is 1, not 0. Let me confirm across releases and correct both the test and the fix.Done. Source commit `a4e8a7353` on `work/core-opencode-cleanup`, parent `57f8fe07c`, pushed without force.

## Change

`apps/server/src/provider/OpenCodeServerLedger.ts` — `runPs` now reads stderr alongside stdout and exit code. `absent` requires all three: exit status 1, no stdout rows, no stderr diagnostic. Any other non-zero exit returns `unknown` (`ps_exit_<code>`); exit 0 with no rows returns `unknown` (`ps_output_unparsed`).

Platform semantics were checked against Apple's `adv_cmds` `ps/ps.c` (`main`, `adv_cmds-237`, `216.100.1`, `181`, `149`): the no-match path is `if (nkept == 0) exit(1);`, and every error path writes stderr before a non-zero exit. No live `ps` or process probes were run. `runPs` only executes on darwin; Linux/win32 paths are untouched.

## Tests

`apps/server/src/provider/OpenCodeServerLedger.test.ts` adds a fake `ChildProcessSpawner` that drives the real `makeSystemProcessInspector` on `observe(500)` with `HostProcessPlatform = "darwin"`. It asserts the spawned `/bin/ps` argv, so the test exercises the actual boundary rather than an injected inspector.

Three cases:

- clean no-match: exit 1, empty stdout/stderr → `absent`
- the reported bug: exit 2, empty stdout, stderr diagnostic → `unknown` (`ps_exit_2`)
- narrowness: exit 1, empty stdout, stderr diagnostic → `unknown` (`ps_exit_1`)

Honest before/after (same tests):

- Before source fix: 19 passed, 2 failed. Both failures returned `{ state: "absent" }` where `{ state: "unknown" }` was required — exit 2 + stderr, and exit 1 + stderr. This directly reproduced the bad classification that authorises killing a child. The clean no-match case passed before and after; it is a regression guard, not a reproducer.
- After fix: 21/21 pass.

Checks run: scoped `vp test run src/provider/OpenCodeServerLedger.test.ts`, `vp run typecheck` in `apps/server` (exit 0; only pre-existing Effect suggestions in that file and others), `vp fmt --check` and `vp lint` on the two owned files (clean). No builds, installs, root-level checks, app/provider runs, live processes, other agents, external messages, lockfile changes, or runtime/shared edits. `git status` is clean and in sync with origin.

Limits: evidence is unit-level with a synthetic `ps`; no real macOS `ps` invocation was executed, so the classification is backed by Apple's source rather than observation.
