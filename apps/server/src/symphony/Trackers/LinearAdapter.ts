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
  makeLinearApiClient,
  type LinearApiClientShape,
  type LinearRawIssue,
} from "./LinearApiClient.ts";
import { decodeNormalizedIssue, normalizeLabel, normalizeState } from "./Normalize.ts";

/**
 * Linear tracker adapter (SPEC 11.2, plan 5.0.1).
 *
 * Talks to the Linear GraphQL API with the API key as the `Authorization`
 * header (no Bearer prefix), scoped to a project slug. Polling, ID refresh,
 * blocker extraction, dispatchability gating (assignee filter + blocking
 * relations), and `"me"` assignee resolution mirror
 * `.repos/symphony/elixir/.../linear/client.ex` (the authoritative reference).
 *
 * Credentials resolve from `tracker.provider` (`endpoint`, `api_key`,
 * `project_slug`, optional `assignee`) or the `LINEAR_API_KEY` env fallback.
 * `api_key` may be a `$VAR` name; the env name is declared via
 * `secretEnvironmentNames()` so the coding-agent child never inherits it.
 */

const DEFAULT_ACTIVE_STATES = ["Todo", "In Progress"];
const DEFAULT_TERMINAL_STATES = ["Done", "Cancelled"];

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

interface AssigneeFilter {
  readonly configured: string;
  readonly matchValues: ReadonlySet<string>;
}

