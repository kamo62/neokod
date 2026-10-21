# DeepSeek ACP lane: symphony-review-fix

Worker report retained verbatim. Later central integration and correction status is in plan.md section 16.8.

Implemented both source-traced fixes on `work/core-symphony-review-fix`.

## Fixes

**P1 — buffered edit ownership survives external revisions**

- `projectSettingsDraft.ts`: drafts now carry an `editing` claim taken on the first buffered keystroke. `isDraftDirty` includes that claim, so reconciliation keeps the revision the edit started from. `editDraft` clears it on blur commit; `endEditDraft` releases it on unchanged blur or abandoned unmount.
- `useCommitOnBlur.ts`: added `onBeginEdit` (once per buffered edit) and `onDiscardEdit` (unmount/unchanged blur). Blur parsing and single-render-per-commit performance are unchanged.
- `draft-input.tsx` / `SymphonyProjectConfigurationForm.tsx` / `SymphonyProjectView.tsx`: optional callbacks wired only for Symphony's buffered list fields. Existing provider-settings consumers are unaffected.
- `applySavedDraft` preserves buffered ownership when a save response arrives before blur.

**P2 — project isolation**

- `SymphonyProjectView.tsx`: restored the settings subtree key as `key={project.id}`, never revision. Switching cached project A → B remounts the editor instead of reusing A's local input text with B's callback.

## Evidence

Fail-first log: `/tmp/neokod-core-symphony-2026-10-21/acp/lane-symphony-review-fix-red.log`

- P1: `expected 'clean' to be 'changed_elsewhere'` — external revision was adopted underneath the buffered edit.
- P2: `expected '<SettingsTab\n project={pr…' to contain 'key={project.id}'`.

Pass log: `/tmp/neokod-core-symphony-2026-10-21/acp/lane-symphony-review-fix-final.log`

- Symphony unit suite: 7 files, 32 tests passed.
- `apps/web` `tsgo --noEmit`: passed.
- Scoped `vp fmt --check` and `vp lint`: passed.
- Working tree clean after commit and push.

## Commits and remote

- `08841f2ff` `fix(symphony): preserve buffered edit ownership across updates [skip ci]`
- `8b6a59726` `fix(symphony): release abandoned buffered edit ownership [skip ci]`
- Remote: `8b6a5972675e9e65735398d968c01ac3319cdb1e` on `origin/work/core-symphony-review-fix`

## Gaps

- P2's regression guards the actual mount-identity contract by reading the owned view source. This repo's unit runner is Node-only; exercising real remount behaviour needs the browser/Playwright project, which this task prohibited. P1 is reproduced at the reconciliation level (`begin edit → external revision → blur commit`), not through simulated DOM events.
- No builds, app launch, runtime/browser verification, root checks, or whole-project completion claimed. Main owns integration and exact-dev follow-up review.
