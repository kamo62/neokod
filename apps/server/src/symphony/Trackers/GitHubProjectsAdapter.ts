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
  makeGitHubProjectsApiClient,
  type GitHubProjectItem,
  type GitHubProjectsApiClientShape,
} from "./GitHubProjectsApiClient.ts";
import { decodeNormalizedIssue, isStateIn, normalizeLabel } from "./Normalize.ts";

/**
 * GitHub Projects v2 tracker adapter (plan 6, WS-Q).
 *
 * Talks to the GitHub GraphQL API with a PAT (Bearer), scoped to one owner
 * (org or user) and project number. Polling reads project items whose content
 * is an Issue; the item's single-select status field value is the issue
 * state. Items whose content is not an Issue (drafts, pull requests) are
 * omitted. ID refresh fetches each item and omits missing ids.
 *
 * Credentials resolve from `tracker.provider` (`owner`, `number`,
 * `api_key`) or the `GITHUB_PAT` env fallback; `api_key` may be a `$VAR`
 * name, declared via `secretEnvironmentNames()`.
 */

const GITHUB_PROJECTS_ACTIVE_STATES = ["Open"];
const GITHUB_PROJECTS_TERMINAL_STATES = ["Closed", "Done"];

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

const validOwner = (value: string): boolean => /^[a-zA-Z0-9-]+$/.test(value) && value.length > 0;

const validateStates = (states: ReadonlyArray<string>, allowed: ReadonlyArray<string>): boolean =>
  states.every((state) => allowed.includes(state.trim()));

const parseProjectNumber = (value: string): number | null => {
  const raw = Number(value);
  return Number.isInteger(raw) && raw > 0 ? raw : null;
};

interface SingleSelectValue {
  readonly __typename: "ProjectV2ItemFieldSingleSelectValue";
  readonly name?: string;
}

const isSingleSelectValue = (value: unknown): value is SingleSelectValue =>
  typeof value === "object" &&
  value !== null &&
  (value as { readonly __typename?: unknown }).__typename === "ProjectV2ItemFieldSingleSelectValue";

const itemStatus = (raw: GitHubProjectItem): string | null => {
  // The Status field is authoritative (REVIEW P1 #14: the first single-select
  // field may be Priority, whose value would become the issue state).
  const statusField = raw.statusField;
  if (statusField !== undefined && isSingleSelectValue(statusField)) {
    return statusField.name ?? null;
  }
  const values = raw.fieldValues?.nodes ?? [];
  for (const value of values) {
    if (isSingleSelectValue(value)) {
      return value.name ?? null;
    }
  }
  return null;
};