export const makeLinearAdapter = (options: {
  readonly provider: Readonly<Record<string, unknown>>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<TrackerAdapter, TrackerAdapterError> =>
  Effect.gen(function* () {
    const provider = options.provider;

    const endpoint = resolveProviderString(provider, "endpoint");
    const apiKeyValue = resolveProviderString(provider, "api_key");
    const apiKey = resolveSecretValue(apiKeyValue, options.env);
    const projectSlug = resolveProviderString(provider, "project_slug");
    const assignee = resolveProviderString(provider, "assignee");

    if (endpoint === undefined || !validEndpoint(endpoint)) {
      return yield* Effect.fail(
        invalidTrackerConfig("tracker.provider.endpoint must be an https Linear GraphQL URL"),
      );
    }
    if (apiKey.resolved === undefined) {
      return yield* Effect.fail(missingTrackerSecret(apiKey.envName ?? "LINEAR_API_KEY"));
    }
    if (projectSlug === undefined) {
      return yield* Effect.fail(
        invalidTrackerConfig("tracker.provider.project_slug must be a Linear project slug"),
      );
    }

    const activeStates = normalizeStates(options.provider.active_states) ?? DEFAULT_ACTIVE_STATES;
    const terminalStates =
      normalizeStates(options.provider.terminal_states) ?? DEFAULT_TERMINAL_STATES;

    const client: LinearApiClientShape = makeLinearApiClient({
      credentials: {
        endpoint: endpoint.replace(/\/+$/, ""),
        apiKey: apiKey.resolved,
        projectSlug,
      },
      httpClient: options.httpClient,
    });

    let resolvedAssigneeFilter: AssigneeFilter | null | undefined;
    const resolveAssigneeFilter = (): Effect.Effect<AssigneeFilter | null, TrackerAdapterError> =>
      Effect.gen(function* () {
        if (resolvedAssigneeFilter !== undefined) {
          return resolvedAssigneeFilter;
        }
        if (assignee === undefined) {
          resolvedAssigneeFilter = null;
          return null;
        }
        const normalized = assignee.trim();
        if (normalized === "me") {
          const viewerId = yield* client.fetchViewerId();
          if (viewerId === null) {
            return yield* Effect.fail(
              invalidTrackerConfig('tracker.provider.assignee "me" could not resolve a viewer id'),
            );
          }
          resolvedAssigneeFilter = { configured: "me", matchValues: new Set([viewerId]) };
        } else {
          resolvedAssigneeFilter = { configured: normalized, matchValues: new Set([normalized]) };
        }
        return resolvedAssigneeFilter;
      });

    const assignedToWorker = (
      assigneeId: string | null,
      filter: AssigneeFilter | null,
    ): boolean => {
      if (filter === null) {
        return true;
      }
      return assigneeId !== null && filter.matchValues.has(assigneeId);
    };

    const dispatchable = (
      state: string,
      blockedBy: ReadonlyArray<{
        readonly id: string;
        readonly identifier: string;
        readonly state: string | null;
      }>,
      assigneeId: string | null,
      filter: AssigneeFilter | null,
    ): boolean => {
      const assigned = assignedToWorker(assigneeId, filter);
      if (!assigned) {
        return false;
      }
      if (normalizeState(state) !== "todo") {
        return true;
      }
      return !blockedBy.some((blocker) => {
        if (blocker.state === null) {
          return true;
        }
        return !terminalStates.some(
          (terminal) => normalizeState(terminal) === normalizeState(blocker.state as string),
        );
      });
    };

    const mapRawToNormalized = (
      raw: LinearRawIssue,
      filter: AssigneeFilter | null,
    ): NormalizedIssue | null =>
      decodeNormalizedIssue({
        id: raw.id,
        nativeRef: { projectSlug, identifier: raw.identifier },
        identifier: raw.identifier,
        title: raw.title,
        description: raw.description,
        priority: raw.priority,
        state: raw.state,
        branchName: raw.branchName,
        url: raw.url,
        assigneeId: raw.assigneeId,
        labels: raw.labels.map(normalizeLabel),
        blockedBy: raw.blockedBy,
        dispatchable: dispatchable(raw.state, raw.blockedBy, raw.assigneeId, filter),
        createdAt: raw.createdAt,
        updatedAt: raw.updatedAt,
      });

    const listCandidateIssues = () =>
      Effect.gen(function* () {
        const filter = yield* resolveAssigneeFilter();
        const issues: NormalizedIssue[] = [];
        let dropped = 0;
        let cursor: string | undefined;
        for (;;) {
          const page = yield* client.pollIssues({
            projectSlug,
            stateNames: activeStates,
            ...(cursor === undefined ? {} : { after: cursor }),
          });
          for (const raw of page.issues) {
            const issue = mapRawToNormalized(raw, filter);
            if (issue === null) {
              dropped += 1;
            } else {
              issues.push(issue);
            }
          }
          if (!page.hasNextPage || page.endCursor === null) {
            break;
          }
          cursor = page.endCursor;
        }
        if (dropped > 0) {
          yield* Effect.logWarning(`Linear poll dropped ${dropped} malformed record(s)`);
        }
        return issues;
      });

    const refreshIssues = (ids: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const filter = yield* resolveAssigneeFilter();
        const rawResult = yield* Effect.result(client.fetchIssuesByIds(ids, projectSlug));
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
          const issue = mapRawToNormalized(raw, filter);
          if (issue === null) {
            return yield* Effect.fail(
              invalidTrackerConfig(`ID-refresh returned a malformed record for ${raw.id}`),
            );
          }
          issues.push(issue);
        }
        return issues;
      });

    const getIssue = (id: string) =>
      client.fetchIssuesByIds([id], projectSlug).pipe(
        Effect.flatMap((raws) => {
          const raw = raws[0];
          if (raw === undefined) {
            return Effect.fail(trackerNotFoundError(`Linear issue ${id} not found`));
          }
          return resolveAssigneeFilter().pipe(
            Effect.flatMap((filter) => {
              const issue = mapRawToNormalized(raw, filter);
              return issue === null
                ? Effect.fail(invalidTrackerConfig(`Issue ${id} produced a malformed record`))
                : Effect.succeed(issue);
            }),
          );
        }),
      );

    const probe = (): Effect.Effect<void, TrackerAdapterError> =>
      client.validateCredentials().pipe(Effect.asVoid);

    const secretEnvNames = () => {
      const names = new Set<string>(["LINEAR_API_KEY"]);
      if (apiKey.envName !== undefined) {
        names.add(apiKey.envName);
      }
      return Array.from(names);
    };

    const profile: AdapterProfile = {
      kind: "linear",
      displayName: "Linear",
      activeStates,
      terminalStates,
      providerKeys: [
        {
          key: "endpoint",
          required: true,
          secret: false,
          description: "Linear GraphQL endpoint, e.g. https://api.linear.app/graphql",
        },
        {
          key: "api_key",
          required: true,
          secret: true,
          description: "Linear API key, or a $VAR name (or LINEAR_API_KEY env)",
        },
        {
          key: "project_slug",
          required: true,
          secret: false,
          description: "Project slug scope, e.g. my-project",
        },
        {
          key: "assignee",
          required: false,
          secret: false,
          description:
            'Only dispatch issues assigned to this user id, or "me" for the API key owner',
        },
      ],
      scopeSelection: `Single Linear project ${projectSlug}`,
      pagination: "GraphQL cursor pagination at 50 per page via pageInfo.endCursor",
      idMapping: "Linear issue uuid as string; nativeRef holds projectSlug/identifier",
      normalization:
        "Per SPEC 11.3 via Normalize.ts; relation blockers extracted from inverseRelations",
      errorMapping: "HttpClient -> tracker_request/tracker_response/tracker_rate_limited",
      agentTools: [],
    };

    return {
      validateConfiguration: () =>
        Effect.gen(function* () {
          if (activeStates.length === 0 || terminalStates.length === 0) {
            return yield* Effect.fail(
              invalidTrackerConfig("active_states and terminal_states must be non-empty"),
            );
          }
          yield* client.validateCredentials();
          yield* resolveAssigneeFilter();
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
