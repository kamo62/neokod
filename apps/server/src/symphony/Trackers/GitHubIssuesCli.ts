import type { VcsError } from "@neokod/contracts";
import * as Context from "effect/Context";
import { Schema } from "effect";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as VcsProcess from "../../vcs/VcsProcess.ts";
import {
  TrackerAdapterError,
  trackerNotFoundError,
  trackerRequestError,
  trackerResponseError,
  trackerStatusError,
} from "./Errors.ts";

/**
 * GitHub Issues CLI wrapper over `gh issue`.
 *
 * Runs in the host process with `gh`'s own credential store (no token exposed
 * to the coding-agent child). If the workflow config declares a `$VAR` token,
 * the adapter injects it only into this process's environment and declares the
 * env name via `secretEnvironmentNames()`.
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 100;
const isTrackerAdapterError = Schema.is(TrackerAdapterError);

export interface GitHubIssueRaw {
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly state: string;
  readonly labels: ReadonlyArray<{ readonly name: string }>;
  readonly assignees: ReadonlyArray<{ readonly login: string }>;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly url: string | null;
}

const GitHubIssueRawSchema = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
  state: Schema.String,
  labels: Schema.Array(Schema.Struct({ name: Schema.String })),
  assignees: Schema.Array(Schema.Struct({ login: Schema.String })),
  createdAt: Schema.NullOr(Schema.String),
  updatedAt: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
});

const decodeGitHubIssueJson = Schema.decodeEffect(Schema.fromJsonString(GitHubIssueRawSchema));
const decodeGitHubIssueListJson = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Array(GitHubIssueRawSchema)),
);

export class GitHubIssuesCli extends Context.Service<
  GitHubIssuesCli,
  {
    readonly execute: (input: {
      readonly cwd: string;
      readonly args: ReadonlyArray<string>;
      readonly env?: NodeJS.ProcessEnv;
      readonly timeoutMs?: number;
    }) => Effect.Effect<VcsProcess.VcsProcessOutput, TrackerAdapterError>;

    readonly listOpenIssues: (input: {
      readonly cwd: string;
      readonly repo: string;
      readonly limit?: number;
      readonly env?: NodeJS.ProcessEnv;
    }) => Effect.Effect<ReadonlyArray<GitHubIssueRaw>, TrackerAdapterError>;

    readonly getIssue: (input: {
      readonly cwd: string;
      readonly repo: string;
      readonly number: string;
      readonly env?: NodeJS.ProcessEnv;
    }) => Effect.Effect<GitHubIssueRaw, TrackerAdapterError>;
  }
>()("neokod/symphony/Trackers/GitHubIssuesCli") {}

const toTrackerError =
  (operation: string) =>
  (cause: unknown): TrackerAdapterError => {
    if (isTrackerAdapterError(cause)) {
      return cause;
    }
    return trackerRequestError(`GitHub CLI failed in ${operation}: ${messageOf(cause)}`);
  };

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : "unknown error";

const mapExitFailure =
  (operation: string, _cwd: string) =>
  (error: VcsError): TrackerAdapterError => {
    if (error._tag === "VcsProcessExitError") {
      if (error.failureKind === "authentication") {
        return trackerStatusError(
          `GitHub authentication failed in ${operation}. Run \`gh auth login\`.`,
          false,
        );
      }
      if (error.failureKind === "not-found") {
        return trackerNotFoundError(`GitHub issue not found in ${operation}`);
      }
      const detail = error.detail ?? `exit ${error.exitCode}`;
      return trackerStatusError(`GitHub CLI failed in ${operation}: ${detail}`);
    }
    if (error._tag === "VcsProcessTimeoutError") {
      return trackerRequestError(`GitHub CLI timed out in ${operation}`);
    }
    if (error._tag === "VcsProcessSpawnError") {
      return trackerRequestError(`GitHub CLI could not be spawned in ${operation}`);
    }
    return trackerRequestError(`GitHub CLI process error in ${operation}`);
  };

export const make = Effect.gen(function* () {
  const process = yield* VcsProcess.VcsProcess;

  const execute: GitHubIssuesCli["Service"]["execute"] = (input) =>
    process
      .run({
        operation: `GitHubIssuesCli.${input.args[0] ?? "execute"}`,
        command: "gh",
        args: input.args,
        cwd: input.cwd,
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ...(input.env === undefined ? {} : { env: input.env }),
      })
      .pipe(Effect.mapError(mapExitFailure("execute", input.cwd)));

  const listOpenIssues: GitHubIssuesCli["Service"]["listOpenIssues"] = (input) =>
    Effect.gen(function* () {
      const pageCount = Math.max(1, Math.ceil((input.limit ?? PAGE_SIZE) / PAGE_SIZE));
      const issues: GitHubIssueRaw[] = [];
      for (let page = 1; page <= pageCount; page += 1) {
        const result = yield* execute({
          cwd: input.cwd,
          ...(input.env === undefined ? {} : { env: input.env }),
          args: [
            "issue",
            "list",
            "--repo",
            input.repo,
            "--state",
            "open",
            "--limit",
            String(PAGE_SIZE),
            "--page",
            String(page),
            "--json",
            "number,title,body,state,labels,assignees,createdAt,updatedAt,url",
          ],
        }).pipe(Effect.mapError(toTrackerError("listOpenIssues")));
        const raw = result.stdout.trim();
        if (raw.length === 0) {
          break;
        }
        const decoded = yield* decodeGitHubIssueListJson(raw).pipe(
          Effect.mapError(() =>
            trackerResponseError("GitHub CLI returned invalid issue list JSON"),
          ),
        );
        issues.push(...decoded);
        if (decoded.length < PAGE_SIZE) {
          break;
        }
      }
      return issues;
    });

  const getIssue: GitHubIssuesCli["Service"]["getIssue"] = (input) =>
    execute({
      cwd: input.cwd,
      ...(input.env === undefined ? {} : { env: input.env }),
      args: [
        "issue",
        "view",
        input.number,
        "--repo",
        input.repo,
        "--json",
        "number,title,body,state,labels,assignees,createdAt,updatedAt,url",
      ],
    }).pipe(
      Effect.map((result) => result.stdout.trim()),
      Effect.flatMap((raw) =>
        decodeGitHubIssueJson(raw).pipe(
          Effect.mapError(() => trackerResponseError("GitHub CLI returned invalid issue JSON")),
        ),
      ),
      Effect.mapError(toTrackerError("getIssue")),
    );

  return GitHubIssuesCli.of({ execute, listOpenIssues, getIssue });
});

export const GitHubIssuesCliLive = Layer.effect(GitHubIssuesCli, make);
