import type { NormalizedIssue } from "@neokod/contracts";
import * as Effect from "effect/Effect";

import type { AdapterProfile, TrackerAdapter } from "./Adapter.ts";
import { invalidTrackerConfig, isTrackerAdapterError, missingTrackerSecret } from "./Errors.ts";
import type { TrackerAdapterError } from "./Errors.ts";
import { GitHubIssuesCli } from "./GitHubIssuesCli.ts";
import type { GitHubIssueRaw } from "./GitHubIssuesCli.ts";
import { decodeNormalizedIssue } from "./Normalize.ts";

/**
 * GitHub Issues tracker adapter (SPEC 11.2, plan 5.2).
 *
 * Uses `gh issue` in the host process. If `tracker.provider.tokenEnv` names a
 * `$VAR`, the value is read from the process environment at construction and
 * injected only into the host-side `gh` process; the env name is declared via
 * `secretEnvironmentNames()` so the coding-agent child never inherits it.
 *
 * Scope: a single repository (`tracker.provider.repo`, e.g. `owner/name`).
 * `dispatchable` is derived from `tracker.provider` rules: default is open +
 * unassigned (or assigned to a configured `assignee`).
 */

const GITHUB_ACTIVE_STATES = ["open"];
const GITHUB_TERMINAL_STATES = ["closed"];

const normalizeState = (state: string): string => state.trim().toLowerCase();

const parsePriorityLabel = (
  labels: ReadonlyArray<string>,
  priorityPattern?: string,
): number | null => {
  if (priorityPattern === undefined) {
    return null;
  }
  for (const label of labels) {
    const level = priorityLevelFromLabel(label, priorityPattern);
    if (level !== null) {
      return level;
    }
  }
  return null;
};

/**
 * Match a priority label against a pattern.
 *
 * Supported shapes:
 * - `P{n}` / `P:{n}`: a prefix (colon optional) followed by the `{n}` number
 *   placeholder; the number after the prefix is the priority.
 * - `P0`, `P:0`: a literal label that is itself the priority level.
 * `$VAR` indirection is resolved upstream by the config loader, so no
 * placeholder handling is needed here.
 */
const priorityLevelFromLabel = (label: string, pattern: string): number | null => {
  const placeholderIndex = pattern.indexOf("{n}");
  if (placeholderIndex !== -1) {
    let prefix = pattern.slice(0, placeholderIndex);
    if (prefix.endsWith(":")) {
      prefix = prefix.slice(0, -1);
    }
    if (label.toLowerCase().startsWith(prefix.toLowerCase())) {
      const raw = label.slice(prefix.length);
      const parsed = Number(raw);
      return Number.isInteger(parsed) ? parsed : null;
    }
    return null;
  }
  if (label.toLowerCase() === pattern.toLowerCase()) {
    const parsed = Number(pattern.replace(/[^0-9-]/g, ""));
    return Number.isInteger(parsed) ? parsed : null;
  }
  return null;
};

const resolveTokenEnv = (provider: Readonly<Record<string, unknown>>): string | null => {
  const tokenEnv = provider.tokenEnv;
  if (typeof tokenEnv !== "string" || tokenEnv.length === 0) {
    return null;
  }
  return tokenEnv;
};

