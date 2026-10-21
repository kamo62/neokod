Pinned HEAD: `670c9cfa7e3a34474da4a95a68eaae8eb3f2498a`. I’ll review the full U06/U07 delta and correction range, tracing the actual ChatView send and recovery paths through server acceptance and deduplication. This is source-only, with no edits or execution checks, and is not a broader Phase 1 approval.The claim is set before `onSend` in memory, but persistence is debounced by 300 ms, so the source does not establish a durable claim before network send. I also found that the plan-follow-up branch bypasses the queued dispatch identity. I’m tracing the resulting acknowledgement and failure paths before assigning findings.Found five P2 findings. No P0 or P1 findings. U06/U07 are not source-closed at this revision.

Pinned branch: `work/core-composer-recovery`  
Pinned HEAD: `670c9cfa7e3a34474da4a95a68eaae8eb3f2498a`

Reviewed the complete `cc054117d..670c9cfa7` delta, including `8eed3c91f..670c9cfa7`, the requested docs and previous receipts, and the actual send, persistence, acknowledgement and server-deduplication callers.

## Findings

### 1. P2: The dispatch claim is not durably persisted before network send

**Location:** `apps/web/src/composerDraftStore.ts:3450–3488`; dispatch proceeds at `apps/web/src/components/ChatView.tsx:4520`.

The claim updates Zustand synchronously, but persistence uses the 300 ms debounced storage at `composerDraftStore.ts:73–78,3635`. The claim function returns without flushing or confirming storage.

**Trigger:** An already-persisted queued entry is claimed and accepted by the server, then the renderer crashes before the debounced write runs. Unlike a normal unload, a crash need not execute the `beforeunload` flush. Storage still contains the unclaimed entry. On restart it hydrates with `dispatch: null`, so auto-drain sends it again with fresh IDs.

**Correction:** Persist and confirm the claim before handing it to the send path. A persistence failure must retain the entry without sending. The current claim protects component remounts, but not this crash window.

### 2. P2: An unknown acceptance outcome is treated as failure, discarding the stable retry identity

**Location:** `apps/web/src/components/ChatView.tsx:4406–4414,4444,4512–4517`; equivalent plan classification at `4900,4929`.

Every returned start failure becomes `"failed"`, including transport failure or interruption after server acceptance. The ordinary path restores the prompt; settlement then removes the queued entry because the composer holds its text. The plan path similarly returns `"rejected"` and restores its snapshot.

**Trigger:** The server commits `thread.turn.start`, but the connection drops before the response arrives. With the original draft still empty, recovery restores the text and deletes the queue’s command/message identity. Sending that restored draft creates fresh IDs and can execute the already-accepted request again.

An eventual history acknowledgement does not remove the restored composer text.

**Correction:** Distinguish definitive pre-send/rejection failures from unknown post-dispatch outcomes. Keep unknown attempts under their stable identity and reconcile them against authoritative evidence rather than converting them into an ordinary retry draft.

### 3. P2: Queued sends entering the plan-follow-up branch lose both stable IDs

**Location:** `apps/web/src/components/ChatView.tsx:4121–4124,4817,4875–4898`.

`dispatchQueuedMessage` supplies `queuedDispatch`, but `onSend` does not pass it into `onSubmitPlanFollowUp`. That helper generates a fresh message ID and omits the claimed command ID from `startThreadTurn`.

**Trigger:** Queue feedback while a plan turn is running. When the turn settles with an actionable plan, auto-drain enters the plan-follow-up branch. Reload after server acceptance but before the send promise settles.

The persisted claim hydrates as unconfirmed, but its recorded message ID never appears in history because a different ID was actually sent. Once the refinement finishes and another plan is ready, **Send again** generates another fresh command/message pair and duplicates the feedback.

**Correction:** Carry the claimed identity through every send branch, including plan follow-ups. Acknowledgement must correlate with the identity actually submitted.

### 4. P2: Clearing the remaining ref-only blockers can still strand another thread’s queue

**Location:** `apps/web/src/components/ChatView.tsx:4522–4524,4568–4602`.

The added dependencies cover the state-backed blockers, but `dispatchingQueuedMessageRef` and `sendInFlightRef` remain non-reactive. Clearing them does not schedule another drain evaluation.

**Trigger:** A queued send from A is awaiting its start response. Navigate directly to B, whose queue is ready and whose composer is empty. B’s drain returns because A’s dispatch ref is still set. The route reset clears local dispatch state at `3695–3697`. A then succeeds while B’s listed dependencies remain unchanged.

Successful settlement updates A’s queue and clears the refs, but does not change B’s drain dependencies. B’s retained queue remains idle until another relevant change occurs.

**Correction:** Make dispatch ownership/readiness reactive and scoped, or explicitly schedule reevaluation when the blocking invocation releases ownership.

### 5. P2: After an unmount, the restore guard can reset another composer’s active cursor

**Location:** `apps/web/src/components/ChatView.tsx:4038–4047`.

The target comparison is correct while the same `ChatViewContent` instance follows route changes. After unmount, however, its `composerDraftTargetRef` retains A. Its `composerRef` can still point to the shared root-level handle, now owned by B.

**Trigger:** Send from A, navigate Home so A unmounts, then open B and type a newer draft while A’s request remains pending. When A rejects, restoring A’s empty durable draft succeeds. The old instance compares A with its stale A ref and calls B’s current `resetCursorState` using A’s prompt.

This moves B’s focused selection and can open A-derived completion triggers. The editor applies the changed cursor to the focused selection at `apps/web/src/components/ComposerPromptEditor.tsx:1432–1469`.

**Correction:** Allow the durable restore into A, but require live mounted ownership of the current composer handle before changing cursor or interaction refs.

## Deduplication qualification

The ordinary send branch does preserve the claimed IDs through client-runtime command construction. It does **not** preserve an immutable command payload: it regenerates `createdAt` and reads current model, effort, modes and prompt formatting.

Server receipt handling at `apps/server/src/orchestration/Layers/OrchestrationEngine.ts:140–162` checks the command ID and aggregate identity, then returns the stored accepted sequence. It does not compare command type or payload identity. Schema decoding and normalisation do not establish that equality either.

Therefore, same-ID retry provides receipt deduplication, not validated identical-payload replay. The worker’s assurance should not be read more broadly than that.

## Checks with no additional P0–P2 finding

- History acknowledgement reads the route’s environment/thread-scoped `activeThread`, not optimistic messages from another thread.
- Within a surviving component instance, ordinary and rejected-plan restoration correctly targets A across A→B and A→B→A.
- The store’s emptiness check preserves newer durable draft content.
- In-flight entries no longer expose Remove or Steer controls.
- The added state-backed blocker dependencies address the previously reported reconnect dependency gap, subject to finding 4.

Source-only review. No files changed; no tests, builds, app/browser/provider actions, child agents or external messages. Worker-reported checks were not rerun. This is not broader Phase 1 approval.