interface IssueContent {
  readonly __typename: "Issue";
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly body?: string;
  readonly url: string;
  readonly state: string;
  readonly labels?: { readonly nodes?: ReadonlyArray<{ readonly name: string }> };
  readonly assignees?: { readonly nodes?: ReadonlyArray<{ readonly login: string }> };
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

const isIssueContent = (content: unknown): content is IssueContent =>
  typeof content === "object" &&
  content !== null &&
  (content as { readonly __typename?: unknown }).__typename === "Issue";

const issueContent = (raw: GitHubProjectItem): IssueContent | null => {
  const content = raw.content;
  return content !== undefined && isIssueContent(content) ? content : null;
};

export const makeGitHubProjectsAdapter = (options: {
  readonly provider: Readonly<Record<string, unknown>>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<TrackerAdapter, TrackerAdapterError> =>
  Effect.gen(function* () {
    const provider = options.provider;

    const owner = resolveProviderString(provider, "owner");
    const projectNumberValue = resolveProviderString(provider, "number");
    const apiKeyValue = resolveProviderString(provider, "api_key");
    const apiKey = resolveSecretValue(apiKeyValue, options.env);

    if (owner === undefined || !validOwner(owner)) {
      return yield* Effect.fail(
        invalidTrackerConfig("tracker.provider.owner must be a GitHub owner (org or user)"),
      );
    }
    const projectNumber = parseProjectNumber(projectNumberValue ?? "");
    if (projectNumber === null) {
      return yield* Effect.fail(
        invalidTrackerConfig("tracker.provider.number must be the GitHub project number"),
      );
    }
    if (apiKey.resolved === undefined) {
      return yield* Effect.fail(missingTrackerSecret(apiKey.envName ?? "GITHUB_PAT"));
    }

    const activeStates = normalizeStates(provider.active_states) ?? GITHUB_PROJECTS_ACTIVE_STATES;
    const terminalStates =
      normalizeStates(provider.terminal_states) ?? GITHUB_PROJECTS_TERMINAL_STATES;

    const client: GitHubProjectsApiClientShape = makeGitHubProjectsApiClient({
      credentials: {
        owner,
        projectNumber,
        token: apiKey.resolved,
      },
      httpClient: options.httpClient,
    });

    const mapRawToNormalized = (raw: GitHubProjectItem): NormalizedIssue | null => {
      const content = issueContent(raw);
      if (content === null) {
        return null;
      }
      return decodeNormalizedIssue({
        id: raw.id,
        nativeRef: {
          item_id: raw.id,
          owner,
          project_number: projectNumber,
          issue_id: content.id,
          issue_number: content.number,
        },
        identifier: `GH-${content.number}`,
        title: content.title,
        description: content.body ?? null,
        priority: null,
        state: itemStatus(raw) ?? content.state,
        branchName: null,
        url: content.url,
        assigneeId: content.assignees?.nodes?.[0]?.login ?? null,
        labels: (content.labels?.nodes ?? []).map((label) => normalizeLabel(label.name)),
        blockedBy: [],
        // Dispatchable only while the underlying issue is not closed
        // (REVIEW P2: this was hardcoded true, so a closed issue in an
        // active status column was reported dispatchable).
        dispatchable: content.state.toUpperCase() !== "CLOSED",
        createdAt: content.createdAt ?? null,
        updatedAt: content.updatedAt ?? null,
      });
    };

    const listCandidateIssues = () =>
      Effect.gen(function* () {
        const raws = yield* client.listProjectItems();
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
          yield* Effect.logWarning(
            `GitHub Projects poll omitted ${dropped} non-issue or malformed item(s)`,
          );
        }
        return issues;
      });

    const refreshIssues = (ids: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const issues: NormalizedIssue[] = [];
        for (const id of ids) {
          const result = yield* Effect.result(client.fetchItem(id));
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
            continue;
          }
          issues.push(issue);
        }
        return issues;
      });

    const getIssue = (id: string) =>
      Effect.gen(function* () {
        const result = yield* Effect.result(client.fetchItem(id));
        if (result._tag === "Failure") {
          if (
            isTrackerAdapterError(result.failure) &&
            result.failure.code === "tracker_not_found"
          ) {
            return yield* Effect.fail(trackerNotFoundError(`GitHub project item ${id} not found`));
          }
          return yield* Effect.fail(result.failure);
        }
        const issue = mapRawToNormalized(result.success);
        if (issue === null) {
          return yield* Effect.fail(invalidTrackerConfig(`Project item ${id} is not an issue`));
        }
        return issue;
      });

    const probe = (): Effect.Effect<void, TrackerAdapterError> =>
      client.validateCredentials().pipe(Effect.asVoid);

    const secretEnvNames = () => {
      const names = new Set<string>(["GITHUB_PAT", "GITHUB_TOKEN"]);
      if (apiKey.envName !== undefined) {
        names.add(apiKey.envName);
      }
      return Array.from(names);
    };

    const profile: AdapterProfile = {
      kind: "github_projects",
      displayName: "GitHub Projects",
      activeStates,
      terminalStates,
      providerKeys: [
        {
          key: "owner",
          required: true,
          secret: false,
          description: "GitHub owner (organization or user) hosting the project",
        },
        {
          key: "number",
          required: true,
          secret: false,
          description: "GitHub Projects v2 project number",
        },
        {
          key: "api_key",
          required: true,
          secret: true,
          description: "GitHub PAT with project read scope, or a $VAR name (or GITHUB_PAT env)",
        },
      ],
      scopeSelection: `GitHub Projects v2 project ${owner}/${projectNumber}`,
      pagination: "GraphQL cursor pagination at 100 per page",
      idMapping: "Project item id as string; nativeRef holds item_id/owner/project_number",
      normalization: "Per SPEC 11.3 via Normalize.ts; state is the single-select status value",
      errorMapping: "GraphQL errors -> tracker_response; HTTP 429 -> tracker_rate_limited",
      agentTools: [],
    };

    return {
      validateConfiguration: () =>
        Effect.gen(function* () {
          if (!validateStates(activeStates, GITHUB_PROJECTS_ACTIVE_STATES)) {
            return yield* Effect.fail(
              invalidTrackerConfig('active_states may only contain "Open" for GitHub Projects'),
            );
          }
          if (!validateStates(terminalStates, GITHUB_PROJECTS_TERMINAL_STATES)) {
            return yield* Effect.fail(
              invalidTrackerConfig(
                'terminal_states may only contain "Closed" or "Done" for GitHub Projects',
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
