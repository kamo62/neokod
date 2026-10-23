**Verdict: REQUEST_CHANGES.** There is one scoped defect: the publication approval gate falls back to the current workflow's policy when the attempt row can't be read. Everything else in scope checks out at source level.

**Source hash:** `6fb57d562abac92a60db38a7ff9a2faf428042cc`. I resolved it through `.git` → `worktrees/t3code12/HEAD` → `refs/heads/feat/neokod-guidance`. The worktree reflog shows `11f10b287`, `098268f08`, `fad98198d`, `03939b278` and `6fb57d562` in order at HEAD. "Clean" comes from the session-start snapshot only: I had no shell, so I couldn't run `git status`.

## Blocking defect

**An unreadable attempt row lets publication skip the accepted push/PR approval gates.**

- **Where:**
  - `ExecutionFinalizer.ts:215-217` turns any `getById` failure into `null`.
  - `ExecutionFinalizer.ts:315` then passes `attempt?.acceptedGuidance`, which is `undefined`.
  - `ExecutionFinalizer.ts:88-90` treats `undefined` as "legacy" and uses the current workflow's policy alone.
- **What the Dispatcher discards:** at `Dispatcher.ts:1124` and `:1209` it passes only `publicationPolicy.config` to `finalize`. The narrowed permission it already computed (`:971-996`, which keeps the accepted gates) is never handed over.
- **Trigger:**
  - The accepted brief has `approvalsBeforePush` or `approvalsBeforePullRequest` set to true.
  - The workflow is then edited to drop that gate.
  - The attempt read fails at finalize time. This is either a transient database error or the unreadable-snapshot state the code already models (`Recovery.test.ts:423`).
  - `Dispatcher.ts:1191-1197` also treats a failed read as "not terminal" and carries on.
- **Impact:** `pullRequestService.create` pushes and opens a PR, even though the accepted brief required approval first. This is exactly the case `ExecutionFinalizer.test.ts:336-337` says must be bounded, but only in the read-failure window.
- **Bounded fix:**
  - Pass the in-memory `acceptedGuidance` (or the narrowed permission) from the Dispatcher into `finalize`.
  - Treat only "row read succeeded but has no snapshot" as legacy.
  - If the read fails or returns `null`, refuse publication.
- **Missing regression:** accepted gate true, current workflow gate false, attempt read failing. Expect `delivery_refused` and zero PR create calls.

## Verified at HEAD

- **Immutable, create-only brief:** `accepted_guidance_json` appears only in the INSERT (`RunAttemptRepository.ts:153`). The snapshot is frozen once (`Dispatcher.ts:785-811`), and that same object reaches every turn and the policy checks.
- **Fresh policy before continuation and publication:** `currentPolicyFor` (`Dispatcher.ts:956-997`) rereads the accepted workflow by id (`SymphonyOrchestratorLive.ts:1973-1981`). It refuses when the policy is unavailable, invalid or draft, when the policies conflict, or when the target changed. Continuations run with the narrowed policy inside `AgentRuntime.ts:484-523`. `publicationPolicyFor` refuses publication if narrowed autonomy is `prepare` or `observe`.
- **Qualified tracker scope before admission:** the tracker kind is checked before the refresh (`SymphonyOrchestratorLive.ts:1865-1875`). After it, kind, external id and canonical URL are checked (`:288-317`, `:1881-1888`). `source_json` is never updated by a poll (`WorkItemRepository.ts:345-368`), so the stored scope can't be silently replaced.
- **Executor refusal:** `codex/codex_default` is enforced in three places:
  - in prepare (`SymphonyOrchestratorLive.ts:1829`);
  - before the claim (`Dispatcher.ts:729`);
  - before spawn (`AgentRuntime.ts:473-483`).
- **Retargeting the accepted repo, provider or model:** `assertAcceptedTarget` is now exported and called before publication (`Dispatcher.ts:982-995`) as well as per turn (`AgentRuntime.ts:489`). PR creation uses the pinned `config.repositoryPath` and `baseBranch` (`PullRequest.ts:162-210`).
- **Recovered null-PID Stop:** `knownNoSpawnFor` (`Dispatcher.ts:357-365`) needs positive proof that this process admitted the attempt. After a restart that proof is absent, so Stop holds with `identity_missing_for_bound_attempt`, whether or not the failure event exists (`:1547-1549`). If the `stop_requested` write fails, Stop returns `held` before any interrupt (`:1463-1476`).
- **Focused regressions that cover the real failure windows:**
  - `Dispatcher.test.ts:347` (policy reload)
  - `Dispatcher.test.ts:395` (policy unavailable)
  - `Dispatcher.test.ts:423` (provider refused)
  - `Dispatcher.test.ts:1505` (stop intent unpersisted, no signals, agent still active)
  - `Dispatcher.test.ts:1551` (recovered null PID, with and without the failure event)
  - `Dispatcher.test.ts:1615` (retarget before publication)
  - `ExecutionFinalizer.test.ts:306` (gated publication)

## Not blocking (stated separately)

- **Empty stored URL skips the scope check.** If the stored `externalUrl` is empty, `SymphonyOrchestratorLive.ts:308` doesn't check scope. GitHub and GitLab ids are only unique within a repository or project, and both adapters allow a null URL (`GitHubIssuesCli.ts:50`, `GitLabAdapter.ts:164`). In practice those URLs are always filled in, so this is a residual risk only.
- **Manual delegated items are refused, not dispatched.** They carry `trackerIssueId: delegated-…` (`HandoffService.ts:555`). The refresh step looks that id up in the tracker, finds nothing, and the item is refused with `tracker_refresh_failed`. The refusal is honest and mixes no tracker content in; manual dispatch just isn't supported yet.
- **Publication uses current validation, not the accepted list.** `ExecutionFinalizer.ts:200` runs the current workflow's `validationRequired`, not the accepted brief's. Removing a check mid-run lets publication go ahead without it. This sits outside permission narrowing, so it's a decision for the owner.
- **Live proof is still absent.** The runtime live probe has its own unmet shipping gate: the provider completed turns but asked no question. Nothing in this review stands in for that.

This was a read-only review: no edits, tests, builds, providers or signals. Plan mode asked for a plan file and an exit step, but I had no tool for either, so this message is the whole result.
