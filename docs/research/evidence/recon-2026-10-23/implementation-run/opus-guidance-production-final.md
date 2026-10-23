**Verdict: ACCEPT.** I found no P0 or P1 issues. There are three P2 follow-ups, none of which block.

**SHA status:** `.git` → `worktrees/t3code12/HEAD` → `refs/heads/feat/neokod-guidance` = `11f10b287467946bca4f0aeec1966782d4852587`. The session-start git snapshot shows the tree clean. I couldn't re-run `git status` because I only had Read/Glob/Grep. The local `origin/feat/neokod-guidance` ref points at `fcba3924`, so `11f10b287` doesn't appear to be pushed as of the last fetch.

## Checks against your list

- **Frozen and persisted at admission:** confirmed. `freezeAcceptedGuidance` runs after the claim and workspace are set up, and the snapshot is written in the same `runAttempts.create` call, before the claim binding and before any spawn (`Dispatcher.ts:631-658`).
  - **Workflow:** id and `updatedAt` revision come from the same workflow row read as the config and body (`SymphonyOrchestratorLive.ts:1750-1753, 1822, 1835-1837`).
  - **Body:** only the trimmed `promptTemplate`; front matter is never an input.
  - **Issue/source:** includes manual items (`AcceptedSourceKindSchema` plus manual; `sourceIdentity` only copies `externalId`/`externalUrl` when the source has them).
  - **Target:** repository id and path, workflow path, workspace, base branch, provider, and model.
  - **Permission and delivery:** derived through the single `resolveRunnerPolicy`.
- **Absent vs empty instructions:** batch and story text are stored as `{state:"absent"}` or `{state:"present",text}`. No production path supplies batch or story text, so every snapshot honestly records "absent". An empty workflow body is stored as `""`; the orchestrator already treats a blank body as "none", so nothing is lost.
- **Create-only, immutable:** `update` and `updateStatus` never write `accepted_guidance_json` (`Layers/RunAttemptRepository.ts:170-180, 355-361`). No other SQL touches that table. The snapshot is validated on both write and read. Extra keys are stripped by the schema decode before storage.
- **Same snapshot for every turn:** one `acceptedGuidance` constant feeds the prepare turn, the first execute turn and all continuation turns (`Dispatcher.ts:777, 866, 884`).
- **Never widen:** the retarget check and the permission narrowing both happen before `initialize`/spawn (`AgentRuntime.ts:446-485`). `narrowAcceptedPermissions` only picks the more restrictive value on every axis, caps the turn sandbox to the thread sandbox, and refuses approval-policy combinations that can't be expressed. In production the "live" config is the same in-memory admission config, so the result is the snapshot itself (apart from the sandbox cap).
- **Pins:** provider (instance and driver), model, repository path, workflow path, workspace and base branch are all checked on every turn. A mismatch fails before any provider use.
- **Nothing invented:** no machine identity or provider-neutral capability claims; the runner stays Codex.

## P2 findings

1. **Digests aren't checked on read or write.**
   - **Path:** `Services/RunAttemptRepository.ts:80-110`.
   - **Trigger:** a stored row whose content was edited but whose digests weren't.
   - **Impact:** the row still validates, and the prompt shows a digest (`Prompt.ts:302`) that the content doesn't match. The digest is advisory, not integrity evidence.
   - **Fix:** move `digestAcceptedContent` into a shared helper and recompute the workflow, source, guidance and top-level digests inside `validateAcceptedGuidanceSnapshot`.

2. **One unreadable snapshot fails the whole attempt read.**
   - **Path:** `Layers/RunAttemptRepository.ts:62-70`, used by `getById`, `latestForWorkItem`, `listByWorkItem` and `listRecent`.
   - **Trigger:** a corrupt row, or a downgrade after a future `schemaVersion`.
   - **Impact:**
     - `listRecent` fails for every attempt, not just the bad one.
     - Callers that turn the error into `null` misbehave: Stop returns `held("attempt_not_found")`, `markFailed` treats the attempt as missing, and `prepareDispatch` skips its ended-attempt block. The resulting duplicate attempt number makes the next create fail, so nothing unsafe runs, but only by accident.
   - **Fix:** if only the guidance column is bad, return the attempt with an explicit "unreadable" marker (contract owner adds the field). Execution should still refuse; list views, Stop and recovery should keep working.

3. **Early-failure attempts have no snapshot but read as "legacy".**
   - **Path:** `failEarly` (`Dispatcher.ts:507-521`). The contract (`symphony.ts:410`) and migration 046 both say a missing snapshot means the attempt is legacy.
   - **Impact:** a post-feature attempt that failed while preparing its workspace is shown as a pre-feature legacy row.
   - **Fix:** either change those two comments to "legacy or refused before admission", or pass workflow id, revision and body into `failEarly` and freeze a snapshot without workspace or base branch.

## Notes and source-only limitations

- **Delivery gates aren't enforced anywhere.** `ExecutionFinalizer` doesn't read approval or autonomy settings. This predates the change, so the snapshot's delivery scope is descriptive only. Today "never widen" holds only because no code reads the live gates either.
- **Retries freeze the current policy.** Every retry or review-continuation dispatch freezes a new snapshot from the current workflow, including `resumeCommittedHandoff`. That fits "edits affect future attempts". Whether a widened retry needs re-acceptance is a question for the composition review.
- **Review feedback isn't covered by the snapshot.** It is rendered next to the accepted brief but isn't part of the snapshot or its digest. It isn't on your list; I'm noting it for audit purposes.
- **Turn tests check presence, not identity.** `Dispatcher.test.ts:549-562` only checks that a snapshot is present on each turn. A test asserting the same digest across turns would make that guarantee checkable.
- **Jira timestamps are untested here.** The source `revision` is the raw Jira `+0000` timestamp, which passes validation only if Node's `Date` accepts that format. I believe it does but couldn't run it; a focused test would settle it.
- **Scope of what I read:** source only, no tests, typecheck or runtime. Without git commands I reviewed `7cd3c0ef4` and `fcba39242` as the code they left at HEAD, not as diffs, and I didn't verify their ancestry. I didn't start a recovery audit. Plan mode asked for a plan file and an exit-plan step, but I had no tool for either, so the review is only in this message.
