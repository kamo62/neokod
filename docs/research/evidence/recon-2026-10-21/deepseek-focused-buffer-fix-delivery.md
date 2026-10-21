Implemented and pushed on `work/core-symphony-review-fix`.

**Fix**

- Commit `d4d4c6d61` `fix(symphony): keep untouched focused buffers current [skip ci]`
- Pushed without force: `8b6a59726..d4d4c6d61`
- Files:
  - `apps/web/src/hooks/useCommitOnBlur.ts`
  - `apps/web/src/hooks/useCommitOnBlur.test.ts`

Behaviour now:

- A focused but clean field follows an incoming authoritative value.
- Blur only commits or discards when a keystroke actually began the edit, so an untouched snapshot can no longer overwrite an external field.
- Typed buffers still survive upstream updates, still commit their text, and still release ownership when they return to the authoritative value.
- Existing unmount ownership release remains.

**Regression and checks**
The extraction of the pure buffer transitions was behaviour-preserving first. The new regression then failed against that current behaviour with:

```text
AssertionError: expected 'kamo62/neokod' to be 'kamo62/neokod-next'
Expected: "kamo62/neokod-next"
Received: "kamo62/neokod"
```

After the fix:

- Focused regression plus Symphony draft/form tests: 4 files, 20 tests passed.
- Full Symphony unit scope plus hook test: 8 files, 35 tests passed.
- `vp run --filter @neokod/web typecheck`: passed.
- Scoped `vp fmt --check` and `vp lint`: passed.
- `git diff --check`: clean.

No builds, root checks, installs, runtime/browser/Playwright runs, data or config changes, `.repos` edits, other agents, PRs, or main/dev merges.

**Limits**
There is no DOM test runner in the unit lane, so the regression covers the pure buffer transitions, not actual React focus/blur events against the Symphony store.

The project-remount runtime gap remains unverified: the removed `SymphonyProjectView.test.ts` source-text guard was not restored or modified. The view still uses `key={project.id}`, but no runtime evidence here proves that switching projects remounts `SettingsTab` and drops the previous hook buffer.

Chronology and exact commands are logged at `/tmp/neokod-core-symphony-2026-10-21/acp/lane-focused-buffer-fix-progress.log`.
