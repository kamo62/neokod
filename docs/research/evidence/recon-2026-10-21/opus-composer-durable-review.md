I found one P2 regression and one partly open P2. There are no P0 or P1 findings.

**Pinned:** `work/core-composer-recovery` at `397e8ae280ea70518dff932d40163037dc8f7105`, confirmed at the start and end, with a clean tree.

I read README, AGENTS, `state-and-evidence.md`, both earlier closure reviews, the worker receipt and the U-06/U-07 cards (`docs/plan-cards/05-ui-data-loss-and-handoff.md`). I traced the code from `cc054117d` to `397e8ae28`, focusing on `670c9cfa7..397e8ae28`. That covered the client send path into the server's `ws.ts`, `Normalizer.ts`, `OrchestrationEngine.ts` and `decider.ts`.

## Findings

### 1. P2 (new in 397e8ae28): a queued send is timestamped with the time it was queued, not the time it was sent

**Where:**

- `apps/web/src/components/ChatView.tsx:4558-4560` claims a first attempt with `messageCreatedAt: queuedMessage.createdAt`.
- That value is set when the message is queued (`composerDraftStore.ts:3518`).
- `resolveSendIdentity` then uses it as the message and command `createdAt`:
  - ordinary path: `ChatView.tsx:4255-4261`, `4307`, `4374`, `4440`
  - plan follow-up path: `4955-4961`, `5001`, `5043`

**What goes wrong:**

- The server copies `command.createdAt` into the user message, the event `occurredAt` and the turn's `requestedAt` (`decider.ts:427-467`, `ProjectionPipeline.ts:1088`).
- Server snapshots order messages by `created_at` (`ProjectionSnapshotQuery.ts:799`), and the client timeline also sorts by `createdAt` (`session-logic.ts:1612-1614`).

**Trigger:** queue a message while turn N runs, then let turn N keep producing output for a while.

- When the queue drains, both the temporary on-screen copy and the saved copy of the message sort into the middle of turn N's later output, not after it.
- The new turn's measured duration also includes the time the message waited in the queue.
- Before this commit, the send path used the send time.

The store tests name this value `attemptedAt`, which suggests the wiring does not match the intent.

**Fix:** set `messageCreatedAt` to the first attempt's time, keep it across retries, and never use the queued entry's `createdAt`.

### 2. P2 (prior finding 1, partly closed): the readback does not prove the claim is on disk, and a lost claim still auto-resends with new IDs

**Where:**

- `composerDraftStore.ts:2383-2424`: `confirmQueuedDispatchPersisted` flushes and then reads back from `localStorage`.
- `ChatView.tsx:4555-4557`: a first attempt still gets random IDs.
- `composerDraftStore.ts:2336`: on reload, an `in_flight` claim becomes `unconfirmed` only if the claim was actually saved.

**What goes wrong:** this is an inference about platform behaviour; I did not observe it.

- In Electron, the renderer's `getItem` reads its own in-memory copy. The browser process writes that data to disk later, after a batching delay of a few seconds.
- So the readback proves that the debounce flushed and the write did not throw. It does not prove the claim reached disk.
- This now covers a renderer-only crash. It does not cover the whole app being killed, which was part of the earlier trigger.

**Trigger:** a queued send is accepted, then the app is force-killed (SIGKILL, a main-process crash or a power loss) before Chromium writes to disk.

- On restart the entry loads with `dispatch: null`.
- The automatic queue then sends it again with new IDs, so the server's command-ID check cannot catch the duplicate.

**Fix:** derive the first attempt's command and message IDs from the queued entry's saved `id`. A lost claim then replays under the same command ID, and the server returns the original accepted result. After a definite failure, keep using fresh, distinct IDs.

## Checks that hold, with no P0 to P2 finding

- **Storage failures stop the send:** a memory-only fallback, a write error or a readback mismatch returns `not_persisted`. Nothing is sent, and the entry goes back to its previous state or to `failed`. A `failed` entry is never sent automatically, so there is no retry loop.
- **Error classification:**
  - `EnvironmentRpcUnavailableError` comes only from `currentSession()` before the request goes out.
  - `OrchestrationDispatchCommandError` covers server-side failures. For a first attempt, the engine's transaction and receipt make it reliable evidence that nothing was saved.
  - Transport errors (`RpcClientError`) and interrupts count as "unknown".
  - `squashAtomCommandFailure` keeps the error's `_tag`, which the classifier relies on.
- **An earlier unknown attempt is not downgraded:** a `not_sent`, `not_attempted` or `not_persisted` result on a retry keeps the entry `unconfirmed`. With `preserveUnknownOnFailure` set, the text is not restored to the composer.
- **The queued plan follow-up carries the claimed IDs:** `messageId` and `commandId` are passed into `thread.turn.start` (`ChatView.tsx:4153`, `4955-4961`, `5022-5024`). The acknowledgement check matches them by `messageId`.
- **Temporary messages and retries:** a failed queued attempt always removes its temporary message by ID, and a retry replaces it rather than adding a second copy. "Send again" uses the same check as the handler. Retrying an `unconfirmed` entry keeps its IDs; retrying a `failed` entry gets new ones.
- **Restores cannot overwrite newer work:** a restore writes only when the target's saved draft is empty. Editor state and the cursor change only when this instance is still mounted and that target is still on screen.
- **Direct (non-queued) sends:** the remaining limitation is consistent with the plan. U-06 says "Do not … change what onSend does for non-queued sends". U-07 step 1 says to restore on every failure, including an interrupted send. The plan does not support any further requirement here.

## Below P2

1. **Navigation guard after the claim** (`ChatView.tsx:4580-4581`): if the view unmounted or changed target during the claim, it marks the entry `failed` even when it was previously `unconfirmed`. The next retry would then get new IDs. With synchronous `localStorage`, the window between claim and send cannot overlap a navigation, so I found no way to trigger this.
2. **Retrying an unknown send:** if that retry hits a server error before the receipt lookup (startup readiness failure, or an SQL error reading the receipt), it is classified as rejected and the entry becomes `failed`. Matching the original `messageId` against the thread history would still clear the entry if the first attempt was accepted.
3. **Readback decodes the whole store:** any saved draft that fails the schema would block queued sends on every thread. I found no concrete trigger.

No edits, tests, builds, app, browser or provider calls, subagents, commits, pushes or messages. The worker's unit tests run against a storage mock, so they do not show runtime crash or kill behaviour.
