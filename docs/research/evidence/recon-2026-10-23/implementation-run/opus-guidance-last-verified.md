**ACCEPT.** I found no blocking defect in the three corrections or in the production code that calls them. This was a read-only review of the working tree, which git status reported clean at `69a712335`. I could not run git or the tests, so I did not diff the commits.

### 1. Unreadable attempt: no fallback to legacy behaviour

- `ExecutionFinalizer.ts:219-255`: the attempt is read with `Effect.result(getById)`. A failed read or a missing row both refuse before validation, push or PR. The refusal emits a `delivery_refused` event with `attemptRead: failed|missing`, sets the attempt to `workflow_error` and the item to `failed`, and opens a high-severity attention item.
- A corrupt `acceptedGuidanceJson` counts as a failed read: `RunAttemptRepository.ts:39-70` returns a decode error, which hits the refusal path. It does not decode to `undefined` and pass as a legacy row.
- A genuine legacy row (`acceptedGuidanceJson === null`) still works: `:270-283` assembles evidence against it, and `:403-404` uses `input.config` only when the row has no accepted snapshot and no refresher was passed.
- Tests: missing row `ExecutionFinalizer.test.ts:553`, unreadable `:586`, legacy allowed via the model-review case `:519`.

### 2. Fresh policy check after validation and model review, right before PR/push

- Order in `ExecutionFinalizer.ts`: validation `:259` → failed checks return early `:328` → model review `:363` → refresh `:396-422` → approval intersection `resolveDeliveryGate(publicationConfig, attempt.acceptedGuidance)` `:428` → `pullRequestService.create({config: publicationConfig})` `:440`. Nothing publishes in between.
- An accepted attempt with no refresher refuses (`:397-401`). A refresher that fails or returns null refuses (`:405-410`). A `refused` result returns `delivery_refused` (`:411-421`).
- Production wiring:
  - `Dispatcher.ts:1017-1024` passes `refreshPublicationPolicy` into both finalize call sites (`:1134` resume, `:1220` normal).
  - The refresher calls `publicationPolicyFor`, which:
    - freshly loads the workflow (`loadCurrentWorkflowPolicy`) and refuses if it is unavailable;
    - intersects the approval policy and refuses if the two can't be combined;
    - checks the target with `assertAcceptedTarget`: repo, workflow path, workspace, base branch, provider and model (`AgentRuntime.ts:310-352`);
    - refuses `prepare`/`observe` autonomy (`Dispatcher.ts:1005-1013`).
  - Every refusal goes through `refusePolicy` → `markFailed`, so the "refused" result always has a durable owner. `markFailed` still respects the Stop marker, the ownership hold and the claim binding.
- The loader is wired in production at `SymphonyOrchestratorLive.ts:1974-1982`: an invalid, draft or missing workflow becomes `null`, which refuses.
- The PR service only reads `config.repositoryPath` from the refreshed config (`PullRequest.ts:200-358`), and that path is pinned by the target check. Passing the raw live config to it therefore can't widen anything.
- Test for policy tightening while validation is suspended: `ExecutionFinalizer.test.ts:433-485` (zero PR calls, item `failed`). Dispatcher-level refusal tests are at `Dispatcher.test.ts:361-416` and `:1628-1640` (`target_changed`).

### 3. Qualified tracker source

- `trackerSourceMismatch` (`SymphonyOrchestratorLive.ts:288-318`):
  - a manual source is never compared against a tracker (`:294`);
  - an empty stored URL refuses (`:308`);
  - a null or empty refreshed URL refuses (`:311`);
  - any other URL difference refuses (`:314`).
- The check runs in `prepareDispatch` (`:1882-1889`), before `dispatcher.dispatchWorkItem` (`:1968`), the only production caller. So no attempt or snapshot is created for an unqualified source.
- Projection stores a null URL as `""` (`Projection.ts:43`), so those items correctly refuse.
- Test: `SymphonyOrchestratorLive.test.ts:226-287`.

### Preserved behaviour

Within this scope, the immutable snapshot (frozen once at `Dispatcher.ts:785` and persisted at `:799-812`), the target and executor pins, and the Stop/no-spawn and claim-binding checks on the resume path (`:1086-1116`) are unchanged.

### Non-blocking notes

1. **Missing tests:** two finalizer branches are untested directly: an accepted attempt with no refresher (`ExecutionFinalizer.ts:397`), and a refresher that returns `null` or `refused` (`:406`, `:411`).
2. **Unguarded tracker path:** `SymphonyOrchestratorLive.ts:297-301` skips the URL check for a non-manual source with an empty `trackerIssueId`. Production can't reach it today because Projection always sets `trackerIssueId: issue.id`.
3. **Whitespace URLs:** `:308` checks `.length`, not a trimmed value, unlike `ProjectBoard.ts:81`. A whitespace-only stored URL that matches the refreshed URL exactly would pass.

This accepts the source changes only. It does not cover the unmet real-Codex question-continuation shipping gate or the live Stop/coreexit proof.
