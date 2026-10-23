I’ll review the bounded correction range and affected production callers at the specified HEAD. I’ll use read-only source inspection and keep final runtime/browser validation as a separate evidence gate.The source preserves the lost-dispatch guard on unchanged capped reads and keeps Stop outcomes without positive closure evidence unknown. I’m checking the new detail reprojection and feedback history paths for any remaining loss of identity, freshness or delivery evidence.## REQUEST_CHANGES

Reviewed **`6debed050336ff904056d80d9f7e6013f975c7b0`**, range `0967ea61a..HEAD`. HEAD matched at the start and end; working tree remained clean.

### 1. P2: Newly staged feedback is never reconciled on production startup

**Paths:** `apps/server/src/symphony/Runner/ApprovalService.ts:733–750`; production startup caller `apps/server/src/symphony/Orchestrator/Layers/SymphonyOrchestratorLive.ts:1073–1103`.

- **Trigger:** The server restarts after `stageDelivery` persists an answer/note but before delivery history is finalised.
- **Problem:** `reconcileUncertainDeliveries` correctly preserves the content and changes unreceipted staged rows to `interrupted`, but no production caller invokes it. The existing recovery and expiry paths read only `pending` rows. A fresh service also refuses to finalise the surviving `delivering` row because its process-local receipt is absent.
- **Impact:** The row remains indefinitely “delivery pending” despite having no live waiter, and disappears from attention. Exact-run history retains the content, but the implemented restart reconciliation never occurs.
- **Bounded fix:** Invoke the existing reconciliation operation in the leadership-owned startup recovery path. Preserve content as delivery-unknown; do not resend it. Extend the existing startup regression to exercise this production wiring rather than calling the helper directly.

### 2. P2: The production Stop-all presenter still discards the new evidence

**Paths:** new response mapping `apps/server/src/ws.ts:464–480`; caller `apps/web/src/components/symphony/SymphonyGlobalControls.tsx:76–85`; presenter `apps/web/src/components/symphony/globalControls.logic.ts:79–80`.

- **Trigger:** Stop-all returns `{ok:false, confirmed:1, held:1}`, or a legacy acknowledgement without confirmed/held counts.
- **Problem:** The production caller passes only `ok` to `stopAllMessage`. A mixed confirmed/held result therefore becomes **“No runs were running.”** A legacy positive boolean becomes **“Stopped the running work”**, although the new contract explicitly provides no positive closure evidence in that shape.
- **Impact:** Stop-all conceals held ownership or claims closure from missing evidence. The improved single-run Stop presenter does not cover this caller.
- **Bounded fix:** Present the complete typed Stop-all result: distinguish confirmed, held and missing evidence, and explicitly retain ownership for held work. Add a focused regression to the existing global-controls logic tests.

### Remaining review result and limits

The bounded source inspection supports the exact-request/attempt routing, including older and outside-board requests; capped exact-run enrichment through the shared projection; delivering/interrupted history content and malformed-history cues; neutral accepted-brief fallback; refusal retention through terminal-to-queued transitions; and the extracted refusal-helper regression. Unchanged capped reads do **not** clear unknown dispatch admission, and I recommend no relaxation of that guard.

Read-only source review only. No files changed, tests, checks, builds, installs, browser use or subagents. Required repository checks were not run under the explicit restriction. Responsive-header behaviour and final matching-runtime Chrome validation remain separate integration evidence gates; provisional captures do not close them.
