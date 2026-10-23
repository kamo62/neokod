## Verdict: REQUEST_CHANGES

I found no P0 or P1 issues. Four P2 issues fall directly within the correction items you named: startup unknown handling, malformed rows, secret redaction, and the delivering retry or stage-to-claim behaviour. Each fix stays inside the feedback lane.

**Head and cleanliness:** `8521d00c1eb4e19446ecfce11da80488674c33ea` on `feat/neokod-feedback`. `git status --porcelain` is empty. Local `origin/feat/neokod-feedback` points to `dd032f867`, so the two correction commits had not been pushed when this checkout last fetched.

### What holds

- **Delivering retry:** a retry of a `delivering` row now needs the in-memory `consumedDeliveries` receipt (`ApprovalService.ts:443-452, 523-527, 598-602`). After a restart or crash, a staged row cannot be finalised as `answered` or `approved`. The restart test covers this.
- **No false finalisation from stage to claim:** if the live claim never happened, no receipt exists. A retry fails, and neither `completeDelivery` nor the timeout path marks the row decided.
- **Register before publication:** both approvals and questions register the live request before `recordRequest`. On `record_failed`, `duplicate_decided` or `duplicate_mismatched`, the runtime withdraws the entry and returns a provider error (`AgentRuntime.ts:790-842, 865-918`). The production `Live.ts` spreads `approvalServiceRequestCallbacks`, so `requestSettled` is wired.
- **Settled request closure:** a failed Deferred leads to `settled`, then `requestSettled`, then `interrupt`, which writes `interrupted` for a `pending` row. This is safe when it races with `expire`/`interrupt` because `expireRequest` waits on the semaphore first.
- **Duplicate identity:** the check compares `reason`, `command`, `action` or `providerAction`, and the canonical decoded question payload. Both sides are schema-decoded, so field order is stable.
- **Permission narrowing:** `narrowAcceptedPermissions` and the `Prompt.ts` message are byte-identical to `fcba39242`. The resulting table is sound, and `on-failure` is mapped to `on-request` before narrowing:

  | Accepted     | Live              | Result      |
  | ------------ | ----------------- | ----------- |
  | `never`      | approvals enabled | conflict    |
  | `untrusted`  | `never`           | conflict    |
  | `on-request` | `never`           | `never`     |
  | `untrusted`  | `on-request`      | `untrusted` |

- **Stop schema and callback seams:** the correction diff does not touch `rpc.ts`, the `ws.ts` Stop path or `SymphonyStopClosure`/`SymphonyStopOutcome`. Absence still means unknown.

### Findings

**P2-1: A split stage-to-claim leaves a stale `delivering` row and a waiting agent**

- **Trigger:** the RPC handler is interrupted after `stageDelivery` and before the live claim. `RpcServer` interrupts handler fibers on a client `Interrupt` or disconnect. The same state follows if the claim fails and `abortDelivery` also fails.
- **Path:** the row is `delivering` with no receipt while the live entry still waits. A retry fails with "no longer pending", and the pending attention item is gone.
  - When the runtime times out, `expireRequest` wins the claim but only closes `pending` rows (`ApprovalService.ts:723-728`).
  - `expire`/`interrupt` call `decide`, which filters `WHERE state='pending'` and does nothing.
- **Impact:**
  - The provider receives a decline or an error.
  - Durable history stays "Delivery unknown; local acceptance recorded" until a restart reconciliation that is not wired yet.
  - For approvals, the stored `decision` stays `approved` although the agent received a rejection.
  - The server had positive evidence (it won the claim) but did not record it.
- **Bounded fix:**
  1. Make stage, live claim and `markConsumed` one uninterruptible section, or abort the staged row on interrupt when no receipt exists.
  2. In `expireRequest`, `expire` and `interrupt`, when the settle claim is won and the row is `delivering` without a receipt, close it with `abortDelivery(expired|interrupted)`. Winning the claim proves the staged content was not delivered.
  3. Add one regression that interrupts after staging.

**P2-2: The startup reconciliation API turns unknown into zero**

