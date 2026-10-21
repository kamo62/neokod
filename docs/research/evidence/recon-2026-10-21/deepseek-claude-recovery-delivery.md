# DeepSeek ACP lane: claude-recovery

Worker report retained verbatim. Central integration/review status is recorded in plan.md section 16.8.

I'll start by reading the required docs and the card, then trace the actual code paths.Dependencies aren't ready yet. Let me inspect the source thoroughly.Now I'll add the focused failing tests before production edits. First the harness option and adapter tests.Dependencies are ready. Now I'll run the new behavioural tests on the base source to record the failure class.Baseline failures recorded. Now implementing the contracts schema and the pure usage-limit module.Focused tests pass. Now the full affected suites.Pushed. Running one final post-commit verification pass and saving logs.Implemented and pushed X-3 on `work/core-claude-recovery`.

## Changed files

- `apps/server/src/provider/Layers/ClaudeUsageLimit.ts` (new)
- `apps/server/src/provider/Layers/ClaudeUsageLimit.test.ts` (new)
- `apps/server/src/provider/Layers/ClaudeAdapter.ts`
- `apps/server/src/provider/Layers/ClaudeAdapter.test.ts`
- `apps/server/src/provider/Drivers/ClaudeDriver.ts`
- `apps/server/src/textGeneration/ClaudeTextGeneration.ts`
- `apps/server/src/textGeneration/ClaudeTextGeneration.test.ts`
- `packages/contracts/src/server.ts`
- `packages/contracts/src/server.test.ts`
- `apps/web/src/components/settings/providerStatus.ts`
- `apps/web/src/components/settings/providerStatus.test.ts`

No files outside the stated ownership were touched; no lockfile, config, migration, `.repos`, or dependency changes.

## Behaviour implemented

- `subtype: "success"` with `is_error`, 401/429/529, or a failing terminal reason now ends the turn `failed`; explicit `aborted_streaming`/`aborted_tools` ends `interrupted`.
- CLI text is preserved (synthetic assistant text first, then `result.result`), never replaced by a generic message. Usage-limit resets come only from actual rejected `rate_limit_event` evidence; a bare 429 gets no invented reset.
- Structured failure detail carries `kind`, `resetsAt`, `apiErrorStatus`, `terminalReason`; auth failures use `permission_error`.
- Rejected windows are tracked per `rateLimitType`, published to the driver via `SubscriptionRef`, projected into optional `ServerProvider.limit`, and cleared after a successful turn. The Settings card shows `Usage limit reached` with the reset instead of `Authenticated`.
- Text generation returns a typed `TextGenerationError` carrying the CLI limit text instead of decoding it as structured output, including when the CLI exits non-zero.
- Contracts gained optional `ServerProviderLimit` (`kind`, `window`, `resetsAt`, `observedAt`) and `ServerProvider.limit`.

## Fail → pass evidence

Baseline on unmodified production code:

- Adapter: 4 new tests failed — `turn.completed` was `completed` where `failed`/`interrupted` was required; `onRateLimitChange` was never called.
- Text generation: `Claude CLI returned unexpected output format.` instead of the CLI `session limit` text (the non-zero-exit case already preserved text).
- Contracts: `limit` decoded as `undefined` because the schema did not know it.
- Web: headline was `Authenticated · Claude Pro Subscription` instead of `Usage limit reached`.

After implementation:

- `apps/server`: 119 tests passed across `ClaudeUsageLimit`, `ClaudeAdapter`, `ClaudeTextGeneration`, `ClaudeDriver`.
- `apps/web` unit project: 3 passed.
- `packages/contracts`: 10 passed.
- `tsgo --noEmit`: exit 0 in `apps/server`, `apps/web`, `packages/contracts`.
- Scoped `vp fmt --check`, scoped `vp lint`, and `git diff --check`: exit 0.

Logs are under `/tmp/neokod-core-symphony-2026-10-21/acp/lane-claude-recovery-*.log`.

## Commit and remote

- Commit `c288fe0e1b06ff26040e24bacee9d3a5540034ff`
  `fix(claude): fail turns that end on an API or usage limit error and surface the limit on the provider card [skip ci]`
- Pushed without force to `origin/work/core-claude-recovery`; remote head matches local commit exactly.
- Working tree clean.

## Limitations and remaining status

- No live Claude account limit was induced or consumed. The verification is test-fixture and source evidence only.
- No build, packaging, Electron, Docker, Playwright, runtime launch, or central `vp check`/`vp run typecheck` was run, per the no-build instruction.
- The driver’s `SubscriptionRef`/`enrichSnapshot` wiring is typechecked and the existing `ClaudeDriver.test.ts` passes; the pure limit projection is unit-tested, but no new driver-level stream test was added.
- No merge to `dev`, PR, release, deployment, or external message was performed; that remains central integration work for main and source review by Sol 6.1 and Opus.
