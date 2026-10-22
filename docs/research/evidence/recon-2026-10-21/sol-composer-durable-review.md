HEAD matches the requested pin. I’ll trace the U06/U07 scope and corrected dispatch/recovery paths from source. No tests or runtime checks will be run.The ordinary queue path now flushes and reads back the claim before sending, and queued plan follow-ups receive the claimed IDs. I found remaining gaps in unknown-outcome handling and current-target ref protection; I’m checking their triggers against the real callers and accepted scope.Found three actionable P2 findings. No P0 or P1 findings. U06/U07 are not source-closed.

Branch `work/core-composer-recovery`; HEAD confirmed at start and end as `397e8ae280ea70518dff932d40163037dc8f7105`. Working tree remained clean.

### 1. P2: The RPC error tag does not establish definitive rejection

Location: `apps/web/src/components/ChatView.logic.ts:359–360`, with settlement at `387–388`.

`OrchestrationDispatchCommandError` wraps infrastructure failures as well as actual command rejections. For example, the receipt lookup at `apps/server/src/orchestration/Layers/OrchestrationEngine.ts:140–142` can fail before determining whether the command was previously accepted. `apps/server/src/ws.ts:1646–1651` wraps that failure in the same RPC error tag.

Trigger: an earlier send was accepted but remains locally unconfirmed. An explicit same-ID retry encounters a receipt-read database error. The classifier calls this `"rejected"`, settlement changes the entry to `"failed"`, and the next retry generates fresh IDs at `ChatView.tsx:4553–4557`. That can submit the already-accepted request again while its history acknowledgement remains unavailable.

Correction: preserve uncertainty for generic dispatch errors. Only affirmative rejection evidence that resolves the original command’s acceptance should release its stable retry identity.

### 2. P2: The post-claim navigation guard downgrades an earlier unknown attempt

Location: `apps/web/src/components/ChatView.tsx:4580–4584`.

The post-claim guard unconditionally calls `markQueuedComposerMessageFailed`, including when `previouslyUnconfirmed` is true.

Trigger: retry an unconfirmed entry, then a route change or unmount trips this guard after the awaited claim. This retry was not sent, but that says nothing about the earlier attempt. The entry nevertheless becomes “Not sent”. Its next explicit retry uses fresh command/message IDs, potentially duplicating the original accepted request.

Correction: settle this exit as `"not_attempted"` through the existing prior-state-aware policy, or explicitly retain `"unconfirmed"` for an earlier unknown attempt. A first attempt may become `"failed"`.

### 3. P2: Unknown settlement can clear a newer composer’s prompt ref

Location: `apps/web/src/components/ChatView.tsx:4589–4596`.

Temporary prompt cleanup checks only string equality. It does not check current target, mounted ownership, or whether the text belongs to a newer durable draft.

Trigger: queued text such as `continue` is sending from A. Navigate directly to B and type the same text before A settles with an unknown outcome. A’s settlement clears the shared `promptRef`, although B’s visible and stored draft still contains `continue`.

`ChatComposer.tsx:1356–1359` only resynchronises that ref when its prompt dependencies change, so an unrelated rerender does not repair it. The next send reads the empty ref at `ChatView.tsx:4115`: an ordinary send does nothing, while a plan follow-up can interpret the apparently non-empty feedback draft as an empty submission and implement the plan instead. A newer identical draft in A has the same problem.

Correction: clear only the invocation-owned temporary copy, with live target ownership and a check that no newer stored draft owns the text.

### Direct-send scope

The stated lack of durable identity for ordinary non-queued sends is not a separate finding: U06 explicitly excludes changing those sends (`docs/plan-cards/05-ui-data-loss-and-handoff.md:399`). U07 does cover direct plan-follow-up failure/no-send restoration; that path remains present at `ChatView.tsx:4155–4162`, using the original-target, empty-only restore helper. The limitation must not be read as excluding that U07 requirement.

Source-only review of the original delta and corrections, especially `670c9cfa7..397e8ae28`, with the requested documents and receipts read in full. No files changed, execution checks, apps/browser/provider calls, child agents or publication actions. Worker-reported unit evidence was not rerun and is not runtime proof.
