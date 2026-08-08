import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Headers from "effect/unstable/http/Headers";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as Schema from "effect/Schema";

import {
  TrackerAdapterError,
  trackerNotFoundError,
  trackerRateLimitedError,
  trackerRequestError,
  trackerResponseError,
} from "./Errors.ts";

/**
 * Thin GitLab REST client for project-scoped issue polling (SPEC 11.2,
 * plan 5.2, mirrored from `.repos/symphony/elixir/.../gitlab/client.ex`).
 *
 * GitLab has no CLI; the adapter talks to the GitLab API v4 directly with the
 * `PRIVATE-TOKEN` header over the shared `HttpClient`. Credentials are
 * resolved from `tracker.provider` (`api_url`, `project_path`, `api_key`) or
 * the `GITLAB_PROJECT_PATH` / `GITLAB_PAT` env fallbacks, and env names are
 * declared via `secretEnvironmentNames()` so the coding-agent child never
 * inherits them.
 */

const DEFAULT_API_URL = "https://gitlab.com/api/v4";
const DEFAULT_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 100;
const isTrackerAdapterError = Schema.is(TrackerAdapterError);

export interface GitLabCredentials {
  readonly apiUrl: string;
  readonly projectPath: string;
  readonly apiKey: string;
}

const GitLabRawIssueSchema = Schema.Struct({
  id: Schema.Number,
  iid: Schema.Number,
  project_id: Schema.Number,
  title: Schema.String,
  state: Schema.String,
  description: Schema.NullOr(Schema.String),
  web_url: Schema.NullOr(Schema.String),
  labels: Schema.NullOr(Schema.Array(Schema.String)),
  assignees: Schema.NullOr(
    Schema.Array(
      Schema.Struct({
        id: Schema.optional(Schema.Number),
        username: Schema.optional(Schema.String),
      }),
    ),
  ),
  created_at: Schema.NullOr(Schema.String),
  updated_at: Schema.NullOr(Schema.String),
});

export type GitLabRawIssue = typeof GitLabRawIssueSchema.Type;

export interface GitLabApiClientShape {
  readonly pollIssues: (input: {
    readonly projectPath: string;
    readonly states: ReadonlyArray<string>;
    readonly page?: number;
  }) => Effect.Effect<
    { readonly issues: ReadonlyArray<GitLabRawIssue>; readonly hasMore: boolean },
    TrackerAdapterError
  >;
  readonly fetchIssuesByIds: (
    ids: ReadonlyArray<string>,
    projectPath: string,
  ) => Effect.Effect<ReadonlyArray<GitLabRawIssue>, TrackerAdapterError>;
  readonly validateCredentials: () => Effect.Effect<void, TrackerAdapterError>;
}

export class GitLabApiClient extends Context.Service<GitLabApiClient, GitLabApiClientShape>()(
  "neokod/symphony/Trackers/GitLabApiClient",
) {}

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : "unknown error";

const normalizeState = (state: string): string => state.trim().toLowerCase();

const gitlabStateQuery = (states: ReadonlyArray<string>): string | null => {
  const hasOpened = states.some((state) => normalizeState(state) === "opened");
  const hasClosed = states.some((state) => normalizeState(state) === "closed");
  if (hasOpened && hasClosed) {
    return "all";
  }
  if (hasOpened) {
    return "opened";
  }
  if (hasClosed) {
    return "closed";
  }
  return null;
};

export interface GitLabApiClientOptions {
  readonly credentials: GitLabCredentials;
  readonly httpClient: HttpClient.HttpClient;
}

const decodeRawIssue = Schema.decodeUnknownEffect(GitLabRawIssueSchema);

/**
 * Decode a poll page, dropping malformed records (SPEC 11.1: a malformed
 * record was never safe to dispatch). The caller logs the omission count.
 */
const decodeRawIssues = (
  payload: ReadonlyArray<unknown>,
): Effect.Effect<
  { readonly issues: ReadonlyArray<GitLabRawIssue>; readonly dropped: number },
  TrackerAdapterError
> =>
  Effect.all(
    payload.map((entry) =>
      decodeRawIssue(entry).pipe(
        Effect.mapError(() => trackerResponseError("GitLab API returned a malformed issue record")),
        Effect.result,
      ),
    ),
  ).pipe(
    Effect.map((results) => {
      const issues: GitLabRawIssue[] = [];
      let dropped = 0;
      for (const result of results) {
        if (result._tag === "Success") {
          issues.push(result.success);
        } else {
          dropped += 1;
        }
      }
      return { issues, dropped };
    }),
  );

