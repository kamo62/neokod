# Symphony tracker: GitLab

Adapter profile for the GitLab tracker (`tracker.kind: gitlab`). The adapter talks to the GitLab
API v4 over the server's shared HTTP client with the `PRIVATE-TOKEN` header. No credential is
exposed to the coding-agent child.

## Provider keys

All keys live under `tracker.provider` in `WORKFLOW.md` front matter.

| Key            | Required | Secret | Default                     | Description                                      |
| -------------- | -------- | ------ | --------------------------- | ------------------------------------------------ |
| `api_url`      | no       | no     | `https://gitlab.com/api/v4` | GitLab API v4 base URL                           |
| `project_path` | yes      | no     | —                           | Project namespace/path, e.g. `my-org/my-project` |
| `api_key`      | yes      | yes    | —                           | GitLab personal access token, or a `$VAR` name   |

Values may reference environment variables with `$NAME`; the config loader resolves them. The
`GITLAB_PROJECT_PATH` and `GITLAB_PAT` environment variables act as fallbacks for `project_path`
and `api_key`. The adapter always declares `GITLAB_PAT` and `GITLAB_ACCESS_TOKEN` (and the resolved
`$VAR` name) via `secretEnvironmentNames()` so the coding-agent child never inherits them.

## Defaults

- `active_states`: `["opened"]`
- `terminal_states`: `["closed"]`

GitLab only distinguishes `opened` and `closed`, so configured states must normalize to those two
values.

## Dispatchability

GitLab issues have no blocker relations in scope; every issue in an active state is dispatchable.
This mirrors the upstream Elixir adapter, which always sets `dispatchable: true`.

## Scope and pagination

Scope is a single GitLab project. Polling uses `GET /projects/:project_path/issues` with the state
query (`opened`, `closed`, or `all` when both are active) at 100 per page ordered by `created_at`
ascending, continuing until a page shorter than 100 is returned.

## Normalization

`listCandidateIssues` maps `identifier` to `GL-<iid>`; `nativeRef` holds
`{ id, iid, project_id, project_path }`; `url` is `web_url`; `labels` are the label strings
normalized to lowercase; `assigneeId` is the first assignee's numeric id (falling back to
username); `priority` and `branchName` are always null.

## ID mapping and refresh

The opaque dispatch id is the GitLab issue iid as a string. `refreshIssues` fetches each id with
`GET /projects/:project_path/issues/:iid`; a 404 (issue deleted or out of scope) is omitted rather
than failing the batch. A malformed requested record fails the batch.

## Error mapping

`HttpClient` failures map to `tracker_request` / `tracker_response` / `tracker_rate_limited`;
HTTP 401/403 map to `tracker_response` (rejected credentials); 404 maps to `tracker_not_found`.
Missing credentials map to `missing_tracker_secret`.

## Probe

Runs a minimal project-scoped poll to confirm credentials and project scope. Used by the Overview
tracker-health panel and by activation validation.

## Combination: GitLab issues driving GitHub pull requests

Tracker and source control are independent. A workflow can declare `tracker.kind: gitlab` while the
repository's source-control provider stays GitHub; PR creation is driven by the repository remote,
not the tracker. This is a first-class configuration.
