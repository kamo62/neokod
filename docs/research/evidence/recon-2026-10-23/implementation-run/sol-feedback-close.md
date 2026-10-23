REQUEST_CHANGES

Reviewed exact HEAD `7574eb45044295f9a5f2884fb93f229f11ad43cc`, diff `8521d00c1..HEAD` and affected callers. Worktree clean.

1. P2: publication cancellation leaves durable requests pending. In [AgentRuntime.ts:837](/Users/kamogelo/.codex/worktrees/neokod-feedback/t3code/apps/server/src/symphony/Runner/AgentRuntime.ts:837), also mirrored for user input, interruption after the row is inserted only withdraws the Deferred. The durable finaliser is installed later, around the wait. Scope closure during publication can therefore leave an advertised pending request with no waiter. Registration also precedes cleanup installation. Bounded fix: acquire registration and install cleanup atomically, covering publication and waiting; restore interruptibility for publication/provider waits and preserve already-decided rows.

2. P2: unsuccessful settlement can erase delivery-unknown history. In [ApprovalService.ts:724](/Users/kamogelo/.codex/worktrees/neokod-feedback/t3code/apps/server/src/symphony/Runner/ApprovalService.ts:724) and the corresponding `interrupt` branch at line 753, `abortDelivery` runs without requiring `claimed`. After restart, a previously consumed delivery has neither an in-memory receipt nor a live entry. Calling either operation clears its answer/note and overwrites its staged decision despite unknown delivery. Bounded fix: require positive settlement or exact-withdrawal evidence before destructive abort; otherwise preserve staged content and decision through reconciliation.

Source inspection supports the protected stage → claim → receipt sequence without a provider wait, typed reconciliation results with successful-only counting, sensitivity normalisation/redaction, non-retryable secret history-pending wording, staged-decision history projection, typed child-ownership evidence, and unknown Stop returning `ok:false`.

Limits: source-only; no checks executed, edits, browser, subagents or other reviewer findings consulted. Recovery/Dispatcher consumption and UI parent presenters remain in their separate lanes. Live Codex continuation remains unobserved.
