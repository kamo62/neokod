Pinned HEAD to `4690f3307180d3293f6f7b8f21a2d7920735fae2`. I’ll review `cc054117d..4690f330` and its callers/tests read-only, with no test execution, edits or agents. Findings will be limited to actionable P0–P2 issues in the locked 2.3/X-7 scope, not whole-Phase-1 approval.I found two concrete gaps so far: the interruption fence filters session IDs, but closure then re-reads all items in those sessions without the fence; and the sanitiser misses absolute-path forms and can alter URL query text. I’m tracing projection precedence and startup/caller behaviour to check the impact and avoid duplicate findings. No files or checks have been run.Found 3 actionable issues: 1 P1 and 2 P2. No P0 findings.

Reviewed `cc054117d..4690f3307180d3293f6f7b8f21a2d7920735fae2`. HEAD remained pinned and the working tree stayed clean. This is a source-only review of locked 2.3/X-7, not Phase 1 approval.

## Findings

### P1: The newer-item fence does not reach the actual closure candidates

Location: `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:922–944`, with the unrestricted re-read at `:887–899`.

Trigger: runtime session `S` has an active old item started at `00:03` and an active new item started at `00:05`. A delayed interrupted event has `updatedAt: 00:04`.

The old item passes `startedNoLaterThan`, selecting session `S`. `closeRuntimeItems` then re-reads every item and plans session-wide closures without that timestamp fence. Both items become orphaned, including the new item, with a closure timestamp earlier than its start. For a new approval/input request, this emits a synthetic resolution and removes a prompt that the live provider still needs answered.

The test at `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts:828` contains only a newer item, so no session ID is selected and it misses the mixed old/new failure.

Fix: carry the cutoff into `closeRuntimeItems` and apply it to the items actually passed to `planRuntimeItemClosures`, or pass the already-fenced candidates. Cover mixed old/new active items sharing one runtime session, including delayed interruption after newer work begins.

### P2: Absolute-path redaction misses common Windows and POSIX forms

Location: `apps/server/src/provider/userFacingErrorText.ts:9–10`, applied at `:21–22`.

Trigger: provider failure text contains any of these literal paths:

- `C:/Users/alice/private/a.txt`
- `\\server\share\private\a.txt`
- `//server/share/private/a.txt`
- `/secret.env`
- `path:/Users/alice/private/a.txt`

These remain unredacted by the current expressions. The Windows expression only recognises drive-letter backslash paths. The POSIX expression requires another directory separator and rejects paths immediately preceded by `:` or `/`.

Both reactor failure details and runtime-ingestion error text use this helper, so these paths can still be persisted in public activity text and `session.lastError`.

Fix: recognise drive-letter paths with either separator, UNC paths, and POSIX root-level/colon-adjacent paths without relying on host-platform path parsing. Add focused cases alongside the existing conventional backslash/POSIX examples.

### P2: The POSIX expression also modifies complete URLs and relative paths

Location: `apps/server/src/provider/userFacingErrorText.ts:9,21`.

Trigger: failure text contains:

```text
https://api.example.com/v1/models?redirect=/docs/api
```

The `/docs/api` query value matches the POSIX expression and becomes `[path]/api`, corrupting the URL. Similarly, the valid relative path `src/(generated)/deep/file.ts` has its `/deep/file.ts` suffix replaced because the preceding `)` passes the lookbehind.

The existing preservation test covers only a simple URL, `src/a.ts`, and a conventional model ID. It does not establish preservation of complete URL tokens or punctuation-bearing relative paths.

Fix: protect complete non-file URL tokens before path redaction and recognise path-token boundaries rather than treating an eligible interior slash as an absolute-path start. Preserve relative paths and model IDs unchanged.

## Remaining scope

No additional P0–P2 source finding in:

- Binding-before-session ordering, repeated-settlement guards, live/provider/instance checks, and the retained 2.4 command read model.
- Typed-error propagation through recovery and metrics plumbing.
- Unrecoverable Stop settlement without a failure activity, ready/idle preservation, and stale approval/input consumers.
- Deterministic synthetic closure IDs and provider-confirmed terminal precedence.

The first-boot interrupted-event closure path is present after the earlier startup item reconciliation. Actual first-restart behaviour and subscription timing were not exercised.

## Evidence and limits

Read the requested instructions/docs, full 2.3/X-7 cards, changed source/tests, relevant callers/projections, and the worker receipt.

The receipt reports 167 passing tests across seven files, server `tsgo`, and scoped lint/format/diff checks. Those are worker-reported results, not independently rerun evidence. The receipt explicitly says root `vp check` and `vp run typecheck` were not run.

I ran no tests, builds, app/browser/provider processes or agents, and made no edits, commits, pushes or external messages.
