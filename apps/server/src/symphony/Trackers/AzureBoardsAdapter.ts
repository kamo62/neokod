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
  makeAzureBoardsApiClient,
  type AzureBoardsApiClientShape,
  type AzureBoardsWorkItem,
} from "./AzureBoardsApiClient.ts";
import { decodeNormalizedIssue, isStateIn, normalizeLabel, normalizeState } from "./Normalize.ts";

/**
 * Azure Boards tracker adapter (plan 6, WS-Q).
 *
 * Talks to the Azure DevOps REST API with a PAT (Basic auth), scoped to one
 * organization + project. Polling runs a flat WIQL query for the configured
 * active states and batch-fetches the referenced work items; ID refresh
 * fetches each id individually and omits 404s. Normalization mirrors the
 * other adapters via Normalize.ts.
 *
 * Credentials resolve from `tracker.provider` (`organization`, `project`,
 * `api_key`) or the `AZURE_DEVOPS_PAT` env fallback; `api_key` may be a
 * `$VAR` name, declared via `secretEnvironmentNames()`.
 */

const ALLOWED_ACTIVE_STATES = ["Active"];
const ALLOWED_TERMINAL_STATES = ["Closed", "Removed"];

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

const validIdentifier = (value: string): boolean => {
  if (value.length === 0) {
    return false;
  }
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 47) {
      return false;
    }
  }
  return true;
};

const validateStates = (states: ReadonlyArray<string>, allowed: ReadonlyArray<string>): boolean =>
  states.every((state) => allowed.includes(normalizeState(state)));

const parseId = (value: string): number | null => {
  const raw = Number(value);
  return Number.isInteger(raw) && raw > 0 ? raw : null;
};

const field = (raw: AzureBoardsWorkItem, name: string): string | null => {
  const value = raw.fields?.[name];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return null;
};

const extractAssigneeId = (raw: AzureBoardsWorkItem): string | null => {
  const assigned = raw.fields?.["System.AssignedTo"];
  if (typeof assigned === "string") {
    const match = /<([^>]+)>$/.exec(assigned.trim());
    return match?.[1] ?? assigned.trim();
  }
  if (typeof assigned === "object" && assigned !== null) {
    const id = (assigned as { id?: unknown }).id;
    if (typeof id === "number") {
      return String(id);
    }
    const uniqueName = (assigned as { uniqueName?: unknown }).uniqueName;
    if (typeof uniqueName === "string") {
      return uniqueName;
    }
  }
  return null;
};

