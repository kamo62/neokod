HEAD and `work/core-composer-recovery` both match `7d6f33890445b7c35d0d45975778d03a8dcfcc09`; the worktree is clean. I’ll read the required context, trace the exact diff and its callers, then recheck HEAD. I’ll report only actionable P0–P2 findings or explicit none, with no execution or file changes.The correction now preserves unknown outcomes for generic dispatch errors, uses prior-aware settlement at the post-claim route guard, and passes queued text without writing or clearing `promptRef`. I’m checking the actual command/receipt replay path and the normal and plan-follow-up callers, including timestamp reuse and manual failed retries.Found one actionable P2. No P0 or P1 findings.

### P2: Losing a manual failed-retry claim still permits a duplicate accepted send

Source: `apps/web/src/components/ChatView.logic.ts:476–480`, called with newly generated IDs at `apps/web/src/components/ChatView.tsx:4594–4599`.

Deterministic identity protects a lost first-attempt claim, but the `"failed"` branch generates unrelated IDs each time the same saved failed record is retried.

Trigger, under the browser-cache loss condition acknowledged by this correction:

1. A queued entry’s failed dispatch A has reached disk.
2. “Send again” creates identity B. Its claim passes browser-storage readback, and the server accepts B.
3. A whole-app kill loses the replacement claim before the browser flushes it to disk.
4. Restart restores failed dispatch A. Even if history contains accepted message B, acknowledgement cannot remove the entry: `selectAcknowledgedQueuedMessageIds` matches only A’s saved message ID (`ChatView.logic.ts:577–579`).
5. Another “Send again” creates identity C. The server receipt lookup deduplicates by command ID (`OrchestrationEngine.ts:140–157`), so B’s receipt does not prevent C from submitting the request again.

Correction: make the replacement identity recoverable and repeatable from the saved failed record, while remaining distinct from the failed attempt, rather than minting unrelated IDs whenever that same record reappears.

The other requested correction paths have no additional actionable P0–P2 findings: generic dispatch errors remain unknown, prior-unknown route exits retain uncertainty, queued prompt handling no longer mutates or clears the shared draft, and retained claims reuse first-attempt timestamps. Both normal and queued-plan callers carry the claimed identity. U06 direct ordinary-send scope and U07 direct plan restoration remain preserved.

Branch and HEAD matched `7d6f33890445b7c35d0d45975778d03a8dcfcc09` at start and end; the worktree remained clean. Reviewed `397e8ae28..7d6f33890` with the required documents, prior reviews, receipt and earlier-path context. No edits or execution checks were performed. This is a static conditional failure analysis, not runtime crash proof.
