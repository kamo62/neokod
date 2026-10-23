I’ll verify the exact HEAD and clean status, read the specified docs, then trace the bounded corrections and affected production callers. I’ll use read-only source commands and won’t consult other reviewers’ findings.The attempt binding is persisted before provider spawn, and Stop, recovery and reconciliation use its token/generation rather than timestamps. The production runtime callback is now typed end to end. I’m checking failure and restart paths next, particularly whether missing evidence can still permit a release or retry. Guidance dispatch wiring remains outside this completion claim.## REQUEST_CHANGES

Reviewed exact HEAD `cac7f69450abc2d559111fdbecc7147170e2d13a`, covering `6bf90281da3014fe480c18790cb337a76c96972e..HEAD` and affected production callers. The worktree was clean at both status checks; HEAD remained unchanged.

The following are bounded correction or affected-caller gaps. No P0 finding.

### 1. P1: Legacy cancellation is still promoted to confirmed closure

**Path:** `apps/server/src/symphony/Runner/Dispatcher.ts:1092–1103`; consumed by `apps/server/src/symphony/HandoffService.ts:286–343`.

**Trigger:** The latest attempt is `user_cancelled` and the current row has no owner token, but there is no authoritative `stop_confirmed` evidence. The branch returns `confirmed` before checking the attempt binding or closure history.

**Impact:** Legacy cancellation that cleared ownership without proving process exit becomes a successful canonical Stop response. Takeover accepts that response and can transfer the workspace despite unknown surviving work. `getRun` correctly leaves closure absent, so RPC and detail can disagree.

**Bounded fix:** Require durable, exact-attempt confirmed-closure evidence for an idempotent confirmed response. Cancellation status and absent ownership alone must remain held/unknown.

### 2. P1: Unreadable attempts bypass binding and process-closure checks

**Path:** `apps/server/src/symphony/Orchestrator/Recovery.ts:259–282`; new decoding in `apps/server/src/symphony/Persistence/Layers/RunAttemptRepository.ts:238–258`.

**Trigger:** `latestForWorkItem` fails, including because accepted-guidance JSON fails the new validation. Recovery converts that failure to `null`, treats it as “no attempt”, then releases an older claim based on its timestamp.

**Impact:** A claim with a live, legacy or unverifiable owner can be queued without checking `issue_claimed` or process closure. If the ownership read also fails, the release is passed no fence.

**Bounded fix:** Distinguish unreadable evidence from a positively missing row. Hold on read/decode failure; do not use the no-attempt shortcut to release unknown process ownership or issue an unfenced release.

### 3. P1: Stop intent remains best-effort and fails open

**Paths:** `apps/server/src/symphony/Runner/Dispatcher.ts:330–334, 1045–1052, 1110–1115`; `apps/server/src/symphony/Orchestrator/Recovery.ts:121–138, 334–378`; `apps/server/src/symphony/Orchestrator/Reconciler.ts:213–249`.

**Trigger:** Stop-event persistence fails before interruption, or the pending-Stop read fails after restart. Event-write errors are swallowed; the pending-intent reader converts failure to `false`.

**Impact:** Once the in-memory stopping marker is lost, recovery/reconciliation can interpret an explicit Stop as ordinary interrupted work and queue or retry it.

**Bounded fix:** Persist Stop intent successfully before interrupting work. Treat an unreadable intent as unknown and hold, rather than “no Stop”. Propagate persistence failure without acknowledging durable acceptance.

### 4. P1: Ownership-record failure can still publish a retry for a spawned child

**Paths:** `apps/server/src/symphony/Runner/AgentRuntime.ts:367–420`; `apps/server/src/symphony/Runner/Dispatcher.ts:693–723, 907–921, 424–474`.

**Trigger:** The child spawns, but persisting its identity fails while the same claim remains current.

**Impact:** The runtime refuses provider requests, but converts the ownership error into an ordinary spawn error. Dispatcher failure handling then reads a null persisted PID, accepts `no_owner_recorded`, and can move the item to `retry_scheduled` before confirmed child/group closure. The outer resource scope is not itself closure evidence.

**Bounded fix:** Preserve the ownership-failure distinction through dispatch cleanup. Positive knowledge of a spawned child must override a null database PID: retain the claim until that child/group is confirmed closed, with restart-visible uncertainty where necessary.

### 5. P2: Takeover parks a freshly sampled cancellation, not its Stop receipt

**Path:** `apps/server/src/symphony/HandoffService.ts:290–343`; Stop outcome at `apps/server/src/symphony/Runner/Dispatcher.ts:79–91`.

**Trigger:** After takeover confirms Stop for attempt A, workspace validation yields. An explicit restart creates attempt B, which is subsequently cancelled. The original takeover then reads B’s cancellation generation and parks it.

**Impact:** The generation CAS protects only the freshly sampled row, not the cancellation produced by A’s Stop. A stale takeover can adopt a replacement attempt’s cancellation and transfer authority using A’s context.

**Bounded fix:** Carry the exact released generation in the confirmed Stop receipt and park only that generation, bound to the original attempt. Refuse if a replacement intervened.

### 6. P2: Manual provenance is still relabelled as a tracker source

**Path:** `apps/server/src/symphony/Runner/AcceptedGuidance.ts:166–172, 196–199`; contradictory canonical contract at `packages/contracts/src/symphony.ts:293–299`.

**Trigger:** Freeze guidance for a manual work item under, for example, a Linear workflow.

**Impact:** The snapshot records `source.kind: "linear"` rather than `"manual"`, despite the corrected contract explicitly supporting manual provenance. The current test at `AcceptedGuidance.test.ts:218–227` enshrines this incorrect result.

**Bounded fix:** Preserve `workItem.source.kind` directly and correct that focused assertion. This is a prerequisite defect, not evidence that production guidance dispatch is wired.

### 7. P2: Unsupported-platform refusal is lost at the production admission boundary

**Paths:** `apps/server/src/symphony/Runner/Dispatcher.ts:558–568`; `apps/server/src/symphony/Orchestrator/Layers/SymphonyOrchestratorLive.ts:1861–1881, 1924–1934`.

**Trigger:** An explicit dispatch reaches an unsupported platform.

**Impact:** Dispatcher safely refuses before claiming or spawning, but the production caller has already forked execution and returns `{ status: "started" }`. The refusal becomes a log entry rather than an admission result or visible story reason.

**Bounded fix:** Apply the shared platform-capability gate before acknowledging dispatch, returning the existing typed refusal shape with a concrete reason.

### Source-confirmed progress and limits

- The required `issue_claimed` token/generation binding is written before provider spawn. The inspected attempt-association paths no longer use timestamp ordering, including same-millisecond replacement claims.
- Atomic ownership reads and null-safe identity CAS predicates are present.
- The production ownership callback is genuinely typed through the factory and runtime.
- Canonical Stop RPC schemas preserve confirmed/held outcomes. `getRun` projects exact-attempt closure from authoritative events.
- Startup staged-delivery reconciliation is awaited inside leadership recovery before scheduler dispatch.
- Board loading adds no per-item full-event reads. Absent board closure remains unknown.
- Production accepted-guidance admission, persistence and dispatch wiring remains the next serial owner’s work and is **not complete**.

Read README, AGENTS, state-and-evidence and plan §§16.15–16.17. This was source-only inspection: no edits, tests, `vp check`, typecheck, builds, installs, browser use or subagents. No other reviewer findings were consulted. Runtime behaviour and live continuation were not established.
