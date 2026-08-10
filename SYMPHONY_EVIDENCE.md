# Implementation Summary

- `apps/server/src/git/GitManager.ts` now applies per-key exponential failure backoff to PR-status lookups: 2, 4, 8, and 16 minutes, capped at 30 minutes. Successful lookups clear the streak, and the in-memory streak map is bounded to the existing 2,048-entry cache capacity.
- PR lookup is skipped for a branch with no upstream only when exact remote-ref enumeration proves the branch has never been pushed. Git command failures remain unknown evidence, propagate through the cache failure path, and preserve the last known PR status.
- `apps/server/src/git/GitManager.test.ts` covers the backoff sequence and cache timing, never-pushed branches including descendant-name collisions, pushed branches without an upstream, and remote-ref enumeration failure with sticky PR fallback.
- Validation passed:
  - `bun x vp test run apps/server/src/git/GitManager.test.ts` (72 tests)
  - `bun x vp check apps/server/src/git/GitManager.ts apps/server/src/git/GitManager.test.ts`
  - `bun x vp run typecheck`
  - `git diff --check`

# Assumptions

- The current `GitVcsDriver` exposes `execute`, despite the issue snapshot stating otherwise. It is used here because `listRefs` intentionally converts remote-ref command failures to empty results and therefore cannot prove that absence is authoritative.
- Backoff is intentionally process-local and keyed by repository, branch, upstream, and explicit-invalidation epoch.

# Risks

- Failure streaks reset when the server process restarts; this matches the requested in-memory scope.
- A no-upstream lookup performs two local Git commands before deciding whether a provider request is needed.

# Unresolved

- `bun install --frozen-lockfile` cannot succeed in this checkout because the repository declares `pnpm@11.10.0` and contains `pnpm-lock.yaml` but no Bun lockfile. Bun reported `InvalidPnpmLockfile` followed by `lockfile had changes, but lockfile is frozen`. The code validations above ran with dependencies reused from a checkout whose `package.json` and `pnpm-lock.yaml` hashes exactly match this workspace.
- No version or changelog update was requested or required for this scoped bug fix.