- **Trigger:** `listDelivering` fails on SQL, or any one row fails `rowToApproval`. Separately, any `reconcileDelivery` write can fail.
- **Path:** a list failure is caught and returns `[]`, so the count is `0` (`ApprovalService.ts:736-738`). A failed row write is logged but still counted (`:744-747`).
- **Impact:** the recovery caller cannot tell "nothing staged" from "could not read". Rows can stay `delivering` indefinitely while the reported count is 0 or overstated. This breaks the state-and-evidence rule that missing evidence is not a default.
- **Bounded fix:** return a typed outcome, for example `{ reconciled, failedIds }`, or fail when the list is unavailable. Count only confirmed updates. Make the method required on `ApprovalServiceShape`. The recovery lane keeps the startup call.

**P2-3: Malformed-row tolerance covers only the answer and note columns**

- **Trigger:**
  - A malformed `payload_json`, which is still a hard decode error (`ApprovalRepository.ts:75-86`).
  - Any `decodeApprovalRequest` failure.
- **Path:** `listForRun`, `listPending` and `listDelivering` decode the whole list with `Effect.forEach(rows, rowToApproval)`, so one bad row fails the whole list. `ApprovalService.listForRun`/`listPending` then return `[]`.
- **Impact:**
  - Run details and attention show no requests at all.
  - `requestSettled` cannot close the run's rows.
  - Reconciliation reports 0.
  - The `historyUnavailable` marker is also dropped by `approvalRequestHistory`, so a corrupt answered row looks like a legacy row that never stored an answer.
- **Bounded fix:**
  1. Degrade `payload_json` the same way as answer and note (empty payload plus `historyUnavailable`).
  2. Carry `historyUnavailable` through the projection in `attention.logic.ts`.
  3. Extend the existing per-row repository test with a bad `payload_json`.

**P2-4: The UI masking rule differs from the server redaction rule, and redacted retries promise something they cannot do**

- **Masking mismatch:**
  - **Trigger:** a question titled, for example, "API key" with no `isSecret` flag.
  - **Path:** the server redacts on `SENSITIVE_QUESTION_PATTERN`, but `SymphonyApprovalActions.tsx` masks and warns only when `sensitive === true`.
  - **Impact:** the secret is typed in plaintext with no notice, while history stores `[redacted]`.
- **Retry promise:**
  - **Trigger:** `completeDelivery` fails after the receipt exists for an answer that contains a redacted entry.
  - **Path:** the `ApprovalHistoryPendingError(delivered=true)` message tells the user to retry, but the retry always fails because of `hasRedactedAnswer` (`ApprovalService.ts:599`), even with the receipt present.
  - **Impact:** the row stays `delivering` until a restart.
- **Bounded fix:**
  1. Set `sensitive: true` on pattern matches when the server normalises the payload, so the stored payload is the one authority the UI reads.
  2. Either bind the receipt to an in-memory digest of the unredacted answer map and compare that on retry, or stop promising a retry for redacted answers.

### Evidence limitations and residual notes

- **Checks not run:** this was a source-only review. I ran no tests, typecheck or build, used no browser, and did not observe a live Codex continuation. Source acceptance does not satisfy the live gate.
- **Interrupt behaviour:** the claim that RPC disconnects interrupt handlers comes from reading the vendored `RpcServer.ts`, not from a run.
- **Theoretical race:** `withdrawPending` removes by key, not by Deferred identity. It could only misfire if a stale mismatched `pending` row with the same request id exists and a human answers it within the `recordPending` window. That is very unlikely, so I have not raised it as a finding.
- **Settlement at run end:** whether `requestSettled` fires depends on the runtime scope staying open after `settleRun`. It is best effort, and startup recovery remains the backstop. Dispatcher and Recovery are outside this lane.
- **Approval duplicate identity:** the check cannot see provider parameters that are never stored, such as `cwd` or file changes. This is not a regression.
- **Production UI:** the history projection is not yet used by any production component; that belongs to the UI lane. The startup caller for reconciliation belongs to the recovery lane, and accepted-guidance dispatch belongs to the guidance lane. I have not asked for edits there.
- **Ownership and integration:**
  - `8521d00c1` edits `AcceptedGuidance.ts`, `Prompt.ts` and their tests, which the guidance lane owns. The narrowing hunk is identical to `fcba39242`.
  - The guidance branch also carries later manual-source changes, including a contract edit in `ee0e45c92` to a file the feedback lane owns. The coordinator should reconcile that at integration.
