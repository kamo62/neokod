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
  makeAsanaApiClient,
  type AsanaApiClientShape,
  type AsanaRawTask,
} from "./AsanaApiClient.ts";
import { decodeNormalizedIssue, isStateIn, normalizeLabel } from "./Normalize.ts";

/**
 * Asana tracker adapter (SPEC 11.2, plan 5.0.1).
 *
 * Talks to the Asana API 1.0 with a Bearer token over the shared
 * `HttpClient`, scoped to a project GID. Polling (offset pagination via
 * `next_page`), per-GID ID refresh with 404 and outside-project omission, and
 * normalization mirror `.repos/symphony/elixir/.../asana/client.ex` (the
 * authoritative reference). The section name of the project membership is the
 * issue state; tasks are dispatchable only while incomplete and not a section
 * record.
 *
 * Credentials resolve from `tracker.provider` (`endpoint`, `api_key`,
 * `project_gid`) or the `ASANA_PAT` env fallback. `api_key` may be a `$VAR`
 * name; the env name is declared via `secretEnvironmentNames()` so the
 * coding-agent child never inherits them.
 */

const DEFAULT_ENDPOINT = "https://app.asana.com/api/1.0";

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

/** Resolve a provider value that may be a literal or a `$VAR` reference. */
const resolveSecretValue = (
  value: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): { readonly resolved: string | undefined; readonly envName: string | undefined } => {
  if (value === undefined) {
    return { resolved: undefined, envName: undefined };
  }
  const match = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value.trim());
  if (match === null || match[1] === undefined) {
    return { resolved: value, envName: undefined };
  }
  return { resolved: resolveEnv(match[1], env), envName: match[1] };
};

const validEndpoint = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.length > 0;
  } catch {
    return false;
  }
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

const projectMembership = (
  task: AsanaRawTask,
  projectGid: string,
): { readonly section: { readonly gid: string; readonly name: string } | null } | null => {
  const memberships = task.memberships ?? [];
  for (const membership of memberships) {
    if (membership.project?.gid === projectGid) {
      return { section: membership.section };
    }
  }
  return null;
};

