# Symphony tracker: Asana

Adapter profile for the Asana tracker (`tracker.kind: asana`). The adapter talks to the Asana API
1.0 over the server's shared HTTP client with a Bearer token. No credential is exposed to the
coding-agent child.

## Provider keys

All keys live under `tracker.provider` in `WORKFLOW.md` front matter.

| Key           | Required | Secret | Default                         | Description                                   |
| ------------- | -------- | ------ | ------------------------------- | --------------------------------------------- |
| `endpoint`    | no       | no     | `https://app.asana.com/api/1.0` | Asana API base URL                            |
| `api_key`     | yes      | yes    | —                               | Asana personal access token, or a `$VAR` name |
| `project_gid` | yes      | no     | —                               | Project GID scope, e.g. `1200000000000001`    |

Values may reference environment variables with `$NAME`; the config loader resolves them. The
`ASANA_PAT` environment variable acts as a fallback. The adapter always declares `ASANA_PAT` (and
the resolved `$VAR` name) via `secretEnvironmentNames()` so the coding-agent child never inherits
it.

## Defaults

Asana has no fixed state vocabulary; states are section names of the project membership. When
`active_states` / `terminal_states` are not configured, no state filtering is applied and every
candidate is returned.

## Dispatchability

A task is dispatchable only while `completed` is `false` and `resource_subtype` is not `section`
(section records are never dispatched). This mirrors the upstream Elixir adapter. Tasks whose
membership for the configured project has no section are dropped as malformed.

## Scope and pagination

Scope is a single Asana project. Polling uses `GET /projects/:project_gid/tasks` with the task
`opt_fields` (gid, name, notes, completed, resource_subtype, assignee.gid, tags.name,
memberships.project.gid, memberships.section.gid, memberships.section.name, permalink_url,
created_at, modified_at) at 100 per page, following `next_page.offset` until `next_page` is null.

## Normalization

`listCandidateIssues` maps `identifier` to `ASANA-<gid>`; `nativeRef` holds
`{ task_gid, project_gid, section_gid }`; `url` is `permalink_url`; `labels` are tag names
normalized to lowercase; `assigneeId` is `assignee.gid`; `priority` and `branchName` are always
null; the issue state is the section name of the project membership.

## ID mapping and refresh

The opaque dispatch id is the Asana task gid. `refreshIssues` fetches each id with
`GET /tasks/:gid`; a 404 (task deleted) or a task whose memberships do not include the configured
project is omitted rather than failing the batch. A malformed requested record fails the batch.

## Error mapping

`HttpClient` failures map to `tracker_request` / `tracker_response` / `tracker_rate_limited`;
HTTP 401/403 map to `tracker_response` (rejected credentials); 404 maps to `tracker_not_found`.
Missing credentials map to `missing_tracker_secret`.

## Probe

Runs a minimal project-scoped poll to confirm credentials and project scope. Used by the Overview
tracker-health panel and by activation validation.

## Combination: Asana issues driving GitHub pull requests

Tracker and source control are independent. A workflow can declare `tracker.kind: asana` while the
repository's source-control provider stays GitHub; PR creation is driven by the repository remote,
not the tracker. This is a first-class configuration.