export const makeGitHubIssuesAdapter = (options: {
  readonly cwd: string;
  readonly provider: Readonly<Record<string, unknown>>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cli: GitHubIssuesCli["Service"];
}): Effect.Effect<TrackerAdapter, TrackerAdapterError> =>
  Effect.gen(function* () {
    const cli = options.cli;
    const repo =
      typeof options.provider.repo === "string" && options.provider.repo.length > 0
        ? options.provider.repo
        : undefined;
    if (repo === undefined) {
      return yield* Effect.fail(
        invalidTrackerConfig("tracker.provider.repo must be an owner/name repository selector"),
      );
    }

    const tokenEnv = resolveTokenEnv(options.provider);
    const directToken =
      typeof options.provider.token === "string" && options.provider.token.length > 0
        ? options.provider.token
        : undefined;
    const tokenValue = directToken ?? (tokenEnv === null ? undefined : options.env[tokenEnv]);
    if (tokenEnv !== null && (tokenValue === undefined || tokenValue === "")) {
      return yield* Effect.fail(missingTrackerSecret(tokenEnv));
    }
    const cliEnv: NodeJS.ProcessEnv | undefined =
      directToken !== undefined
        ? { GH_TOKEN: directToken }
        : tokenEnv === null
          ? undefined
          : { [tokenEnv]: tokenValue };

    const activeStates = normalizeStates(options.provider.active_states) ?? GITHUB_ACTIVE_STATES;
    const terminalStates =
      normalizeStates(options.provider.terminal_states) ?? GITHUB_TERMINAL_STATES;
    const configuredAssignees = Array.isArray(options.provider.assignees)
      ? options.provider.assignees.filter((entry): entry is string => typeof entry === "string")
      : undefined;
    const priorityLabelPattern =
      typeof options.provider.priority_label === "string"
        ? options.provider.priority_label
        : undefined;

    const deriveDispatchable = (issue: {
      readonly state: string;
      readonly assignees: ReadonlyArray<{ readonly login: string }>;
    }): boolean => {
      if (normalizeState(issue.state) !== "open") {
        return false;
      }
      const logins = new Set(issue.assignees.map((a) => a.login.toLowerCase()));
      if (configuredAssignees === undefined) {
        // Default (no assignees configured): open and unassigned, or assigned
        // to a configured bot identity. With no bot configured, only unassigned
        // open issues are dispatchable.
        return logins.size === 0;
      }
      if (configuredAssignees.length === 0) {
        return true;
      }
      return configuredAssignees.some((assignee) => logins.has(assignee.toLowerCase()));
    };

    const mapRawToNormalized = (raw: GitHubIssueRaw): NormalizedIssue | null => {
      const labels = raw.labels.map((label) => label.name);
      const issue = {
        id: String(raw.number),
        identifier: `#${raw.number}`,
        title: raw.title,
        description: raw.body,
        priority: parsePriorityLabel(labels, priorityLabelPattern),
        state: raw.state,
        branchName: null,
        url: raw.url,
        assigneeId: raw.assignees[0]?.login ?? null,
        labels,
        blockedBy: [],
        dispatchable: deriveDispatchable(raw),
        createdAt: raw.createdAt ?? null,
        updatedAt: raw.updatedAt ?? null,
        nativeRef: { owner: repo, repo, number: raw.number },
      };
      return decodeNormalizedIssue(issue);
    };

    const validateConfiguration = (): Effect.Effect<void, TrackerAdapterError> =>
      Effect.gen(function* () {
        if (activeStates.length === 0 || terminalStates.length === 0) {
          return yield* Effect.fail(
            invalidTrackerConfig("active_states and terminal_states must be non-empty"),
          );
        }
        yield* cli.execute({
          cwd: options.cwd,
          ...(cliEnv === undefined ? {} : { env: cliEnv }),
          args: ["auth", "status"],
        });
        return;
      });

    const listCandidateIssues = () =>
      cli
        .listOpenIssues({
          cwd: options.cwd,
          repo,
          ...(cliEnv === undefined ? {} : { env: cliEnv }),
        })
        .pipe(
          Effect.map((raws) =>
            raws.flatMap((raw) => {
              const issue = mapRawToNormalized(raw);
              return issue === null ? [] : [issue];
            }),
          ),
        );

    const refreshIssues = (ids: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const issues: NormalizedIssue[] = [];
        let dropped = 0;
        for (const id of ids) {
          const rawResult = yield* Effect.result(
            cli.getIssue({
              cwd: options.cwd,
              repo,
              number: id,
              ...(cliEnv === undefined ? {} : { env: cliEnv }),
            }),
          );
          if (rawResult._tag === "Failure") {
            if (isTrackerAdapterError(rawResult.failure)) {
              if (rawResult.failure.code === "tracker_not_found") {
                // An ID no longer visible in scope is omitted, not a batch
                // failure (plan 5.1): absence means no-longer-visible.
                continue;
              }
              if (rawResult.failure.code === "invalid_tracker_config") {
                return yield* Effect.fail(rawResult.failure);
              }
            }
            dropped += 1;
            continue;
          }
          const issue = mapRawToNormalized(rawResult.success);
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
      cli
        .getIssue({
          cwd: options.cwd,
          repo,
          number: id,
          ...(cliEnv === undefined ? {} : { env: cliEnv }),
        })
        .pipe(
          Effect.flatMap((raw) => {
            const issue = mapRawToNormalized(raw);
            return issue === null
              ? Effect.fail(invalidTrackerConfig(`Issue ${id} produced a malformed record`))
              : Effect.succeed(issue);
          }),
        );

    const probe = (): Effect.Effect<void, TrackerAdapterError> =>
      cli
        .execute({
          cwd: options.cwd,
          ...(cliEnv === undefined ? {} : { env: cliEnv }),
          args: ["auth", "status"],
        })
        .pipe(Effect.asVoid);

    const profile: AdapterProfile = {
      kind: "github",
      displayName: "GitHub Issues",
      activeStates,
      terminalStates,
      providerKeys: [
        {
          key: "repo",
          required: true,
          secret: false,
          description: "owner/name repository selector",
        },
        {
          key: "tokenEnv",
          required: false,
          secret: true,
          description: "$VAR name of a GH token; defaults to gh credential store",
        },
        {
          key: "assignees",
          required: false,
          secret: false,
          description: "logins that make an issue dispatchable; empty means any",
        },
        {
          key: "priority_label",
          required: false,
          secret: false,
          description: "label pattern (e.g. P{n}) mapped to dispatch priority",
        },
      ],
      scopeSelection: `Single repository ${repo}`,
      pagination: `gh issue list paged at 100 per request`,
      idMapping: "issue number as string; nativeRef holds owner/repo/number",
      normalization: "Per SPEC 11.3 via Normalize.ts",
      errorMapping:
        "VcsError -> tracker_request/tracker_status/tracker_response/tracker_rate_limited",
      agentTools: [],
    };

    const adapter: TrackerAdapter = {
      validateConfiguration,
      listCandidateIssues,
      refreshIssues,
      getIssue,
      secretEnvironmentNames: () =>
        directToken === undefined && tokenEnv !== null ? [tokenEnv] : [],
      probe,
      profile: () => profile,
    };
    return adapter;
  });

const normalizeStates = (value: unknown): ReadonlyArray<string> | null =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : null;

// Re-export the raw type used by the mapper so callers can construct test fixtures.
export type { GitHubIssueRaw };
