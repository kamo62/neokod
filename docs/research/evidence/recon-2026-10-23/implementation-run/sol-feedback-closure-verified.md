REQUEST_CHANGES at frozen `c3e5fd420`. One blocking coverage gap; no remaining implementation defect found in the four scoped corrections.

P2: publication-interruption regression is missing. [ApprovalService.test.ts:1170](/Users/kamogelo/.codex/worktrees/neokod-feedback/t3code/apps/server/src/symphony/Runner/ApprovalService.test.ts:1170) yields after publication and then closes the scope while waiting. This unchanged test does not exercise the previously failing window after durable insertion but before `recordRequest` returns, despite the implementation report claiming it does.

Extend this existing regression with a deterministic barrier after durable insertion, interrupt while publication remains suspended, then assert the row is `interrupted` and the live registration is removed. It should fail against `7574eb450`.

Source tracing otherwise confirms:

- Registration and cleanup installation are atomic; publication and waiting remain interruptible.
- Uncertain `delivering` content and staged decisions survive unsuccessful settlement.
- Unknown Stop-all returns `ok:false`.
- The actual Codex runtime rejects unsupported drivers and instances before spawn; both have meaningful zero-spawn tests.

Checkout remained clean at the requested SHA. `git diff --check` passed. No tests, builds, installs or providers were run. Live Codex continuation remains separate runtime evidence, not a source-acceptance blocker.