export const makeAsanaAdapter = (options: {
  readonly provider: Readonly<Record<string, unknown>>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<TrackerAdapter, TrackerAdapterError> =>
  Effect.gen(function* () {
    const provider = options.provider;

    const endpoint = resolveProviderString(provider, "endpoint");
    const apiKeyValue = resolveProviderString(provider, "api_key");
    const apiKey = resolveSecretValue(apiKeyValue, options.env);
    const projectGid = resolveProviderString(provider, "project_gid");

    if (endpoint !== undefined && !validEndpoint(endpoint)) {
      return yield* Effect.fail(
        invalidTrackerConfig("tracker.provider.endpoint must be an https Asana API URL"),
      );
    }
    if (apiKey.resolved === undefined) {
      return yield* Effect.fail(missingTrackerSecret(apiKey.envName ?? "ASANA_PAT"));
    }
    if (projectGid === undefined) {
      return yield* Effect.fail(
        invalidTrackerConfig("tracker.provider.project_gid must be an Asana project GID"),
      );
    }

    const activeStates = normalizeStates(options.provider.active_states);
    const terminalStates = normalizeStates(options.provider.terminal_states);

    const client: AsanaApiClientShape = makeAsanaApiClient({
      credentials: {
        endpoint: (endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, ""),
        apiKey: apiKey.resolved,
        projectGid,
      },
      httpClient: options.httpClient,
    });

    const mapRawToNormalized = (raw: AsanaRawTask): NormalizedIssue | null => {
      const membership = projectMembership(raw, projectGid);
      const state = membership?.section?.name;
      if (state === undefined || state === null || state.length === 0) {
        return null;
      }
      return decodeNormalizedIssue({
        id: raw.gid,
        nativeRef: {
          task_gid: raw.gid,
          project_gid: projectGid,
          ...(membership?.section === null || membership?.section === undefined
            ? {}
            : { section_gid: membership.section.gid }),
        },
        identifier: `ASANA-${raw.gid}`,
        title: raw.name,
        description: blankToNull(raw.notes),
        priority: null,
        state,
        branchName: null,
        url: blankToNull(raw.permalink_url),
        assigneeId: raw.assignee === null ? null : raw.assignee.gid,
        labels: (raw.tags ?? []).map((tag) => normalizeLabel(tag.name)),
        blockedBy: [],
        dispatchable: raw.completed === false && raw.resource_subtype !== "section",
        createdAt: parseDatetime(raw.created_at),
        updatedAt: parseDatetime(raw.modified_at),
      });
    };

    const listCandidateIssues = () =>
      Effect.gen(function* () {
        const issues: NormalizedIssue[] = [];
        let dropped = 0;
        let offset: string | undefined;
        for (;;) {
          const result = yield* client.pollTasks({
            projectGid,
            ...(offset === undefined ? {} : { offset }),
          });
          for (const raw of result.tasks) {
            const issue = mapRawToNormalized(raw);
            if (issue === null) {
              dropped += 1;
            } else if (activeStates === null || isStateIn(issue.state, activeStates)) {
              issues.push(issue);
            }
          }
          if (result.nextOffset === null) {
            break;
          }
          offset = result.nextOffset;
        }
        if (dropped > 0) {
          yield* Effect.logWarning(`Asana poll dropped ${dropped} malformed record(s)`);
        }
        return issues;
      });

    const refreshIssues = (ids: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const rawResult = yield* Effect.result(client.fetchTasksByIds(ids, projectGid));
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
          const membership = projectMembership(raw, projectGid);
          if (membership === null) {
            continue;
          }
          const issue = mapRawToNormalized(raw);
          if (issue === null) {
            return yield* Effect.fail(
              invalidTrackerConfig(`ID-refresh returned a malformed record for ${raw.gid}`),
            );
          }
          issues.push(issue);
        }
        return issues;
      });

    const getIssue = (id: string) =>
      Effect.gen(function* () {
        const raws = yield* client.fetchTasksByIds([id], projectGid);
        const raw = raws[0];
        if (raw === undefined) {
          return yield* Effect.fail(trackerNotFoundError(`Asana task ${id} not found`));
        }
        const issue = mapRawToNormalized(raw);
        if (issue === null) {
          return yield* Effect.fail(invalidTrackerConfig(`Task ${id} produced a malformed record`));
        }
        return issue;
      });

    const probe = (): Effect.Effect<void, TrackerAdapterError> =>
      client.validateCredentials().pipe(Effect.asVoid);

    const secretEnvNames = () => {
      const names = new Set<string>(["ASANA_PAT"]);
      if (apiKey.envName !== undefined) {
        names.add(apiKey.envName);
      }
      return Array.from(names);
    };

    const profile: AdapterProfile = {
      kind: "asana",
      displayName: "Asana",
      activeStates: activeStates ?? [],
      terminalStates: terminalStates ?? [],
      providerKeys: [
        {
          key: "endpoint",
          required: false,
          secret: false,
          description: `Asana API base URL, defaults to ${DEFAULT_ENDPOINT}`,
        },
        {
          key: "api_key",
          required: true,
          secret: true,
          description: "Asana PAT, or a $VAR name (or ASANA_PAT env)",
        },
        {
          key: "project_gid",
          required: true,
          secret: false,
          description: "Asana project GID to poll",
        },
      ],
      scopeSelection: `Single Asana project ${projectGid}`,
      pagination: "REST offset pagination at 100 per page via next_page.offset",
      idMapping: "Asana task gid as string; nativeRef holds task_gid/project_gid/section_gid",
      normalization: "Per SPEC 11.3 via Normalize.ts; section name is the state",
      errorMapping: "HttpClient -> tracker_request/tracker_response/tracker_rate_limited",
      agentTools: [],
    };

    return {
      validateConfiguration: () =>
        Effect.gen(function* () {
          if (activeStates !== null && activeStates.length === 0) {
            return yield* Effect.fail(
              invalidTrackerConfig("active_states must be non-empty when provided"),
            );
          }
          if (terminalStates !== null && terminalStates.length === 0) {
            return yield* Effect.fail(
              invalidTrackerConfig("terminal_states must be non-empty when provided"),
            );
          }
          yield* client.validateCredentials();
          return Effect.void;
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
