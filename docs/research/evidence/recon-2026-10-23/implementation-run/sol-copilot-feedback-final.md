I’ll verify the pinned HEAD and worktree state, read the scoped requirements, then trace the production path. I’ll keep this read-only and won’t run tests or read other reviewers’ findings.HEAD matches the requested SHA and the worktree is clean. The production factory uses the shared callbacks, and staged-delivery retries now require a local claim receipt. I’ll check the remaining failure and interruption boundaries, keeping startup wiring and dispatch integration outside this lane.## REQUEST_CHANGES

Reviewed exact HEAD `8521d00c1eb4e19446ecfce11da80488674c33ea`, correction range `dd032f867..HEAD`, and relevant production callers. Worktree was clean before and after review.

### 1. P1: Durable settlement can be interrupted by production scope closure

**Path:** `apps/server/src/symphony/Runner/AgentRuntime.ts:733,854,947` and `AgentRequestCallbacks.ts:70–78`.

**Trigger:** Cancellation, process exit or run completion settles the live Deferred, then the dispatch scope closes before `requestSettled` finishes. The production dispatch is scoped in `apps/server/src/symphony/Orchestrator/Layers/SymphonyOrchestratorLive.ts:1802–1804`; Dispatcher settlement at `Runner/Dispatcher.ts:619–621` wakes the consumer but does not await durable closure.

The new callback runs only through ordinary, interruptible request-handler continuation. There is no request finaliser protecting it against scope interruption. Consequently, the live entry can disappear while its SQLite row remains `pending`, leaving an unanswerable request advertised as actionable.

**Bounded fix:** Make exact-registration cleanup and durable pending-row settlement part of an interruption-safe request finaliser. Preserve already-decided and uncertain `delivering` rows. Keep this within the runtime/callback/service seam, without changing recovery ownership.

The new settlement test explicitly awaits the provider response before closing its scope, so it does not cover this production boundary.

### 2. P2: Startup reconciliation reports success when persistence evidence is unavailable

**Path:** `apps/server/src/symphony/Runner/ApprovalService.ts:733–749`.

**Trigger:** `listDelivering()` fails, or a row’s `reconcileDelivery()` write fails.

A failed read becomes an empty list and returns `0`. A failed write is logged, but `reconciled` still increases. The API therefore cannot distinguish “nothing needed reconciliation” from “the database could not be inspected”, and can count unchanged rows as reconciled.

**Impact:** Recovery’s eventual caller receives false completion evidence and cannot reliably retain an unknown/partial state or retry failed reconciliation.

**Bounded fix:** Return a typed failure or explicit unavailable/partial result; count only successful reconciliations. This concerns the feedback-owned API, not the recovery-owned startup wiring.

### 3. P2: Masking and redaction disagree for label-detected secrets

**Path:** `apps/web/src/components/symphony/SymphonyApprovalActions.tsx:199,245`; `apps/server/src/symphony/Runner/ApprovalService.ts:106–112`; `AgentRuntime.ts:693`.

**Trigger:** A rendered structured question asks for an “API key”, password or token, but the provider omits `isSecret`.

The server classifies that question as sensitive and redacts its answer. The component checks only `question.sensitive === true`, so the same answer uses a visible text input without the sensitive-answer notice.

**Impact:** Older-provider secrets covered by the server’s explicit fallback policy remain exposed on screen.

**Bounded fix:** Align the effective sensitivity classification used for masking and durable redaction, while preserving the provider marker.

This is a component-source defect, not an observed exposure: current production parent call sites do not yet pass `questionPayload`.

### Corrections that are sound in source

- `delivering` retries now require positive same-service/process consumption receipts. Restarted or pre-claim staged rows cannot be promoted to answered/approved merely because the live entry is absent.
- Reconciliation preserves uncertain stored answer/note content rather than erasing it or claiming provider receipt.
- Registration precedes publication; explicit publication failures withdraw the registration. The interruption boundary remains finding 1.
- Duplicate comparison includes the normalised question payload, including options and sensitivity.
- Malformed answer/note JSON degrades per row with `historyUnavailable`.
- Provider-flagged secrets are redacted before SQLite persistence.
- The `fcba39242` policy correction is preserved: accepted `untrusted` plus live `never` refuses rather than removing required approval.
- The canonical shared Stop schemas and ownership callback seam remain intact. Missing Stop evidence is not promoted to confirmed closure.

### Evidence limitations

Read-only source review only. No tests, `vp check`, typecheck, builds, installs, browser, runtime dispatch or subagents were run. No other reviewer findings were consulted.

Startup invocation remains recovery-owned; accepted-guidance dispatch integration remains guidance-owned. Neither is requested as an edit here.

No real Codex continuation was observed. Even after these source findings are resolved, source acceptance cannot waive the required live continuation gate.
