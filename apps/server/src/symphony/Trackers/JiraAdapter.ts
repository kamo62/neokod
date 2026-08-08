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
import { makeJiraApiClient, type JiraCredentials, type JiraRawIssue } from "./JiraApiClient.ts";
import { decodeNormalizedIssue, normalizeLabel, normalizeState } from "./Normalize.ts";

/**
 * Jira Cloud tracker adapter (SPEC 11.2, plan 5.2).
 *
 * Talks to the Jira Cloud REST API over the shared `HttpClient` with Basic
 * auth (email + API token), scoped to a project key. Field mapping, blocker
 * extraction, dispatchability gating, and ADF description flattening mirror
 * `.repos/symphony/elixir/.../jira/client.ex` (the authoritative reference).
 *
 * Credentials resolve from `tracker.provider` (`base_url`, `email`,
 * `api_token`, `project_key`) or the `JIRA_BASE_URL` / `JIRA_EMAIL` /
 * `JIRA_API_TOKEN` env fallbacks. `api_token` may be a `$VAR` name; the env
 * name is declared via `secretEnvironmentNames()` so the coding-agent child
 * never inherits it.
 */

const DEFAULT_ACTIVE_STATES = ["To Do", "In Progress"];
const DEFAULT_TERMINAL_STATES = ["Done", "Cancelled"];

const BLOCKER_LINK_NAME = "blocks";

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

const validBaseUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.length > 0;
  } catch {
    return false;
  }
};

const flattenAdf = (value: unknown): string | undefined => {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.type === "hardBreak") {
      return "\n";
    }
    if (typeof record.text === "string") {
      return record.text;
    }
    if (Array.isArray(record.content)) {
      const text = record.content
        .map(flattenAdf)
        .filter((part): part is string => part !== undefined)
        .join("");
      return text.length === 0 ? undefined : text;
    }
    if (typeof record.attrs === "object" && record.attrs !== null) {
      const attrs = record.attrs as Record<string, unknown>;
      const value =
        typeof attrs.text === "string"
          ? attrs.text
          : typeof attrs.shortName === "string"
            ? attrs.shortName
            : typeof attrs.url === "string"
              ? attrs.url
              : "";
      return value;
    }
  }
  return undefined;
};

interface BlockerRef {
  readonly id: string | null;
  readonly identifier: string | null;
  readonly state: string | null;
}

const extractBlockers = (links: unknown): ReadonlyArray<BlockerRef> => {
  if (!Array.isArray(links)) {
    return [];
  }
  const blockers: BlockerRef[] = [];
  for (const link of links) {
    if (typeof link !== "object" || link === null) {
      continue;
    }
    const record = link as Record<string, unknown>;
    const typeName = (record.type as Record<string, unknown> | undefined)?.name;
    const inward = record.inwardIssue as Record<string, unknown> | undefined;
    if (normalizeState(String(typeName)) === BLOCKER_LINK_NAME && inward !== undefined) {
      const fields = inward.fields as Record<string, unknown> | undefined;
      const status = fields?.status as Record<string, unknown> | undefined;
      blockers.push({
        id: typeof inward.id === "string" ? inward.id : null,
        identifier: typeof inward.key === "string" ? inward.key : null,
        state: typeof status?.name === "string" ? (status.name as string) : null,
      });
    }
  }
  return blockers;
};

