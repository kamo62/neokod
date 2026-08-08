import type { NormalizedIssue } from "@neokod/contracts";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";

import type { AdapterProfile, TrackerAdapter } from "./Adapter.ts";
import {
  invalidTrackerConfig,
  isTrackerAdapterError,
  missingTrackerSecret,
  trackerNotFoundError,
} from "./Errors.ts";
import type { TrackerAdapterError } from "./Errors.ts";
import {
  makeGitLabApiClient,
  type GitLabApiClientShape,
  type GitLabRawIssue,
} from "./GitLabApiClient.ts";
import { decodeNormalizedIssue, isStateIn, normalizeLabel, normalizeState } from "./Normalize.ts";
import { resolveProviderSecret } from "./ProviderSecret.ts";

/**
 * GitLab Issues tracker adapter (SPEC 11.2, plan 5.0.1).
 *
 * Talks to the GitLab API v4 with the `PRIVATE-TOKEN` header over the shared
 * `HttpClient`, scoped to a project path. Polling (state query mapping +
 * pagination), per-IID ID refresh with 404 omission, and normalization mirror
 * `.repos/symphony/elixir/.../gitlab/client.ex` (the authoritative reference).
 *
 * Credentials resolve from `tracker.provider` (`api_url`, `project_path`,
 * `api_key`) or the `GITLAB_PROJECT_PATH` / `GITLAB_PAT` env fallbacks.
 * `api_key` may be a `$VAR` name; env names are declared via
 * `secretEnvironmentNames()` so the coding-agent child never inherits them.
 */

const ALLOWED_ACTIVE_STATES = ["opened"];
const ALLOWED_TERMINAL_STATES = ["closed"];

const DEFAULT_API_URL = "https://gitlab.com/api/v4";

const resolveProviderString = (
  provider: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined =>
  typeof provider[key] === "string" && provider[key].length > 0
    ? (provider[key] as string)
    : undefined;

const resolveEnv = (
  name: string,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined => {
  const value = env[name];
  return value === undefined || value.length === 0 ? undefined : value;
};

const validApiUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.length > 0;
  } catch {
    return false;
  }
};

const validProjectPath = (value: string): boolean => !/[ \t\n\r\0]/.test(value) && value.length > 0;

const validateStates = (states: ReadonlyArray<string>, allowed: ReadonlyArray<string>): boolean =>
  states.every((state) => allowed.includes(normalizeState(state)));

const parseIid = (value: string): number | null => {
  const raw = Number(value);
  return Number.isInteger(raw) && raw > 0 ? raw : null;
};

const blankToNull = (value: string | null): string | null => {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
};

const parseDatetime = (value: string | null): string | null => {
  if (value === null) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : value;
};

const extractAssigneeId = (raw: GitLabRawIssue): string | null => {
  const assignee = (raw.assignees ?? [])[0];
  if (assignee === undefined) {
    return null;
  }
  if (typeof assignee.id === "number") {
    return String(assignee.id);
  }
  return typeof assignee.username === "string" ? assignee.username : null;
};

