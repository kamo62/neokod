What this change does: It routes Codex 0.163 native child activity into task cards, preserves the older collab shape, and keeps child completion away from the parent turn. It also removes automatic hiding of empty real task cards, including Copilot cards.

Verdict: ACCEPT for the bounded source correction in commit `8ae70da513e057c12bd0634737dd6fe766710f8a` at `/Users/kamogelo/.codex/worktrees/neokod-native-orchestration/t3code`. No actionable blocker found in the six changed files. This is source acceptance, not live provider or desktop acceptance.

Reviewer configuration: gpt-6.1-sol, high, as requested for this delegated review. Review was read-only. No tests, builds, installs, provider execution, browser actions or source edits were performed. Expected load is the documented single-user local server, including multiple native children and repeated provider observations.

The requested checks:

1. Parent isolation: `CodexSessionRuntime.ts:601-628` records child lineage for both item notification methods. `handleRawNotification` at `858-908` retains the parent turn identity and tags known child events. Nested child lineage inherits the root parent turn through `childParentTurnId ?? route.turnId`. `shouldApplyParentTurnCompletion` at `688-695`, used by the real typed completion handler at `948-973`, rejects registered children, unrelated threads and unknown parent identity. The adapter's child branch at `817-856` returns task events before parent turn/message handling, so child terminal events cannot become parent `turn.completed` events.

2. Schema validation and notification coverage: the adapter validates `item/started` and `item/completed` with the generated `V2ItemStartedNotification` and `V2ItemCompletedNotification` schemas (`1103-1129`). Both paths handle `subAgentActivity` before generic parent item mapping. A completion-only observation with `kind: started` can therefore create the card without producing a parent timeline item. `kind: interacted` and `kind: interrupted` do not fabricate task completion. The old collab path remains in both notification methods.

3. Stable event deduplication: both new-shape observations and old collab spawn observations use `codex:subagent-started:<child-thread-id>` (`CodexAdapter.ts:509-512`, `555-568`, `617-624`). I traced this beyond the adapter: ingestion constructs command IDs from the runtime event ID (`ProviderRuntimeIngestion.ts:870-872`), including runtime-item observations (`1866-1882`) and activity append (`2282-2298`). `OrchestrationEngine.ts:148-174` returns the existing accepted receipt for the same command and aggregate. The card fold also retains one card per task ID (`apps/web/src/session-logic.ts:790-810`). The adapter still emits repeated observations, but the existing durable path deduplicates them as intended.

4. Malformed completion remains unknown: `childTurnCompletedStatus` at `630-644` validates the generated completion schema and maps only completed, failed or interrupted statuses. The child branch emits nothing for invalid/non-terminal completion (`837-843`), leaving central reconciliation to preserve tracking uncertainty. It no longer defaults malformed completion to completed.

5. Card visibility: `SubagentsPanel.logic.ts:104-111` filters only explicit user dismissals. Completed, stopped, failed, orphaned, empty and zero-usage cards remain visible. The component calls this function, and the deleted automatic-hide helpers have no remaining references. Existing card lifecycle presentation remains separate from this visibility policy.

Regression coverage inspected:

- Runtime helper fixtures cover new-shape child identity, old collab receiver identity, suppression policy and early child completion before parent identity is known.
- Adapter fixtures cover both item notification paths, stable event IDs on repeated observations, interrupted activity remaining open, child terminal isolation and malformed child completion.
- Web policy tests cover real empty cards across terminal statuses, the Copilot-shaped zero-usage card, and explicit dismissal.
- The handoff reports 59 focused server tests, 21 web tests, repository check/typecheck success and a clean diff check. These results were not rerun during this review.

Scope and limitations: The six-file correction meets Opus design constraints C1-C4. It does not establish native app-server notification ordering against a real process, visual correctness in Chrome, reload/Stop-race acceptance, or app-managed child orchestration. The handoff's stale `FORK.md` wording remains root-owned documentation work outside this frozen commit. No source acceptance is claimed for other lanes.

Looks good. Ship the reviewed source correction after root's required verification and authorised delivery step.

Not checked: live Codex/Copilot execution, browser/UI validation, builds, packaging or deployment.
