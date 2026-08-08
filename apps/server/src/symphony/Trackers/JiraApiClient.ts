import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Headers from "effect/unstable/http/Headers";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as Schema from "effect/Schema";

import {
  TrackerAdapterError,
  trackerNotFoundError,
  trackerRateLimitedError,
  trackerRequestError,
  trackerResponseError,
} from "./Errors.ts";

/**
 * Thin Jira Cloud REST client for project-scoped issue polling (SPEC 11.2,
 * plan 5.2, mirrored from `.repos/symphony/elixir/.../jira/client.ex`).
 *
 * Jira has no CLI; the adapter talks to the Jira Cloud REST API directly with
 * Basic auth (email + API token) over the shared `HttpClient`. Credentials are
 * resolved from `tracker.provider` (`base_url`, `email`, `api_token`) or the
 * `JIRA_BASE_URL` / `JIRA_EMAIL` / `JIRA_API_TOKEN` env fallbacks, and the env
 * name is declared via `secretEnvironmentNames()` so the coding-agent child
 * never inherits it.
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 100;
const isTrackerAdapterError = Schema.is(TrackerAdapterError);

export interface JiraRawIssue {
  readonly id: string;
  readonly key: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

export interface JiraSearchResponse {
  readonly issues: ReadonlyArray<JiraRawIssue>;
  readonly isLast: boolean;
  readonly nextPageToken?: string;
}

const JiraSearchResponseSchema = Schema.Struct({
  issues: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      key: Schema.String,
      fields: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ),
  isLast: Schema.Boolean,
  nextPageToken: Schema.optional(Schema.String),
});

export interface JiraCredentials {
  readonly baseUrl: string;
  readonly email: string;
  readonly apiToken: string;
  readonly projectKey: string;
  readonly terminalStates: ReadonlyArray<string>;
}

export interface JiraApiClientShape {
  readonly searchIssues: (input: {
    readonly jql: string;
    readonly nextPageToken?: string;
  }) => Effect.Effect<JiraSearchResponse, TrackerAdapterError>;
  readonly bulkFetchIssues: (
    ids: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<JiraRawIssue>, TrackerAdapterError>;
  readonly validateCredentials: () => Effect.Effect<void, TrackerAdapterError>;
}

export class JiraApiClient extends Context.Service<JiraApiClient, JiraApiClientShape>()(
  "neokod/symphony/Trackers/JiraApiClient",
) {}

const basicAuthHeader = (email: string, apiToken: string): string =>
  `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`;

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : "unknown error";

export interface JiraApiClientOptions {
  readonly credentials: JiraCredentials;
  readonly httpClient: HttpClient.HttpClient;
}

const JSON_ISSUE_FIELDS = [
  "summary",
  "description",
  "status",
  "labels",
  "assignee",
  "created",
  "updated",
  "project",
  "issuelinks",
];

const decodeJiraSearchResponse = Schema.decodeUnknownEffect(JiraSearchResponseSchema);

export const makeJiraApiClient = (options: JiraApiClientOptions): JiraApiClientShape => {
  const { credentials, httpClient } = options;
  const authHeader = basicAuthHeader(credentials.email, credentials.apiToken);

  const performRequest = (
    method: "POST" | "GET",
    path: string,
    body: unknown,
  ): Effect.Effect<unknown, TrackerAdapterError> => {
    let request = HttpClientRequest.make(method)(`${credentials.baseUrl}${path}`).pipe(
      HttpClientRequest.setHeader("authorization", authHeader),
      HttpClientRequest.setHeader("accept", "application/json"),
      HttpClientRequest.setHeader("content-type", "application/json"),
    );
    if (body !== undefined) {
      request = HttpClientRequest.setBody(request, HttpBody.jsonUnsafe(body));
    }
    return httpClient.execute(request).pipe(
      Effect.timeoutOption(Duration.millis(DEFAULT_TIMEOUT_MS)),
      Effect.flatMap((response) => {
        if (Option.isNone(response)) {
          return Effect.fail(trackerRequestError(`Jira API ${path} timed out`));
        }
        const httpResponse = response.value;
        const status = httpResponse.status;
        if (status === 401 || status === 403) {
          return Effect.fail(
            trackerResponseError(`Jira API ${path} rejected credentials (${status})`),
          );
        }
        if (status === 404) {
          return Effect.fail(trackerNotFoundError(`Jira API ${path} not found`));
        }
        if (status === 429) {
          const retryAfterHeader = Headers.get(httpResponse.headers, "retry-after");
          const retryAfter = Option.isSome(retryAfterHeader) ? retryAfterHeader.value : undefined;
          const retryAfterMs =
            retryAfter === undefined || Number.isNaN(Number(retryAfter))
              ? 60_000
              : Number(retryAfter) * 1000;
          return Effect.fail(
            trackerRateLimitedError(`Jira API ${path} rate limited`, retryAfterMs),
          );
        }
        if (status < 200 || status >= 300) {
          return Effect.fail(trackerResponseError(`Jira API ${path} returned ${status}`));
        }
        return Effect.succeed(httpResponse);
      }),
      Effect.flatMap((response) =>
        response.json.pipe(
          Effect.mapError((cause) =>
            trackerRequestError(`Jira API ${path} failed to read body: ${messageOf(cause)}`),
          ),
        ),
      ),
      Effect.mapError((cause) =>
        isTrackerAdapterError(cause)
          ? cause
          : trackerRequestError(`Jira API ${path}: ${messageOf(cause)}`),
      ),
    );
  };

  const searchIssues: JiraApiClientShape["searchIssues"] = (input) => {
    const body: Record<string, unknown> = {
      jql: input.jql,
      fields: JSON_ISSUE_FIELDS,
      maxResults: PAGE_SIZE,
    };
    if (input.nextPageToken !== undefined) {
      body.nextPageToken = input.nextPageToken;
    }
    return performRequest("POST", "/rest/api/3/search/jql", body).pipe(
      Effect.flatMap((payload) =>
        decodeJiraSearchResponse(payload).pipe(
          Effect.mapError(() =>
            trackerResponseError("Jira API search returned an invalid payload"),
          ),
        ),
      ),
      Effect.map((decoded) => ({
        issues: decoded.issues as ReadonlyArray<JiraRawIssue>,
        isLast: decoded.isLast,
        ...(decoded.nextPageToken !== undefined ? { nextPageToken: decoded.nextPageToken } : {}),
      })),
    );
  };

  const bulkFetchIssues: JiraApiClientShape["bulkFetchIssues"] = (ids) =>
    performRequest("POST", "/rest/api/3/issue/bulkfetch", {
      issueIdsOrKeys: [...new Set(ids)],
      fields: JSON_ISSUE_FIELDS,
    }).pipe(
      Effect.map((payload) => {
        const record = payload as { readonly issues?: ReadonlyArray<JiraRawIssue> };
        return Array.isArray(record.issues) ? record.issues : [];
      }),
    );

  const validateCredentials: JiraApiClientShape["validateCredentials"] = () =>
    searchIssues({
      jql: `project = ${quoteJql(credentials.projectKey)} AND status = open`,
    }).pipe(Effect.asVoid);

  return { searchIssues, bulkFetchIssues, validateCredentials };
};

const quoteJql = (value: string): string =>
  `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