export const makeGitLabApiClient = (options: GitLabApiClientOptions): GitLabApiClientShape => {
  const { credentials, httpClient } = options;

  const performRequest = (
    method: "GET" | "POST",
    path: string,
    query: Readonly<Record<string, string | number>>,
    allowNotFound: boolean,
  ): Effect.Effect<unknown, TrackerAdapterError> => {
    let request = HttpClientRequest.make(method)(`${credentials.apiUrl}${path}`).pipe(
      HttpClientRequest.setHeader("PRIVATE-TOKEN", credentials.apiKey),
      HttpClientRequest.setHeader("accept", "application/json"),
    );
    for (const [key, value] of Object.entries(query)) {
      request = HttpClientRequest.setUrlParam(request, key, String(value));
    }
    return httpClient.execute(request).pipe(
      Effect.timeoutOption(Duration.millis(DEFAULT_TIMEOUT_MS)),
      Effect.flatMap((response) => {
        if (Option.isNone(response)) {
          return Effect.fail(trackerRequestError(`GitLab API ${path} timed out`));
        }
        const httpResponse = response.value;
        const status = httpResponse.status;
        if (status === 401 || status === 403) {
          return Effect.fail(
            trackerResponseError(`GitLab API ${path} rejected credentials (${status})`),
          );
        }
        if (status === 404 && allowNotFound) {
          return Effect.succeed(null);
        }
        if (status === 404) {
          return Effect.fail(trackerNotFoundError(`GitLab API ${path} not found`));
        }
        if (status === 429) {
          const retryAfterHeader = Headers.get(httpResponse.headers, "retry-after");
          const retryAfter = Option.isSome(retryAfterHeader) ? retryAfterHeader.value : undefined;
          const retryAfterMs =
            retryAfter === undefined || Number.isNaN(Number(retryAfter))
              ? 60_000
              : Number(retryAfter) * 1000;
          return Effect.fail(
            trackerRateLimitedError(`GitLab API ${path} rate limited`, retryAfterMs),
          );
        }
        if (status < 200 || status >= 300) {
          return Effect.fail(trackerResponseError(`GitLab API ${path} returned ${status}`));
        }
        return Effect.succeed(httpResponse);
      }),
      Effect.flatMap((response) => {
        if (response === null) {
          return Effect.succeed(null);
        }
        return response.json.pipe(
          Effect.mapError((cause) =>
            trackerRequestError(`GitLab API ${path} failed to read body: ${messageOf(cause)}`),
          ),
        );
      }),
      Effect.mapError((cause) =>
        isTrackerAdapterError(cause)
          ? cause
          : trackerRequestError(`GitLab API ${path}: ${messageOf(cause)}`),
      ),
    );
  };

  const pollIssues: GitLabApiClientShape["pollIssues"] = (input) => {
    const stateQuery = gitlabStateQuery(input.states);
    if (stateQuery === null) {
      return Effect.succeed({ issues: [], hasMore: false });
    }
    return performRequest(
      "GET",
      `/projects/${encodeURIComponent(input.projectPath)}/issues`,
      {
        state: stateQuery,
        per_page: PAGE_SIZE,
        page: input.page ?? 1,
        order_by: "created_at",
        sort: "asc",
      },
      false,
    ).pipe(
      Effect.flatMap((payload) => {
        if (!Array.isArray(payload)) {
          return Effect.fail(trackerResponseError("GitLab API poll returned a non-array payload"));
        }
        return decodeRawIssues(payload).pipe(
          Effect.map(({ issues }) => ({
            issues,
            hasMore: payload.length >= PAGE_SIZE,
          })),
        );
      }),
    );
  };

  const fetchIssuesByIds: GitLabApiClientShape["fetchIssuesByIds"] = (ids, projectPath) => {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) {
      return Effect.succeed([]);
    }
    const path = `/projects/${encodeURIComponent(projectPath)}/issues`;
    return Effect.all(
      uniqueIds.map((id) =>
        performRequest("GET", `${path}/${encodeURIComponent(id)}`, {}, true).pipe(
          Effect.flatMap((payload) => {
            if (payload === null) {
              return Effect.succeed(null);
            }
            return decodeRawIssue(payload).pipe(
              Effect.mapError(() =>
                trackerResponseError(`GitLab API issue ${id} returned a malformed record`),
              ),
            );
          }),
        ),
      ),
    ).pipe(Effect.map((found) => found.filter((issue): issue is GitLabRawIssue => issue !== null)));
  };

  const validateCredentials: GitLabApiClientShape["validateCredentials"] = () =>
    pollIssues({ projectPath: credentials.projectPath, states: ["opened"], page: 1 }).pipe(
      Effect.asVoid,
    );

  return { pollIssues, fetchIssuesByIds, validateCredentials };
};
