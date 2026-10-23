ACCEPT, source review only.

Reviewed clean HEAD `daf6cfb55748f9d4f006a38421b258ed80054e86`, diff `6debed050..HEAD` and affected UI callers. No scoped P0–P2 findings.

- Stop-all preserves mixed confirmed/held results, held-only results and missing counts. Legacy acknowledgements never prove closure; only explicit zero counts produce “No runs needed stopping.”
- Delivering/interrupted history shows staged decisions and delivery uncertainty while preserving content, redaction and unavailable-history notices.
- Both single-run callers require exact `outcome.runAttemptId` matching before confirmation.
- Drawer reprojection incorporates actual network/environment state, board errors and retained source staleness.
- Accepted-brief, refusal, header and current-lifecycle semantics remain preserved.

Startup wiring and typed cancellation production remain known Recovery/guidance composition DEPENDENCIES, not UI-owned findings. Feedback decision preservation at `05d62b3f8` remains acknowledged.

No edits, tests, builds or browser validation performed. `vp check` and typecheck are unverified in this review. Final Chrome validation remains a separate integration gate.
