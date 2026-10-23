**Verdict: request changes.** Reviewed SHA `1ece8efe988c5ed81682329409bb8a4cf1b9342e`. I confirmed it through `.git/refs/heads/feat/neokod-guidance`. The tree was clean per the session's git snapshot; I couldn't re-check that, since I had read-only tools and ran no commands. Everything below comes from reading source only. It proves nothing about live Codex, browser or runtime behaviour. I haven't read any other reviewer's findings.

The diff carries the feedback lane (S1–S5) as well as the guidance lane. The two blockers are in feedback-owned code, but both ship at this SHA.

## P1 — No Symphony question can be answered from the UI anymore

- **Trigger:** any live Symphony question shown in the project Attention list or the run page.
- **Path:** `SymphonyApprovalActions.tsx` now needs a `questionPayload` to show answer controls. When it's missing, the component only says "This request did not record answerable questions."
  - The two production callers don't pass it, or `runAttemptId`: `SymphonyAttentionList.tsx:60` and `SymphonyRunDetailView.tsx:304`. Both pass only `requestId`, `mode` and `onDone`.
- **User impact:** before this change the operator could answer with free text. Now every question can't be answered, so it waits out the timeout and expires, and the agent gets an error. That blocks the S1–S5 "answer continues the same work" acceptance.
- **Bounded fix:**
  - `SymphonyRunDetailView`: find the matching request with `details.approvalRequests.find(r => r.id === item.id)` and pass its `questionPayload` and `runAttemptId`.
  - `SymphonyAttentionList`: the rows come from `AttentionItem`, which has no question payload. Either the shared contract owner adds the payload to the item, or the list joins `listPending`.
  - Add one test that renders a question through each production caller.
  - `SymphonyRunDetailView` belongs to the Work UI lane and `SymphonyAttentionList` has no owner, so the coordinator needs to assign this.

## P1 — A blank option description makes the request unreadable and hides every pending approval

- **Trigger:** Codex sends a question option whose `description` is `""` or only spaces. Codex's own schema allows this (`description: Schema.String`, `schema.gen.ts:3166`).
- **Path:**
  - `AgentRuntime.ts:452` turns it into `""` and stores it.
  - The stored shape reuses `UserInputQuestion.fields` (`symphony.ts:723-724`), where an option description must be non-empty (`providerRuntime.ts:556-559`). So reading the row back fails, in every path that reads it.
- **User impact:**
  - `getById` fails, so `respondToUserInput` reports "not found" and the question can't be answered.
  - `listPending` and `listForRun` stop at the first bad row (`ApprovalRepository.ts:327,338`). `ApprovalService.ts:504-508` turns that failure into `[]`, so _all_ pending approvals, including permission approvals, vanish from the UI. Unknown is shown as zero.
- **Bounded fix:**
  - Give Symphony its own option schema with `description: Schema.String` (empty stays empty; nothing invented). Or mark such questions `unsupported` in `parseQuestionPayload`.
  - Separately, decode rows one at a time so one bad row shows as an explicit unreadable entry instead of emptying the list.
  - Add a regression test with an empty-description option.

## P2 — An old attempt can be given a snapshot after the fact (dormant today)

- **Trigger:** `RunAttemptRepository.update` on an attempt that has no snapshot yet. The `COALESCE` at `RunAttemptRepository.ts:139-142` accepts a first snapshot at any time, and the repository tests say this is intended.
- **Impact:** once the Dispatcher is wired, an attempt that started under older guidance could be stamped with a snapshot built from the _current_ workflow and tracker text. That records provenance that was never actually accepted, which contradicts the migration 046 comment ("consumers must not invent one").
- **Bounded fix:** only `create` may write the snapshot. `update` should keep the existing column as it is (drop the `COALESCE` fallback), and the "legacy accepts its first snapshot" test should flip.
- This doesn't block today, because nothing in production writes a snapshot.

## Guidance lane status (not defects)

- `freezeAcceptedGuidance`, `narrowAcceptedPermissions` and `preserveAcceptedGuidance` have no production caller.
- The only production `buildRunPrompt` call (`AgentRuntime.ts:297`) never passes `acceptedGuidance`.
- This matches the 16.17 ordering ("pure snapshot first; Dispatcher waits for recovery"), but **F6 acceptance is not met**, and the commit "persist accepted guidance on run attempts" must not be reported as live freezing.
- Things I checked that are fine:
  - The snapshot leaves out front matter, `trackerProvider` and hooks.
  - Unset delivery gates stay `null` instead of being coerced to false; absent versus empty guidance stays distinct.
  - No machine identity is invented.
  - Narrowing never widens permissions.
  - `updateStatus` doesn't touch the snapshot column.

## P3 (no block)

- **Stored snapshot isn't validated on read:** `rowToAttempt` casts the JSON without checking it against the schema. The source `revision` is `issue.updatedAt` pushed into `IsoDateTime`, so a tracker date in another format could break decoding of run details once this is wired.
- **Retry checks:**
  - A retried answer to a secret question counts as identical even if the secret differs, because both sides are compared after redaction.
  - If saving the note to history failed, retrying the same approve-with-note is reported as stale.
- **One-row-per-request isn't real in production:** `ON CONFLICT(id)` only protects a reused record id. `recordPending` makes a random UUID every time, so the "redelivered request stays one row" test doesn't reflect production.
- **Question ids are trimmed:** the stored id can differ from the id Codex sent if it has surrounding whitespace.
- **Unenforced delivery line in every prompt:** the new "Delivery approvals: …" line appears in all prompts, but I found no server code that enforces those gates.
- **Answer history isn't shown:** `approvalRequestHistory` has no production consumer, so answers and notes are saved but not displayed.

**Recheck:** re-review the final SHA after the two P1 fixes, and before any claim that F6 or S1–S5 is met. The plan's required real Codex continuation and Chrome walkthrough are still outstanding.
