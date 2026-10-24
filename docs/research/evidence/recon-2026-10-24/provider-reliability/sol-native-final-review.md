What this change does: It records Codex child lineage for every native activity kind, including interactions after resume, and adds a regression through the real Codex client/runtime wiring. The previously reviewed task-card mapping and explicit-dismissal visibility policy remain unchanged.

Verdict: ACCEPT for the bounded source correction at frozen HEAD `eef750bfb`, reviewed in `/Users/kamogelo/.codex/worktrees/neokod-native-orchestration/t3code`. Opus F1 and F2 are resolved. No actionable new source blocker found in the correction.

Reviewer configuration: gpt-6.1-sol, high, as requested for this delegated review. Source review only. I read `opus-native-review.md`, `native-final-correction-answer.md`, the delta from `8ae70da51`, the actual runtime caller/handler wiring and the existing fake peer implementation. No source edits, tests, builds, installs, browser actions or provider execution were performed.

F1, lineage after interaction/resume: resolved. `CodexSessionRuntime.ts:622-628` no longer restricts lineage registration to `kind === started`. Every valid `subAgentActivity` with a child ID and known parent turn overwrites that child's map entry, matching the older collab behaviour. Undefined parent turn still exits before registration. The adapter still creates cards only for `kind === started`; its production mapping did not change in this delta. Runtime tests cover all three kinds and latest-parent-turn replacement, while the adapter test now sends both interacted and interrupted observations and proves that the next emitted event is the parent sentinel, with no fabricated card or generic parent item from either observation.

F2, real runtime wiring: resolved at the fixture level. The test at `CodexSessionRuntime.test.ts:236-364` constructs `makeCodexSessionRuntime` with the existing `makeFakeCodexPeer` process-spawner seam, then calls `start()` and `sendTurn()`. Notifications pass through stdout JSON-RPC decoding, registered typed handlers, the raw notification queue and the runtime event stream. It asserts child content has the child's identity plus the parent turn, child turn/started is suppressed, child completion is forwarded as a tagged child event, the parent's status and active turn remain running, and only the parent's own completion changes the session to ready. A second child first observed as interacted also has its content and completion routed as child events, and cannot settle the parent.

The previously accepted bounded behaviours remain intact: generated item-schema validation on both notification methods, stable child-keyed start event IDs, no fabricated terminal event for malformed child completion, no terminal event from parent interrupted intent, and visibility until explicit dismissal. This review supersedes the earlier Sol acceptance where Opus subsequently identified the missing resumed-lineage case.

Verification inspected, not rerun: the handoff reports 61 focused server tests, 21 web tests, repository check/typecheck success and a clean diff check. Root owns matching-source final checks and the remaining live acceptance.

Residual boundaries from Opus remain unchanged: real Codex notification order before any parent child-activity observation is unproven; multi-turn child cards are not reopened after their first terminal event; root owns the stale FORK.md wording. The fake peer test establishes real application wiring under controlled notifications, not a live Codex process or network/UI acceptance.

Looks good. Ship the reviewed source correction after root's required verification and authorised delivery step.

Not checked: live Codex/Copilot execution, browser or Stop-race validation, builds, packaging or deployment.
