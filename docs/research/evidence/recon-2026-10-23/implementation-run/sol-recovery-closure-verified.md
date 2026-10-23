Blocking source defect, P1. Cannot ACCEPT `4c9587615`.

[Dispatcher.ts:1397](/Users/kamogelo/.codex/worktrees/neokod-recovery/t3code/apps/server/src/symphony/Runner/Dispatcher.ts:1397) passes `knownNoSpawn: !spawnedAttempts.has(key)`. After restart that in-memory set is empty. A current, non-terminal attempt with an exact `issue_claimed` binding and null persisted PID therefore receives `no_owner_recorded`, even when both the identity write and `ownership_record_failed` event write failed before the crash. Stop then releases the claim at line 1412 and returns confirmed. Handoff can consequently transfer a workspace whose process closure remains unknown.

An absent in-memory entry must remain unknown for a recovered attempt. Recovery and Reconciler already hold this state; Stop still bypasses that correction.

The other requested paths checked at source level: exact token/generation binding, durable intent before interruption, legacy exact confirmation, unreadable-attempt holds, resume fence, receipt-fenced Handoff, shared platform admission and v2 reconciliation reporting.

The missing failed-`stop_requested` regression is acknowledged and being completed serially by guidance. It is separate from this source defect. Live OS/Stop proof remains absent.

Verified both commits and unchanged, clean HEAD. Read-only inspection only; no checks, builds, installs, providers or signals run.
