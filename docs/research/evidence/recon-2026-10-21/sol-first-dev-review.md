Actual reviewer: `gpt-6.1-sol`, effort `high`, confirmed from session metadata. Four source-traced findings:

1. **P1: Stored-secret identity survives removal of the secret.** [providerEnvironmentDraft.ts:36](/Users/kamogelo/.codex/worktrees/core-symphony/t3code/apps/web/src/components/settings/providerEnvironmentDraft.ts:36)  
   Load stored secret `A`, rename it to `B`, enter a replacement and let it save. The server removes `A`, but the mounted row retains `stored.name = A`. Clear the replacement, then restore the name to `A`: the helper publishes `valueRedacted: true` for the nonexistent secret. Server cleanup removes `B`, leaving neither credential. Reconcile stored identity with authoritative acknowledgements; restoration must not relink a secret already removed.

2. **P1: Buffered settings edits can bypass revision-conflict protection.** [SymphonyProjectView.tsx:186](/Users/kamogelo/.codex/worktrees/core-symphony/t3code/apps/web/src/components/symphony/SymphonyProjectView.tsx:186)  
   Begin typing in a list field while the draft is clean, then receive another client’s configuration update before blur. The keystrokes exist only inside `useCommitOnBlur`, so reconciliation treats the draft as clean and adopts the newer configuration/revision. Blur then commits the older local text against that newer revision. Save can overwrite the concurrent field change without the conflict banner. Preserve the editing revision and dirty ownership from the first buffered edit.

3. **P2: Overwrite restores the stale hash before saving.** [FilePreviewPanel.tsx:788](/Users/kamogelo/.codex/worktrees/core-symphony/t3code/apps/web/src/components/files/FilePreviewPanel.tsx:788)  
   After a disk conflict, Overwrite clears the baseline and schedules a debounced write. Clearing the conflict banner causes a render; `adoptInitialHash(file.data?.contentHash)` immediately restores the stale optimistic hash. The attempted overwrite therefore conflicts again. Distinguish an explicitly cleared precondition from an uninitialised baseline.

4. **P2: Focused settings buffers can cross project boundaries.** [SymphonyProjectView.tsx:491](/Users/kamogelo/.codex/worktrees/core-symphony/t3code/apps/web/src/components/symphony/SymphonyProjectView.tsx:491)  
   Removing the entire settings key also removes project identity. Navigate via browser history from project A to an already cached project B while a list field has an unblurred draft. The route and input components can remain mounted, retaining A’s local text; subsequent blur commits it through B’s callback. Key the settings subtree by project identity, without including revision.

Scope: `5e53f76b967ceb1ecb5c125fedd794dd920a2577` against `f2ad1498d47ffe9c76c6069f04e56fee206cfc74`, covering X-1/X-2/U-01/U-02/U-02b/U-03, U-04 and S-01/S-02. Later provider/terminal lanes were excluded. The checkout’s subsequent documentation-only commit did not change reviewed source.

No builds, tests or runtime/UI probes were run. Browser conflict/remount interactions and live Git/tracker/closure evidence remain absent. Compare/write remains separate operations, with no OS-level atomic CAS guarantee. This is the Sol review only.