export const makeJiraAdapter = (options: {
  readonly provider: Readonly<Record<string, unknown>>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<TrackerAdapter, TrackerAdapterError> =>
  Effect.gen(function* () {
    const provider = options.provider;

    const baseUrl =
      resolveProviderString(provider, "base_url") ?? resolveEnv("JIRA_BASE_URL", options.env);
    const email = resolveProviderString(provider, "email") ?? resolveEnv("JIRA_EMAIL", options.env);
    const apiTokenValue = resolveProviderString(provider, "api_token");
    const apiToken = resolveSecretValue(apiTokenValue, options.env);
    const projectKey = resolveProviderString(provider, "project_key");

    if (baseUrl === undefined || !validBaseUrl(baseUrl)) {
      return yield* Effect.fail(
        invalidTrackerConfig("tracker.provider.base_url must be an https Jira Cloud URL"),
      );
    }
    if (email === undefined) {
      return yield* Effect.fail(missingTrackerSecret("JIRA_EMAIL"));
    }
    if (apiToken.resolved === undefined) {
      return yield* Effect.fail(missingTrackerSecret(apiToken.envName ?? "JIRA_API_TOKEN"));
    }
    if (projectKey === undefined) {
      return yield* Effect.fail(
        invalidTrackerConfig("tracker.provider.project_key must be a Jira project key"),
      );
    }

    const activeStates = normalizeStates(options.provider.active_states) ?? DEFAULT_ACTIVE_STATES;
    const terminalStates =
      normalizeStates(options.provider.terminal_states) ?? DEFAULT_TERMINAL_STATES;
    const priorityMapping =
      typeof options.provider.priority_mapping === "object" &&
      options.provider.priority_mapping !== null
        ? (options.provider.priority_mapping as Record<string, unknown>)
        : {};

    const credentials: JiraCredentials = {
      baseUrl: baseUrl.replace(/\/+$/, ""),
      email,
      apiToken: apiToken.resolved,
      projectKey,
      terminalStates: terminalStates.map(normalizeState),
    };
    const client = makeJiraApiClient({ credentials, httpClient: options.httpClient });

    const secretEnvNames = () => {
      const names = new Set<string>(["JIRA_API_TOKEN"]);
      if (apiToken.envName !== undefined) {
        names.add(apiToken.envName);
      }
      return Array.from(names);
    };

    const dispatchable = (
      state: string,
      statusCategory: string | undefined,
      blockers: ReadonlyArray<BlockerRef>,
    ): boolean => {
      const gating =
        statusCategory !== undefined && statusCategory !== ""
          ? normalizeState(statusCategory) === "new"
          : normalizeState(state) === "todo" || normalizeState(state) === "to do";
      if (!gating) {
        return true;
      }
      return blockers.every((blocker) => {
        if (blocker.state === null) {
          return false;
        }
        const blockerState = blocker.state;
        return terminalStates.some(
          (terminal) => normalizeState(terminal) === normalizeState(blockerState),
        );
      });
    };

    const mapRawToNormalized = (raw: JiraRawIssue): NormalizedIssue | null => {
      const fields = raw.fields;
      const status = fields.status as Record<string, unknown> | undefined;
      const statusCategory = status?.statusCategory as Record<string, unknown> | undefined;
      const state = typeof status?.name === "string" ? (status.name as string) : undefined;
      const assignee = fields.assignee as Record<string, unknown> | undefined;
      const blockers = extractBlockers(fields.issuelinks);
      const labels = Array.isArray(fields.labels)
        ? (fields.labels as ReadonlyArray<unknown>)
            .filter((label): label is string => typeof label === "string")
            .map(normalizeLabel)
        : [];
      const priorityFromMapping =
        typeof priorityMapping[state ?? ""] === "number"
          ? (priorityMapping[state ?? ""] as number)
          : null;

      const issue = {
        id: raw.id,
        nativeRef: { projectKey: credentials.projectKey, key: raw.key },
        identifier: raw.key,
        title: typeof fields.summary === "string" ? (fields.summary as string) : "",
        description: flattenAdf(fields.description) ?? null,
        priority: priorityFromMapping,
        state: state ?? "",
        branchName: null,
        url: `${credentials.baseUrl}/browse/${encodeURIComponent(raw.key)}`,
        assigneeId: typeof assignee?.accountId === "string" ? (assignee.accountId as string) : null,
        labels,
        blockedBy: blockers,
        dispatchable: dispatchable(
          state ?? "",
          statusCategory?.key as string | undefined,
          blockers,
        ),
        createdAt: typeof fields.created === "string" ? (fields.created as string) : null,
        updatedAt: typeof fields.updated === "string" ? (fields.updated as string) : null,
      };
      return decodeNormalizedIssue(issue);
    };

    const stateJql = () => {
      const quoted = activeStates.map((s) => quoteJql(s)).join(", ");
      return `project = ${quoteJql(credentials.projectKey)} AND status IN (${quoted})`;
    };

    const listCandidateIssues = () =>
      Effect.gen(function* () {
        const issues: NormalizedIssue[] = [];
        let nextToken: string | undefined;
        for (;;) {
          const page = yield* client.searchIssues({
            jql: stateJql(),
            ...(nextToken === undefined ? {} : { nextPageToken: nextToken }),
          });
          for (const raw of page.issues) {
            const issue = mapRawToNormalized(raw);
            if (issue !== null) {
              issues.push(issue);
            }
          }
          if (page.isLast || page.nextPageToken === undefined) {
            break;
          }
          nextToken = page.nextPageToken;
        }
        return issues;
      });

    const refreshIssues = (ids: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const issues: NormalizedIssue[] = [];
        let dropped = 0;
        for (const id of ids) {
          const rawResult = yield* Effect.result(client.bulkFetchIssues([id]));
          if (rawResult._tag === "Failure") {
            if (isTrackerAdapterError(rawResult.failure)) {
              if (rawResult.failure.code === "tracker_not_found") {
                continue;
              }
            }
            dropped += 1;
            continue;
          }
          const raw = rawResult.success.find((candidate) => candidate.id === id);
          if (raw === undefined) {
            // No longer visible in scope: omitted, not a batch failure.
            continue;
          }
          const issue = mapRawToNormalized(raw);
          if (issue === null) {
            dropped += 1;
          } else {
            issues.push(issue);
          }
        }
        if (dropped > 0) {
          return yield* Effect.fail(
            invalidTrackerConfig(`ID-refresh returned ${dropped} malformed record(s)`),
          );
        }
        return issues;
      });

    const getIssue = (id: string) =>
      client.bulkFetchIssues([id]).pipe(
        Effect.flatMap((raws) => {
          const raw = raws[0];
          if (raw === undefined) {
            return Effect.fail(trackerNotFoundError(`Jira issue ${id} not found`));
          }
          const issue = mapRawToNormalized(raw);
          return issue === null
            ? Effect.fail(invalidTrackerConfig(`Issue ${id} produced a malformed record`))
            : Effect.succeed(issue);
        }),
      );

    const probe = (): Effect.Effect<void, TrackerAdapterError> =>
      client.validateCredentials().pipe(Effect.asVoid);

    const profile: AdapterProfile = {
      kind: "jira",
      displayName: "Jira Cloud",
      activeStates,
      terminalStates,
      providerKeys: [
        {
          key: "base_url",
          required: true,
          secret: false,
          description: "Jira Cloud base URL, e.g. https://your-domain.atlassian.net",
        },
        {
          key: "email",
          required: true,
          secret: false,
          description: "Account email for Basic auth (or JIRA_EMAIL env)",
        },
        {
          key: "api_token",
          required: true,
          secret: true,
          description: "Jira API token, or a $VAR name (or JIRA_API_TOKEN env)",
        },
        {
          key: "project_key",
          required: true,
          secret: false,
          description: "Project key scope, e.g. PROJ",
        },
        {
          key: "priority_mapping",
          required: false,
          secret: false,
          description: "state name -> numeric priority map",
        },
      ],
      scopeSelection: `Single Jira project ${credentials.projectKey}`,
      pagination: "Jira search/jql paged at 100 per request via nextPageToken",
      idMapping: "Jira numeric issue id as string; nativeRef holds projectKey/key",
      normalization: "Per SPEC 11.3 via Normalize.ts; ADF descriptions flattened",
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

const quoteJql = (value: string): string =>
  `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
