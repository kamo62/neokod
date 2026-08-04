# Symphony tracker: Jira Cloud

Adapter profile for the Jira Cloud tracker (`tracker.kind: jira`). The adapter talks to the Jira
Cloud REST API over the server's shared HTTP client with Basic auth (email + API token). No
credential is exposed to the coding-agent child.

## Provider keys

All keys live under `tracker.provider` in `WORKFLOW.md` front matter.

| Key                | Required | Secret | Default | Description                                                   |
| ------------------ | -------- | ------ | ------- | ------------------------------------------------------------- |
| `base_url`         | yes      | no     | —       | Jira Cloud base URL, e.g. `https://your-domain.atlassian.net` |
| `email`            | yes      | no     | —       | Account email for Basic auth                                  |
| `api_token`        | yes      | yes    | —       | Jira API token, or a `$VAR` name                              |
| `project_key`      | yes      | no     | —       | Project key scope, e.g. `PROJ`                                |
| `priority_mapping` | no       | no     | —       | `status name -> numeric priority` map                         |

Values may reference environment variables with `$NAME`; the config loader resolves them. The
`JIRA_BASE_URL`, `JIRA_EMAIL`, and `JIRA_API_TOKEN` environment variables act as fallbacks. The
adapter always declares `JIRA_API_TOKEN` (and the resolved `$VAR` name) via
`secretEnvironmentNames()` so the coding-agent child never inherits it.

## Defaults

- `active_states`: `["To Do", "In Progress"]`
- `terminal_states`: `["Done", "Cancelled"]`

## Dispatchability

An issue is dispatchable unless it is in a gating status (status category `new`, or state
`todo`/`to do`) with an unresolved blocker. A blocker is resolved when its status is in
`terminal_states`. This mirrors the upstream Elixir adapter's `dispatchable?/4`.

## Scope and pagination

Scope is a single Jira project. Polling uses `POST /rest/api/3/search/jql` with a JQL
`project = X AND status IN (...)` query at 100 results per page, following `nextPageToken` until
`isLast` is true. ID refresh uses `POST /rest/api/3/issue/bulkfetch`.

## Normalization

`listCandidateIssues` requests `summary, description, status, labels, assignee, created, updated,
project, issuelinks`. Descriptions are ADF and flattened to text. `identifier` is the issue key
(e.g. `PROJ-42`); `nativeRef` holds `{ projectKey, key }`; `url` is `<base>/browse/<key>`;
`blockedBy` derives from `issuelinks` of type `Blocks`.

## ID mapping and refresh

The opaque dispatch id is the Jira numeric issue id. `refreshIssues` bulk-fetches each id and keeps
only records matching the requested id; an id no longer visible in scope is omitted rather than
failing the batch. A malformed requested record fails the batch.

## Error mapping

`HttpClient` failures map to `tracker_request` / `tracker_response` / `tracker_rate_limited`;
HTTP 401/403 map to `tracker_response` (rejected credentials); 404 maps to `tracker_not_found`.
Missing credentials map to `missing_tracker_secret`.

## Probe

Runs a minimal project-scoped search to confirm credentials and project scope. Used by the Overview
tracker-health panel and by activation validation.

## Combination: Jira issues driving GitHub pull requests

Tracker and source control are independent. A workflow can declare `tracker.kind: jira` while the
repository's source-control provider stays GitHub; PR creation is driven by the repository remote,
not the tracker. This is a first-class configuration.
