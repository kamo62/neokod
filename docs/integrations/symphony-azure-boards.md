# Symphony tracker: Azure Boards

Adapter profile for the Azure Boards tracker (`tracker.kind: azure_boards`). The adapter talks to
the Azure DevOps REST API over the server's shared HTTP client with a PAT via Basic auth. No
credential is exposed to the coding-agent child.

## Provider keys

All keys live under `tracker.provider` in `WORKFLOW.md` front matter.

| Key            | Required | Secret | Default | Description                        |
| -------------- | -------- | ------ | ------- | ---------------------------------- |
| `organization` | yes      | no     | —       | Azure DevOps organization name     |
| `project`      | yes      | no     | —       | Azure DevOps project name          |
| `api_key`      | yes      | yes    | —       | Azure DevOps PAT, or a `$VAR` name |

Values may reference environment variables with `$NAME`; the config loader resolves them. The
`AZURE_DEVOPS_PAT` environment variable acts as a fallback for `api_key`. The adapter always
declares `AZURE_DEVOPS_PAT` (and the resolved `$VAR` name) via `secretEnvironmentNames()` so the
coding-agent child never inherits it.

## Defaults

- `active_states`: `["Active"]`
- `terminal_states`: `["Closed", "Removed"]`

Azure Boards process templates define their own state vocabulary; the defaults match the built-in
Agile process. Configured states must normalize to the allowed values above.

## Dispatchability

Azure Boards work items have no blocker relations in scope; every work item in an active state is
dispatchable. Draft items and items of any type (Bug, User Story, Task, ...) are treated uniformly.

## Scope and pagination

Scope is a single Azure DevOps project. Polling runs a flat WIQL query
(`SELECT [System.Id] FROM WorkItems WHERE ... AND ([System.State] = 'Active' OR ...)`) against
`_apis/wit/wiql`, then batch-fetches the referenced work item ids from
`_apis/wit/workitems?ids=...&$expand=Fields`. State values are single-quote-escaped in the query.

## Normalization

`listCandidateIssues` maps `identifier` to `AB-<id>`; `nativeRef` holds
`{ id, rev, organization, project, type }`; `url` is the work item URL; `labels` come from
`System.Tags` split on `;` and normalized to lowercase; `assigneeId` is the
`System.AssignedTo` email (or display name) stripped of the `Name <email>` wrapper; `priority` and
`branchName` are always null; the issue state is `System.State`.

## ID mapping and refresh

The opaque dispatch id is the Azure Boards work item id as a string. `refreshIssues` fetches each
id with `GET _apis/wit/workitems/:id`; a 404 (work item deleted or out of scope) is omitted rather
than failing the batch. A malformed requested record fails the batch.

## Error mapping

`HttpClient` failures map to `tracker_request` / `tracker_response` / `tracker_rate_limited`;
HTTP 401/403 map to `tracker_response` (rejected credentials); 404 maps to `tracker_not_found`.
Missing credentials map to `missing_tracker_secret`.

## Probe

Runs a minimal credentials check against the project's work item endpoint. Used by the Overview
tracker-health panel and by activation validation.

## Combination: Azure Boards issues driving GitHub pull requests

Tracker and source control are independent. A workflow can declare `tracker.kind: azure_boards`
while the repository's source-control provider stays GitHub; PR creation is driven by the
repository remote, not the tracker. This is a first-class configuration.
