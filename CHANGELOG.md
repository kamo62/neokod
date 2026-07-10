## 0.0.31 - 2026-07-10 (Patch)

Release impact: Patch because this hardens existing demo behavior without changing public contracts.

- Kept completed subagents with progress or summaries visible until locally hidden, and labeled local hide controls honestly.
- Added a workspace empty state for the Files panel and improved Copilot fleet streaming and unsupported-SDK guidance.

## 0.0.30 - 2026-07-07 (Major)

Release impact: Major because native mobile is removed from active product paths and cloud surfaces are hidden by default.

- Removed native mobile from active workspace/build paths for the OMApp fork.
- Hid visible T3 Cloud / T3 Connect surfaces behind a default-off OMApp cloud flag.
- Renamed visible product copy, titles, menus, and release language toward OMApp while keeping internal package names and storage keys unchanged.
- Updated the upstream rebase script to support explicit targets, repo-local `vp` checks, and no automatic pushes.
- Fixed Claude Task plan updates so deleting the final task emits an empty plan and clears the sidebar.
- Fixed Codex child-thread item completions so the Subagents panel receives durable worker progress rows instead of showing empty running cards.
- Added regression coverage for Codex child-thread progress mapping and Claude Task plan clearing.
