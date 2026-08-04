# Symphony tracker: GitHub Issues

Adapter profile for the GitHub Issues tracker (`tracker.kind: github`). The adapter uses the
`gh` CLI in the host process; no token is exposed to the coding-agent child.

## Provider keys

All keys live under `tracker.provider` in `WORKFLOW.md` front matter.

| Key              | Required | Secret | Default         | Description                                                                |
| ---------------- | -------- | ------ | --------------- | -------------------------------------------------------------------------- |
| `repo`           | yes      | no     | —               | `owner/name` repository selector                                           |
| `token_env`      | no       | yes    | —               | `$VAR` name of a GH token; when absent `gh` uses its own credential store  |
| `assignees`      | no       | no     | unassigned only | logins that make an issue dispatchable; an empty list means any open issue |
| `priority_label` | no       | no     | —               | label pattern mapped to dispatch priority, e.g. `P{n}`                     |

Values may reference environment variables with `$NAME`; the config loader resolves them.
A configured `token_env` is removed from the coding-agent child environment.

## Defaults

- `active_states`: `["open"]`
- `terminal_states`: `["closed"]`

## Dispatchability

An issue is dispatchable when it is open and:

- no `assignees` configured: it is unassigned; or
- `assignees` configured as an empty list: any open issue; or
- `assignees` configured: it is assigned to one of the configured logins.

## Scope and pagination

Scope is a single repository (`gh issue list --repo owner/name`). Pagination is at 100 issues per
request (`--limit 100 --page N`).

## Normalization

Maps `gh issue list --json number,title,body,state,labels,assignees,createdAt,updatedAt,url` into the
SPEC 11.3 `NormalizedIssue`. `priority` derives from the configured `priority_label` pattern;
`identifier` is `#<number>`; `nativeRef` holds `{ owner, repo, number }`.

## ID mapping and refresh

The opaque dispatch id is the issue number as a string. `refreshIssues` fetches each id with
`gh issue view`; an id no longer visible in scope (deleted, or moved off the repository) is omitted
rather than failing the batch. A malformed requested record fails the batch.

## Error mapping

`VcsError` maps to `tracker_request` / `tracker_status` / `tracker_response` /
`tracker_rate_limited`; missing tokens map to `missing_tracker_secret`.

## Probe

`gh auth status` in the repository directory. Used by the Overview tracker-health panel and by
activation validation.