export const makeAzureBoardsAdapter = (options: {
  readonly provider: Readonly<Record<string, unknown>>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<TrackerAdapter, TrackerAdapterError> =>
  Effect.gen(function* () {
    const provider = options.provider;

    const organization = resolveProviderString(provider, "organization");
    const project = resolveProviderString(provider, "project");
    const apiKeyValue = resolveProviderString(provider, "api_key");
    const apiKey = resolveSecretValue(apiKeyValue, options.env);

    if (organization === undefined || !validIdentifier(organization)) {
      return yield* Effect.fail(
        invalidTrackerConfig("tracker.provider.organization must be an Azure DevOps organization"),
      );
    }
    if (project === undefined || !validIdentifier(project)) {
      return yield* Effect.fail(
        invalidTrackerConfig("tracker.provider.project must be an Azure DevOps project"),
      );
    }
    if (apiKey.resolved === undefined) {
      return yield* Effect.fail(missingTrackerSecret(apiKey.envName ?? "AZURE_DEVOPS_PAT"));
    }

    const activeStates = normalizeStates(provider.active_states) ?? ALLOWED_ACTIVE_STATES;
    const terminalStates = normalizeStates(provider.terminal_states) ?? ALLOWED_TERMINAL_STATES;

    const client: AzureBoardsApiClientShape = makeAzureBoardsApiClient({
      credentials: {
        organization,
        project,
        pat: apiKey.resolved,
      },
      httpClient: options.httpClient,
    });

    const mapRawToNormalized = (raw: AzureBoardsWorkItem): NormalizedIssue | null => {
      const id = raw.id;
      if (!Number.isInteger(id) || id <= 0) {
        return null;
      }
      return decodeNormalizedIssue({
        id: String(id),
        nativeRef: {
          id: raw.id,
          rev: raw.rev,
          organization,
          project,
          type: field(raw, "System.WorkItemType"),
        },
        identifier: `AB-${id}`,
        title: field(raw, "System.Title") ?? `Work item ${id}`,
        description: field(raw, "System.Description"),
        priority: null,
        state: field(raw, "System.State") ?? "Active",
        branchName: null,
        url: raw.url,
        assigneeId: extractAssigneeId(raw),
        labels: (field(raw, "System.Tags") ?? "")
          .split(";")
          .map(normalizeLabel)
          .filter((label) => label.length > 0),
        blockedBy: [],
        // Dispatchable only while the state is not terminal (REVIEW P2: this
        // was hardcoded true, so a closed item in an active-state query was
        // reported dispatchable).
        dispatchable: !terminalStates.includes((field(raw, "System.State") ?? "Active").trim()),
        createdAt: field(raw, "System.CreatedDate"),
        updatedAt: field(raw, "System.ChangedDate"),
      });
    };

    const listCandidateIssues = () =>
      Effect.gen(function* () {
        const ids = yield* client.queryWorkItemIds(activeStates);
        const raws = yield* client.fetchWorkItemsByIds(ids);
        const issues: NormalizedIssue[] = [];
        let dropped = 0;
        for (const raw of raws) {
          const issue = mapRawToNormalized(raw);
          if (issue === null) {
            dropped += 1;
          } else if (isStateIn(issue.state, activeStates)) {
            issues.push(issue);
          }
        }
        if (dropped > 0) {
          yield* Effect.logWarning(`Azure Boards poll dropped ${dropped} malformed record(s)`);
        }
        return issues;
      });

    const refreshIssues = (ids: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const issues: NormalizedIssue[] = [];
        for (const id of ids) {
          const numeric = parseId(id);
          if (numeric === null) {
            return yield* Effect.fail(
              invalidTrackerConfig(`Azure Boards id must be a positive integer, got ${id}`),
            );
          }
          const result = yield* Effect.result(client.fetchWorkItem(numeric));
          if (result._tag === "Failure") {
            if (isTrackerAdapterError(result.failure)) {
              if (result.failure.code === "tracker_not_found") {
                continue;
              }
            }
            return yield* Effect.fail(result.failure);
          }
          const issue = mapRawToNormalized(result.success);
          if (issue === null) {
            return yield* Effect.fail(
              invalidTrackerConfig(`ID-refresh returned a malformed record for ${id}`),
            );
          }
          issues.push(issue);
        }
        return issues;
      });

    const getIssue = (id: string) =>
      Effect.gen(function* () {
        const numeric = parseId(id);
        if (numeric === null) {
          return yield* Effect.fail(
            invalidTrackerConfig(`Azure Boards id must be a positive integer, got ${id}`),
          );
        }
        const result = yield* Effect.result(client.fetchWorkItem(numeric));
        if (result._tag === "Failure") {
          if (
            isTrackerAdapterError(result.failure) &&
            result.failure.code === "tracker_not_found"
          ) {
            return yield* Effect.fail(
              trackerNotFoundError(`Azure Boards work item ${id} not found`),
            );
          }
          return yield* Effect.fail(result.failure);
        }
        const issue = mapRawToNormalized(result.success);
        if (issue === null) {
          return yield* Effect.fail(
            invalidTrackerConfig(`Work item ${id} produced a malformed record`),
          );
        }
        return issue;
      });

    const probe = (): Effect.Effect<void, TrackerAdapterError> =>
      client.validateCredentials().pipe(Effect.asVoid);

    const secretEnvNames = () => {
      const names = new Set<string>(["AZURE_DEVOPS_PAT"]);
      if (apiKey.envName !== undefined) {
        names.add(apiKey.envName);
      }
      return Array.from(names);
    };

    const profile: AdapterProfile = {
      kind: "azure_boards",
      displayName: "Azure Boards",
      activeStates,
      terminalStates,
      providerKeys: [
        {
          key: "organization",
          required: true,
          secret: false,
          description: "Azure DevOps organization name",
        },
        {
          key: "project",
          required: true,
          secret: false,
          description: "Azure DevOps project name",
        },
        {
          key: "api_key",
          required: true,
          secret: true,
          description: "Azure DevOps PAT, or a $VAR name (or AZURE_DEVOPS_PAT env)",
        },
      ],
      scopeSelection: `Single Azure DevOps project ${organization}/${project}`,
      pagination: "WIQL query + batch work item fetch (all referenced ids)",
      idMapping: "Azure Boards work item id as string; nativeRef holds id/rev/type",
      normalization: "Per SPEC 11.3 via Normalize.ts; state maps System.State",
      errorMapping: "HttpClient -> tracker_request/tracker_response/tracker_rate_limited",
      agentTools: [],
    };

    return {
      validateConfiguration: () =>
        Effect.gen(function* () {
          if (!validateStates(activeStates, ALLOWED_ACTIVE_STATES)) {
            return yield* Effect.fail(
              invalidTrackerConfig('active_states may only contain "Active" for Azure Boards'),
            );
          }
          if (!validateStates(terminalStates, ALLOWED_TERMINAL_STATES)) {
            return yield* Effect.fail(
              invalidTrackerConfig(
                'terminal_states may only contain "Closed" or "Removed" for Azure Boards',
              ),
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
