# Symphony tracker: Linear

Adapter profile for the Linear tracker (`tracker.kind: linear`). The adapter talks to the Linear
GraphQL API over the server's shared HTTP client with the API key as the `Authorization` header (no
Bearer prefix). No credential is exposed to the coding-agent child.

## Provider keys

All keys live under `tracker.provider` in `WORKFLOW.md` front matter.

| Key            | Required | Secret | Default | Description                                                    |
| -------------- | -------- | ------ | ------- | -------------------------------------------------------------- |
| `endpoint`     | yes      | no     | —       | Linear GraphQL endpoint, e.g. `https://api.linear.app/graphql` |
| `api_key`      | yes      | yes    | —       | Linear API key, or a `$VAR` name                               |
| `project_slug` | yes      | no     | —       | Project slug scope, e.g. `my-project`                          |
| `assignee`     | no       | no     | —       | Only dispatch issues assigned to this user id, or `"me"`       |

Values may reference environment variables with `$NAME`; the config loader resolves them. The
`LINEAR_API_KEY` environment variable acts as a fallback. The adapter always declares
`LINEAR_API_KEY` (and the resolved `$VAR` name) via `secretEnvironmentNames()` so the coding-agent
child never inherits it.

## Defaults

- `active_states`: `["Todo", "In Progress"]`
- `terminal_states`: `["Done", "Cancelled"]`

## Dispatchability

An issue must be assigned to the worker to be dispatchable. With no `assignee` configured every
issue is assigned; with `"me"` the API key owner's viewer id is resolved once and cached. A `Todo`
issue is additionally gated by blockers: it is not dispatchable while any issue that blocks it is
not in `terminal_states` (or has an unknown state). This mirrors the upstream Elixir adapter's
`blocked_before_dispatch?/3`.

## Scope and pagination

Scope is a single Linear project. Polling uses the `issues` query filtered by `project.slugId` and
state names at 50 per page, following `pageInfo.endCursor` until `hasNextPage` is false. Blocker
relations are fetched with the page via `inverseRelations` (first 50 per issue).

## Normalization

`listCandidateIssues` maps `identifier` to the issue key (e.g. `NEO-42`); `nativeRef` holds
`{ projectSlug, identifier }`; `url` is the permalink; `labels` are tag names normalized to
lowercase; `blockedBy` derives from `inverseRelations` of type `blocks`; `priority` is the numeric
Linear priority.

## ID mapping and refresh

The opaque dispatch id is the Linear issue uuid. `refreshIssues` fetches ids in batches of 50
through a single `issues` query with an `id in` filter, sorted back to the requested order; an id no
longer visible in scope is omitted rather than failing the batch. A malformed requested record fails
the batch.

## Error mapping

`HttpClient` failures map to `tracker_request` / `tracker_response` / `tracker_rate_limited`;
HTTP 401/403 map to `tracker_response` (rejected credentials); 404 maps to `tracker_not_found`.
Missing credentials map to `missing_tracker_secret`.

## Probe

Runs a minimal project-scoped poll to confirm credentials and project scope. Used by the Overview
tracker-health panel and by activation validation.

## Combination: Linear issues driving GitHub pull requests

Tracker and source control are independent. A workflow can declare `tracker.kind: linear` while the
repository's source-control provider stays GitHub; PR creation is driven by the repository remote,
not the tracker. This is a first-class configuration.
