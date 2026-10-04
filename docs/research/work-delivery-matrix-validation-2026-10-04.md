# Narrow source review of the new work-delivery matrix

Reviewed `docs/research/work-delivery-intake-review-2026-10-04.md` against the current adapter/CLI/API client, WorkItemRepository and handoff source on 4 October 2026. No provider/tracker/runtime calls or repository edits. This reviews the new matrix only.

## Required wording correction

The GitHub Issues row says “one `gh issue list` with a configured/default limit”. The wrapper allows an optional limit, but the actual scheduler adapter never passes one: `GitHubIssuesAdapter.ts:186–194` passes only cwd/repo/env, and `GitHubIssuesCli.ts:26,136–149` therefore uses `DEFAULT_LIMIT = 100`. Replace with “one `gh issue list --limit 100` on the current scheduler path; the wrapper exposes an optional limit but this adapter does not configure it.” This is a bounded first list without a result-completeness signal, so full candidate coverage beyond 100 is not established.

## Confirmed material claims

- All seven factories are wired in `Trackers/Registry.ts`; this is source availability, not live capability proof.
- Current `delegateFromThread` validates source shell/workflow, creates a random manual work item, and uses a generated `delegated-…` tracker ID. It neither resolves a tracker reference nor stores source chat/message linkage in the resulting work item.
- Current repository upsert conflicts on `(project_id, tracker_kind, tracker_issue_id)` (`WorkItemRepository.ts:259`), backed by migration 041's unique key (`041_SymphonyProjects.ts:109`). Migration 035's older key differs; the matrix correctly describes the current one. Ownership/generation fences are present; race/runtime safety was not exercised.
- Jira polling adds project JQL; bulk/direct lookup accepts keys or IDs and returns raw canonical ID. Normalisation stamps configured project without comparing returned native project. Todo/new-category blocker gating fails closed for absent linked blocker state and is not universal across all states.
- Linear polling and native-ID reads filter project slug; canonical identity is UUID. Inverse relations request a first-50 connection without its pageInfo/completeness evidence. Its own issue-list pagination does not prove relation completeness.
- GitLab normalises project IID and paginates its project endpoint; priority/branch/blockers are absent projections. Empty blockers do not certify no dependencies.
- Asana scope is project membership, state is that membership's non-empty section; completed tasks and section records are nondispatchable. Missing usable section yields omission/error, not guessed eligibility.
- Azure WIQL filters TeamProject; direct/batch item fields omit TeamProject, so returned project is not checked. The client chunks batches at 200 and configuration validates only Active/Closed/Removed. No live cross-project request was attempted.
- GitHub Projects normalises only Issue content using item node ID. Draft/PR cards are omitted. Direct `node(id:)` lookup lacks owning-project evidence; Status is preferred with fallback single-select. Probe is viewer access rather than full project/item support.
- GitHub default dispatchability is open and unassigned. An explicit empty assignees array permits any open issue; a non-empty array requires a matching login. The source comment mentions a bot identity, but the default implementation checks only `logins.size === 0`; the matrix correctly describes actual behaviour rather than that comment.

The proposed scoped resolver, canonical-ID convergence, connection binding, provenance/receipt/result linkage, separate source-control capability, and finite fixture/live-proof gates follow from these seams. No further factual corrections were identified in this narrow source review. Source present, fixture success and live support must remain distinct.
