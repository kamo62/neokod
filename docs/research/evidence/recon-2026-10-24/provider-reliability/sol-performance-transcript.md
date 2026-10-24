HEAD is `0c05baa3f`, and only the four requested files are modified. I’ll trace the changed paths and their callers, treating the worker’s results as supporting evidence, not acceptance of the current diff. I’ll keep the review read-only.
The caller trace supports both optimisations: terminal pending text comes only from the parser and is cleared on lifecycle resets, while Git passes stdout and stderr callbacks independently. Raw Git output returns truncation flags; the patch helper adds the marker later. The new Git tests check behaviour preservation, but do not guard against reintroducing the unused line scans.

## ACCEPT

No blocking correctness or regression findings in the four uncommitted files against `0c05baa3f426d91ed97bb0d625f1531a3380b9c0`. The changes implement the two scoped performance intents without UI, cloud, contract or lifecycle changes.

### Substantive assessment

- **Terminal boundary handling is sound.** At `apps/server/src/terminal/Manager.ts:1007,1050–1053,1099–1102`, retaining one character before the boundary catches split `ESC \` terminators. The `Math.max` also preserves the content start for short prefixes and subsequent control strings. Caller tracing confirms pending text comes only from this parser, is not loaded from persisted history, and is cleared on lifecycle resets.
- **Git collection semantics are preserved.** At `apps/server/src/vcs/GitVcsDriverCore.ts:663–687`, only unused line accumulation/scanning is conditional. Decoding, raw-byte accounting, truncation, stream draining and decoder flushing remain outside those guards. Stdout and stderr callbacks are handled independently, including the real commit-progress caller.
- **The truncation assertions match existing behaviour.** At `apps/server/src/vcs/GitVcsDriverCore.test.ts:164–180`, the three-byte cap cuts inside `雪`, producing `é�`. The cap applies to consumed input bytes, not the UTF-8 size of the resulting replacement character. `outputLength: 4` reports bytes observed at the first overflowing chunk, not total process output. Raw `execute` returns truncation flags; the higher-level patch helper appends the marker.
- **The terminal regression exercises meaningful behaviour.** At `apps/server/src/terminal/Manager.test.ts:1367–1429`, it waits for output processing, checks persisted and reopened history, covers both scanner branches, and restores the global counting hook through `Effect.ensuring`. Its bound measures scanner reads, not total copying or memory complexity.

### Non-blocking finding

**[P3] Git tests do not protect the performance improvement itself.**  
`apps/server/src/vcs/GitVcsDriverCore.test.ts:133–181`

Both new tests verify behaviour preservation and would also pass with the original unconditional line scanning. Consider adding one deterministic scan-count check using long newline-free or NUL-separated output: no unused line scans without callbacks, with callback delivery retained as a control. Avoid a wall-clock threshold.

### Independent evidence and proof limits

- Read README, AGENTS, `docs/architecture/state-and-evidence.md`, the worker evidence and relevant intent notes.
- Fresh, read-only comparisons of the current terminal parser against HEAD covered **101,732 boundary cases and 10,000 seeded random chunked streams**, totalling **420,761 per-chunk comparisons**, with identical results.
- Scoped `git diff --check` passed.
- Repository test suites, `vp check` and typecheck were **not independently rerun**. The worker’s reported passes remain attributed evidence, not this review’s verification.
- No real PTY, Windows, application-runtime or Git performance measurement was performed. Parser equivalence does not establish complete terminal-protocol conformance or application-wide speed.
- No files were edited, installed or built, and no provider calls were made.

This is acceptance of the current source diff, not release or live-runtime acceptance.
