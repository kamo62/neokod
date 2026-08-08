# Symphony tracker: GitHub Projects

Adapter profile for the GitHub Projects tracker (`tracker.kind: github_projects`). The adapter
talks to the GitHub Projects v2 GraphQL API over the server's shared HTTP client with a PAT via
Bearer auth. No credential is exposed to the coding-agent child.

## Provider keys

All keys live under `tracker.provider` in `WORKFLOW.md` front matter.

| Key       | Required | Secret | Default | Description                                             |
| --------- | -------- | ------ | ------- | ------------------------------------------------------- |
| `owner`   | yes      | no     | —       | GitHub owner (organization or user) hosting the project |
| `number`  | yes      | no     | —       | GitHub Projects v2 project number                       |
| `api_key` | yes      | yes    | —       | GitHub PAT with project read scope, or a `$VAR` name    |

Values may reference environment variables with `$NAME`; the config loader resolves them. The
`GITHUB_PAT` environment variable acts as a fallback for `api_key`. The adapter always declares
`GITHUB_PAT` and `GITHUB_TOKEN` (and the resolved `$VAR` name) via `secretEnvironmentNames()` so
the coding-agent child never inherits them.

## Defaults

- `active_states`: `["Open"]`
- `terminal_states`: `["Closed", "Done"]`

The item state is the value of the project's single-select status field. Configured states must
normalize to the allowed values above.

## Dispatchability

Only items whose content is a GitHub issue are candidates; draft items and pull requests are
omitted. Every issue item in an active status is dispatchable.

## Scope and pagination

Scope is a single GitHub Projects v2 project (`owner` + `number`). Polling reads project items via
GraphQL with cursor pagination at 100 per page, requesting the issue content (title, body, url,
state, labels, assignees, timestamps) and the single-select status field values.

## Normalization

`listCandidateIssues` maps `identifier` to `GH-<issue number>`; `nativeRef` holds
`{ item_id, owner, project_number, issue_id, issue_number }`; `url` is the issue URL; `labels` are
the issue label names normalized to lowercase; `assigneeId` is the first assignee's login;
`priority` and `branchName` are always null; the issue state is the status field value (falling
back to the issue's own state).

## ID mapping and refresh

The opaque dispatch id is the project **item id** (not the issue number). `refreshIssues` fetches
each item by id via GraphQL; a missing item is omitted rather than failing the batch. A requested
item whose content is not an issue is omitted.

## Error mapping

GraphQL errors map to `tracker_response`; HTTP 401/403 map to `tracker_response` (rejected
credentials); HTTP 429 maps to `tracker_rate_limited`; a project that does not exist maps to
`tracker_not_found`. Missing credentials map to `missing_tracker_secret`.

## Probe

Runs a minimal viewer query to confirm the token works. Used by the Overview tracker-health panel
and by activation validation.

## Combination: GitHub Projects issues driving GitHub pull requests

Tracker and source control are independent. A workflow can declare `tracker.kind: github_projects`
while the repository's source-control provider stays GitHub; PR creation is driven by the
repository remote, not the tracker. This is a first-class configuration.