export const makeGitLabAdapter = (options: {
  readonly provider: Readonly<Record<string, unknown>>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<TrackerAdapter, TrackerAdapterError> =>
  Effect.gen(function* () {
    const provider = options.provider;

    const apiUrl =
      resolveProviderString(provider, "api_url") ?? resolveEnv("GITLAB_API_URL", options.env);
    const projectPath =
      resolveProviderString(provider, "project_path") ??
      resolveEnv("GITLAB_PROJECT_PATH", options.env);
    const apiKeyValue = resolveProviderString(provider, "api_key");
    const apiKey = resolveProviderSecret(apiKeyValue, "GITLAB_PAT", options.env);

    if (apiUrl !== undefined && !validApiUrl(apiUrl)) {
      return yield* Effect.fail(
        invalidTrackerConfig("tracker.provider.api_url must be an https GitLab API v4 URL"),
      );
    }
    if (projectPath === undefined || !validProjectPath(projectPath)) {
      return yield* Effect.fail(
        invalidTrackerConfig("tracker.provider.project_path must be a GitLab namespace/project"),
      );
    }
    if (apiKey.resolved === undefined) {
      return yield* Effect.fail(missingTrackerSecret(apiKey.envName ?? "GITLAB_PAT"));
    }

    const activeStates = normalizeStates(options.provider.active_states) ?? ALLOWED_ACTIVE_STATES;
    const terminalStates =
      normalizeStates(options.provider.terminal_states) ?? ALLOWED_TERMINAL_STATES;

    const client: GitLabApiClientShape = makeGitLabApiClient({
      credentials: {
        apiUrl: (apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, ""),
        projectPath,
        apiKey: apiKey.resolved,
      },
      httpClient: options.httpClient,
    });

    const mapRawToNormalized = (raw: GitLabRawIssue): NormalizedIssue | null => {
      const iid = raw.iid;
      if (!Number.isInteger(iid) || iid <= 0) {
        return null;
      }
      return decodeNormalizedIssue({
        id: String(iid),
        nativeRef: {
          id: raw.id,
          iid: raw.iid,
          project_id: raw.project_id,
          project_path: projectPath,
        },
        identifier: `GL-${iid}`,
        title: raw.title,
        description: blankToNull(raw.description),
        priority: null,
        state: raw.state,
        branchName: null,
        url: blankToNull(raw.web_url),
        assigneeId: extractAssigneeId(raw),
        labels: (raw.labels ?? []).map(normalizeLabel),
        blockedBy: [],
        // Audit item 8 lane H: dispatchable was hardcoded true; only opened
        // issues may dispatch (GitLab states are opened/closed).
        dispatchable: normalizeState(raw.state) === "opened",
        createdAt: parseDatetime(raw.created_at),
        updatedAt: parseDatetime(raw.updated_at),
      });
    };

    const listCandidateIssues = () =>
      Effect.gen(function* () {
        const issues: NormalizedIssue[] = [];
        let dropped = 0;
        let page = 1;
        for (;;) {
          const result = yield* client.pollIssues({
            projectPath,
            states: activeStates,
            page,
          });
          for (const raw of result.issues) {
            const issue = mapRawToNormalized(raw);
            if (issue === null) {
              dropped += 1;
            } else if (isStateIn(issue.state, activeStates)) {
              issues.push(issue);
            }
          }
          if (!result.hasMore) {
            break;
          }
          page += 1;
        }
        if (dropped > 0) {
          yield* Effect.logWarning(`GitLab poll dropped ${dropped} malformed record(s)`);
        }
        return issues;
      });

    const refreshIssues = (ids: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const rawResult = yield* Effect.result(client.fetchIssuesByIds(ids, projectPath));
        if (rawResult._tag === "Failure") {
          if (isTrackerAdapterError(rawResult.failure)) {
            if (rawResult.failure.code === "tracker_not_found") {
              return [];
            }
          }
          return yield* Effect.fail(rawResult.failure);
        }
        const issues: NormalizedIssue[] = [];
        for (const raw of rawResult.success) {
          const issue = mapRawToNormalized(raw);
          if (issue === null) {
            return yield* Effect.fail(
              invalidTrackerConfig(`ID-refresh returned a malformed record for ${raw.iid}`),
            );
          }
          issues.push(issue);
        }
        return issues;
      });

    const getIssue = (id: string) =>
      Effect.gen(function* () {
        const iid = parseIid(id);
        if (iid === null) {
          return yield* Effect.fail(
            invalidTrackerConfig(`GitLab issue id must be a positive integer, got ${id}`),
          );
        }
        const raws = yield* client.fetchIssuesByIds([String(iid)], projectPath);
        const raw = raws[0];
        if (raw === undefined) {
          return yield* Effect.fail(trackerNotFoundError(`GitLab issue ${id} not found`));
        }
        const issue = mapRawToNormalized(raw);
        if (issue === null) {
          return yield* Effect.fail(
            invalidTrackerConfig(`Issue ${id} produced a malformed record`),
          );
        }
        return issue;
      });

    const probe = (): Effect.Effect<void, TrackerAdapterError> =>
      client.validateCredentials().pipe(Effect.asVoid);

    const secretEnvNames = () => {
      const names = new Set<string>(["GITLAB_PAT", "GITLAB_ACCESS_TOKEN"]);
      if (apiKey.envName !== undefined) {
        names.add(apiKey.envName);
      }
      return Array.from(names);
    };

    const profile: AdapterProfile = {
      kind: "gitlab",
      displayName: "GitLab",
      activeStates,
      terminalStates,
      providerKeys: [
        {
          key: "api_url",
          required: false,
          secret: false,
          description: `GitLab API v4 URL, defaults to ${DEFAULT_API_URL}`,
        },
        {
          key: "project_path",
          required: true,
          secret: false,
          description: "Project namespace/path, e.g. my-org/my-project",
        },
        {
          key: "api_key",
          required: true,
          secret: true,
          description: "GitLab PAT, or a $VAR name (or GITLAB_PAT env)",
        },
      ],
      scopeSelection: `Single GitLab project ${projectPath}`,
      pagination: "REST pagination at 100 per page (created_at asc)",
      idMapping: "GitLab issue iid as string; nativeRef holds id/project_id/project_path",
      normalization: "Per SPEC 11.3 via Normalize.ts; state query maps opened/closed/all",
      errorMapping: "HttpClient -> tracker_request/tracker_response/tracker_rate_limited",
      agentTools: [],
    };

    return {
      validateConfiguration: () =>
        Effect.gen(function* () {
          if (!validateStates(activeStates, ALLOWED_ACTIVE_STATES)) {
            return yield* Effect.fail(
              invalidTrackerConfig('active_states may only contain "opened" for GitLab'),
            );
          }
          if (!validateStates(terminalStates, ALLOWED_TERMINAL_STATES)) {
            return yield* Effect.fail(
              invalidTrackerConfig('terminal_states may only contain "closed" for GitLab'),
            );
          }
          yield* client.validateCredentials();
          return;
        }),
      listCandidateIssues,
      refreshIssues,
      getIssue,
      secretEnvironmentNames: secretEnvNames,
      probe,
      profile: () => profile,
    } satisfies TrackerAdapter;
  });

const normalizeStates = (value: unknown): ReadonlyArray<string> | null =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : null;
