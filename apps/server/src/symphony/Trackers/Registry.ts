import type { TrackerKind } from "@neokod/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { TrackerAdapterRegistry } from "./Adapter.ts";
import type { TrackerAdapter } from "./Adapter.ts";
import { makeAsanaAdapter } from "./AsanaAdapter.ts";
import { makeAzureBoardsAdapter } from "./AzureBoardsAdapter.ts";
import { TrackerAdapterError, unsupportedTrackerKind } from "./Errors.ts";
import { GitHubIssuesCli, GitHubIssuesCliLive } from "./GitHubIssuesCli.ts";
import { makeGitHubIssuesAdapter } from "./GitHubIssuesAdapter.ts";
import { makeGitHubProjectsAdapter } from "./GitHubProjectsAdapter.ts";
import { makeGitLabAdapter } from "./GitLabAdapter.ts";
import { makeJiraAdapter } from "./JiraAdapter.ts";
import { makeLinearAdapter } from "./LinearAdapter.ts";
import * as HttpClient from "effect/unstable/http/HttpClient";

/**
 * Adapter factory keyed by tracker kind. Leaf adapters (F1-F5) register here
 * in their own layers. The registry resolves a `TrackerKind` plus its
 * `tracker.provider` config into a constructed adapter bound to that
 * configuration; a kind with no registered factory resolves to
 * `unsupported_tracker_kind`.
 */
export type AdapterFactory = (options: {
  readonly repositoryPath: string;
  readonly provider: Readonly<Record<string, unknown>>;
  readonly env: Readonly<Record<string, string | undefined>>;
}) => Effect.Effect<TrackerAdapter, TrackerAdapterError>;

export type AdapterFactories = ReadonlyMap<TrackerKind, AdapterFactory>;

export const makeTrackerRegistry = (factories: AdapterFactories) => {
  const resolve = (
    kind: TrackerKind,
    provider: Readonly<Record<string, unknown>>,
    options?: {
      readonly repositoryPath?: string;
      readonly env?: Readonly<Record<string, string | undefined>>;
    },
  ): Effect.Effect<TrackerAdapter, TrackerAdapterError> => {
    const factory = factories.get(kind);
    if (factory === undefined) {
      return Effect.fail(unsupportedTrackerKind(kind));
    }
    if (options?.repositoryPath === undefined) {
      return Effect.fail(
        new TrackerAdapterError({
          code: "invalid_tracker_config",
          message: "tracker resolution requires a repositoryPath",
        }),
      );
    }
    return factory({
      repositoryPath: options.repositoryPath,
      provider,
      env: options.env ?? {},
    });
  };

  const listKinds = (): ReadonlyArray<TrackerKind> => Array.from(factories.keys());

  return {
    resolve,
    listKinds,
  } satisfies TrackerAdapterRegistry["Service"];
};

/** Registry with no leaf adapters registered. Before F1-F5 land, every real kind resolves to unsupported. */
export const TrackerRegistryEmptyLive = Layer.succeed(TrackerAdapterRegistry, {
  resolve: (kind) => Effect.fail(unsupportedTrackerKind(kind)),
  listKinds: () => [],
});

/** Registry accepting externally-provided adapter factories. */
export const TrackerRegistryWithFactories = (factories: AdapterFactories) =>
  Layer.succeed(TrackerAdapterRegistry, makeTrackerRegistry(factories));

/** Registry wiring the GitHub Issues adapter on top of the `gh` CLI and the
 *  Jira Cloud adapter on the shared HttpClient. */
export const TrackerRegistryGitHubLive = Effect.gen(function* () {
  const cli = yield* GitHubIssuesCli;
  const httpClient = yield* HttpClient.HttpClient;
  const githubFactory: AdapterFactory = ({ repositoryPath, provider, env }) =>
    makeGitHubIssuesAdapter({ cwd: repositoryPath, provider, env, cli });
  const jiraFactory: AdapterFactory = ({ provider, env }) =>
    makeJiraAdapter({ provider, env, httpClient });
  const linearFactory: AdapterFactory = ({ provider, env }) =>
    makeLinearAdapter({ provider, env, httpClient });
  const gitlabFactory: AdapterFactory = ({ provider, env }) =>
    makeGitLabAdapter({ provider, env, httpClient });
  const asanaFactory: AdapterFactory = ({ provider, env }) =>
    makeAsanaAdapter({ provider, env, httpClient });
  const azureBoardsFactory: AdapterFactory = ({ provider, env }) =>
    makeAzureBoardsAdapter({ provider, env, httpClient });
  const githubProjectsFactory: AdapterFactory = ({ provider, env }) =>
    makeGitHubProjectsAdapter({ provider, env, httpClient });
  return Layer.succeed(
    TrackerAdapterRegistry,
    makeTrackerRegistry(
      new Map([
        ["github", githubFactory],
        ["jira", jiraFactory],
        ["linear", linearFactory],
        ["gitlab", gitlabFactory],
        ["asana", asanaFactory],
        ["azure_boards", azureBoardsFactory],
        ["github_projects", githubProjectsFactory],
      ]),
    ),
  );
}).pipe(Effect.provide(GitHubIssuesCliLive), Layer.unwrap);

export type { TrackerKind };
