# OMApp v0.30 Updates

## Goal

Make the fork a focused OMApp desktop agent app while keeping upstream T3 Code resync cheap.

## Decisions

- Remove native mobile from active builds.
- Hide visible T3 Cloud / T3 Connect surfaces.
- Rename visible app branding to `OMApp`.
- Keep internal package names, env vars, storage keys, bundle IDs, and import scopes unchanged for v0.30.
- Continue from `org/copilot-claude`; push only to the fork remote.

## Upstream Sync

- Configure `upstream` as `https://github.com/pingdotgg/t3code.git` with push disabled.
- Use `scripts/rebase-upstream.sh` as the resync entrypoint.
- Improve the script before the v0.30 rebase:
  - accept an explicit target like `--target upstream/main`;
  - use repo-local `./node_modules/.bin/vp`;
  - run `vp check` and `vp run typecheck`;
  - keep conflict guidance based on `FORK.md`;
  - never push automatically.
- After each upstream rebase, run `git range-diff` and reconcile `git diff --name-only upstream/main...HEAD` against `FORK.md`.

## v0.30 Work

### 1. Fork Hygiene

- Add or verify the read-only upstream remote.
- Patch `scripts/rebase-upstream.sh`.
- Rebase onto the chosen upstream target.
- Update `FORK.md` only for shared upstream files touched by fork work.

### 2. Cleanup

- Remove the native mobile app from active package and build paths.
- Remove or disable native-mobile-only scripts.
- Keep responsive web and desktop preview behavior.

### 3. Cloud Hiding

- Hide T3 Cloud / T3 Connect nav, onboarding, settings, empty states, and visible copy.
- Leave backend relay/cloud code compiling unless it blocks desktop.

### 4. Visible Rename

- Change visible labels, window titles, menus, onboarding, docs snippets, and changelog language to `OMApp`.
- Keep internal names unchanged.

### 5. Feature Parity Focus

- Git/review workflow: diff, stage/revert, commit, push, PR/review context, checks.
- Automations: scheduled runs, history, status, worktree/local mode.
- Workspace polish: local/worktree/SSH status and reconnect clarity.
- Usage visibility: local token/session/model stats first.
- Desktop polish: shortcuts, menus, notifications, release/update surfaces.

## Verification

- `./node_modules/.bin/vp check`
- `./node_modules/.bin/vp run typecheck`
- `./node_modules/.bin/vp lint --report-unused-disable-directives`
- `./node_modules/.bin/vp test`
- `bun run build:desktop`
- `bun run test:desktop-smoke`

## Release Notes

- Changelog heading: `0.0.30 - 2026-07-07 (Major)`.
- Major impact because native mobile is removed from active product paths and cloud surfaces are hidden.
- Bump versioned packages only at release cut: `apps/server`, `apps/web`, `apps/desktop`, `packages/contracts`.
