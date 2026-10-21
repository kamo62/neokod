# DeepSeek ACP lane: secret-review-fix

Worker report retained verbatim. Later central integration and correction status is in plan.md section 16.8.

Implemented and pushed the P1 fix on `work/core-u04-review-fix`.

**Behaviour changed**

- `ProviderEnvironmentSection` now reconciles stored-secret ownership against the authoritative `instance.environment` after settings acknowledgement, not against the draft that produced the save.
- A successful rename/replacement `A -> B` moves the row's stored link from `A` to `B`. Clearing the replacement and restoring name `A` can no longer publish `valueRedacted: true` for removed `A`.
- Failed-save recovery is preserved: while the server still reports `A` as stored, the row keeps `A` ownership and can restore it.
- Unchanged stored secrets, uncheck, rename, and replacement semantics remain covered.
- Added a defensive guard so a named sensitive row with no stored link and no value blocks publishing instead of emitting an empty sensitive variable that the server treats as a removal instruction.

**Fail-first evidence**
Ran the full user sequence against the previous module at `HEAD` and the fixed module:

```text
old result: [{"name":"API_KEY","value":"","sensitive":true,"valueRedacted":true}]
new result: null
old behaviour re-publishes redacted API_KEY: true
new behaviour blocks publish: true
```

Log: `/tmp/neokod-core-symphony-2026-10-21/acp/lane-secret-review-fix-failfirst.log`

**Verification**

- Focused unit tests: 2 files, 36 tests passed, including the behavioural A -> B acknowledgement and restore regression.
- `apps/web`: `tsgo --noEmit` passed.
- Scoped `vp fmt --check` passed on the three owned files.
- Scoped `vp lint` passed on the three owned files.
- Post-commit focused tests and typecheck passed again.

**Commit**

- `e71ab3c0be01ba8a5f83426521e925bd8abba6cb`
- Message: `fix(settings): reconcile stored secrets with acknowledged environment [skip ci]`
- Remote branch hash verified: `e71ab3c0be01ba8a5f83426521e925bd8abba6cb`

**Gaps**

- No browser, runtime UI, or whole-project verification was run.
- Reconciliation depends on authoritative settings acknowledgement by design. An in-flight save that has not yet been acknowledged is still indistinguishable from a failed save, so no new in-flight suppression was added.
- No server changes were required.
