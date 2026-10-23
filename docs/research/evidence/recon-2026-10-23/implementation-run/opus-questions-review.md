**Verdict: not accepted yet. There is one P2 blocker, about secret questions. Everything else in the diff is correct.**

This is a source-only review. I read README, AGENTS, `state-and-evidence.md`, plan 16.15–16.17 and the S6 lane row, then the diff and the code that produces and consumes it. I didn't run any tests, builds or the app, and I didn't read any other reviewer's findings.

## P2: secret questions are now collected as plain text and saved permanently

- **Where:** `apps/server/src/provider/Layers/CodexAdapter.ts:338-375`, with the decision recorded in the comment at `:341-346`.
- **Trigger:** Codex sends a question with `isSecret: true` (`packages/effect-codex-app-server/src/_generated/schema.gen.ts:13222`, `:13243`). Such questions usually have no options.
  - **Before the diff:** the question was dropped by the `options.length === 0` filter.
  - **After the diff:** it reaches the user as an ordinary free-text question: "Type your answer below." in the plain composer.
- **What happens to the answer:**
  - It is stored permanently in the event store as `thread.user-input-response-requested.payload.answers` (`apps/server/src/orchestration/decider.ts:536-540`).
  - It is stored again in the `user-input.resolved` activity payload (`apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:652-662`). That payload goes out to every connected client in thread snapshots.
  - Nothing tells the user the answer is sensitive. Codex's own clients mask these fields.
- **Why it blocks:** the code comment honestly says masking isn't supported. But this diff is what creates the plaintext path, and the provider's `isSecret` flag is thrown away rather than kept, which goes against the state-and-evidence rule not to discard what's known. Stored events can't practically be cleaned up afterwards.
- **Minimal fix within the S6 file list:**
  1. In `toUserInputQuestions`, treat any request with an `isSecret === true` question as unsupported. Emit a visible `runtime.warning` instead of a fillable `user-input.requested`. The warning should say that secret input isn't supported and that the user should interrupt the turn or answer directly in Codex.
  2. Don't drop just the secret question in a mixed request. That would quietly send Codex a partial set of answers.
  3. Add one adapter test for this case.
- **Proper fix (needs a contract change, which belongs to the shared contract owner):** add a `sensitive` flag to `UserInputQuestion`, use a masked input in the web app, and redact answers in both stored payloads. If the owner decides plaintext storage is acceptable, that should be written down as an explicit decision rather than left to a code comment.

## Checked and correct

- **Free-text questions:**
  - Server: questions with `options` missing, `null` or `[]` now come through with `options: []` (`CodexAdapter.ts:347-372`). The id, header and question text are still required, which the contract needs (`packages/contracts/src/providerRuntime.ts:556-569`). Using the label when the description is empty keeps those options valid against the contract.
  - Web: `session-logic.ts:496-499` accepts missing or `null` options and still rejects other non-array values. The label is required and the description falls back to it. The empty-options filter that dropped the question is gone.
  - Answering: `resolvePendingUserInputAnswer` (`pendingUserInput.ts:48-63`) accepts a typed answer whatever the options are. Progress, completion and the Enter/submit button (`ChatView.tsx:4109-4111`, `:4883-4893`) all work with zero options. The number-key shortcuts check bounds (`ComposerPendingUserInputPanel.tsx:139`), and the new hint at `:168-172` is display-only.
- **IDs across mixed requests:** draft answers are stored per request and then per question (`ChatView.tsx:4861-4869`). Answers are built for every question ID (`pendingUserInput.ts:105-120`) and passed through to Codex one entry per ID (`CodexSessionRuntime.ts:641-675`). One reply isn't copied under several IDs, and two concurrent requests can't collide.
- **Trust boundary:** the server doesn't check submitted answers against the question IDs. That was already the case before this diff, and it matches the README's statement that `/ws` has no permission layer. Nothing new here.
- **Other code reading `options`:** nothing else in the normal-thread path assumes at least one option. The ACP and Symphony consumers already handle an empty list.
- **Tests:** the new tests check the right shapes: a mixed request, all-free-text with both `null` and missing options, and a label-only option. Their correctness is from reading only; I didn't run them.

## Not blocking, already present before this diff

- If every question in a request fails normalisation (for example, an empty `header`), the adapter returns `[]` (`CodexAdapter.ts:680-683`). Codex then waits on a request nobody can see. A question with an empty header inside a mixed request is still dropped silently, and its ID goes missing from the reply. The diff makes this rarer. It could later be fixed by using the question's ID when the header is empty and emitting a warning when nothing survives.
- If one request repeats a question ID, those questions share one draft answer.

Once the secret-question fix is in, I'd expect to accept the scoped source result. The final commit still needs rechecking, as you noted.
