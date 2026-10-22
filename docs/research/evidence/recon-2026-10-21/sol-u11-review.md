I’ll review only the pinned U-11 source and the caller/store paths needed to verify Copy Path. I won’t inspect the working-tree diff, change files, run tests, or use agents.
No actionable P0–P2 findings in U-11 commit `3357c8693bd70345d8c6afac1d4ce5c6f6761a49` against parent `cc054117d`.

Verified from pinned source:

- Actual callers: both pinned and unpinned All threads lists use `SidebarProjectItem` in flat mode. The row supplies the clicked thread’s environment-scoped reference to the context-menu handler, which retrieves that thread by scoped key. (`apps/web/src/components/Sidebar.tsx:578–581`, `:1263–1279`, `:3457–3462`)
- Correct path ownership: the resolver returns the thread’s worktree first, otherwise matches both its `environmentId` and `projectId`. It cannot fall back to the representative first project. (`apps/web/src/components/Sidebar.logic.ts:647–656`)
- Missing owner: without a worktree or matching owner, resolution returns `null`; Copy Path shows “Path unavailable” without copying an unrelated path. (`apps/web/src/components/Sidebar.tsx:2230–2233`, `:2260–2272`)
- Environment-switch freshness: `useProjects()` subscribes to the catalogue-wide project collection, not an active-environment-only collection. Projects are indexed by scoped identity, and the handler includes `allProjects` in its dependencies while reading the current thread map. No stale-path defect from switching environments was identified. (`packages/client-runtime/src/state/projectEntities.ts:56–95`; `apps/web/src/components/Sidebar.tsx:1199`, `:1278–1279`, `:2305–2313`)

The four added test cases match the pinned U-11 card’s specified cases (`apps/web/src/components/Sidebar.logic.test.ts:119–167`).

Read-only source review only. README, AGENTS, state-and-evidence and the U-11 card were read from the pinned revision. No working-tree diff inspection, edits, tests, builds, runtime checks, or later-commit review performed.
