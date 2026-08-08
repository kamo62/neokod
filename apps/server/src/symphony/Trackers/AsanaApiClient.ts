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
 * Thin Asana REST client for project-scoped task polling (SPEC 11.2,
 * plan 5.0.1, mirrored from `.repos/symphony/elixir/.../asana/client.ex`).
 *
 * Asana has no CLI; the adapter talks to the Asana API 1.0 directly with a
 * Bearer token over the shared `HttpClient`. Credentials are resolved from
 * `tracker.provider` (`endpoint`, `api_key`, `project_gid`) or the `ASANA_PAT`
 * env fallback, and env names are declared via `secretEnvironmentNames()` so
 * the coding-agent child never inherits them.
 */

const DEFAULT_ENDPOINT = "https://app.asana.com/api/1.0";
const DEFAULT_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 100;
const isTrackerAdapterError = Schema.is(TrackerAdapterError);

const TASK_FIELDS = [
  "gid",
  "name",
  "notes",
  "completed",
  "resource_subtype",
  "assignee.gid",
  "tags.name",
  "memberships.project.gid",
  "memberships.section.gid",
  "memberships.section.name",
  "permalink_url",
  "created_at",
  "modified_at",
];

const AsanaTaskSchema = Schema.Struct({
  gid: Schema.String,
  name: Schema.String,
  notes: Schema.NullOr(Schema.String),
  completed: Schema.NullOr(Schema.Boolean),
  resource_subtype: Schema.NullOr(Schema.String),
  permalink_url: Schema.NullOr(Schema.String),
  created_at: Schema.NullOr(Schema.String),
  modified_at: Schema.NullOr(Schema.String),
  assignee: Schema.NullOr(Schema.Struct({ gid: Schema.String })),
  tags: Schema.NullOr(Schema.Array(Schema.Struct({ name: Schema.String }))),
  memberships: Schema.NullOr(
    Schema.Array(
      Schema.Struct({
        project: Schema.NullOr(Schema.Struct({ gid: Schema.String })),
        section: Schema.NullOr(
          Schema.Struct({
            gid: Schema.String,
            name: Schema.String,
          }),
        ),
      }),
    ),
  ),
});

export type AsanaRawTask = typeof AsanaTaskSchema.Type;

const AsanaPageSchema = Schema.Struct({
  data: Schema.Array(AsanaTaskSchema),
  next_page: Schema.NullOr(Schema.Struct({ offset: Schema.String })),
});

export interface AsanaCredentials {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly projectGid: string;
}

export interface AsanaApiClientShape {
  readonly pollTasks: (input: {
    readonly projectGid: string;
    readonly offset?: string;
  }) => Effect.Effect<
    { readonly tasks: ReadonlyArray<AsanaRawTask>; readonly nextOffset: string | null },
    TrackerAdapterError
  >;
  readonly fetchTasksByIds: (
    ids: ReadonlyArray<string>,
    projectGid: string,
  ) => Effect.Effect<ReadonlyArray<AsanaRawTask>, TrackerAdapterError>;
  readonly validateCredentials: () => Effect.Effect<void, TrackerAdapterError>;
}

export class AsanaApiClient extends Context.Service<AsanaApiClient, AsanaApiClientShape>()(
  "neokod/symphony/Trackers/AsanaApiClient",
) {}

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : "unknown error";

export interface AsanaApiClientOptions {
  readonly credentials: AsanaCredentials;
  readonly httpClient: HttpClient.HttpClient;
}

const decodeTaskPage = Schema.decodeUnknownEffect(AsanaPageSchema);
const decodeTaskById = Schema.decodeUnknownEffect(Schema.Struct({ data: AsanaTaskSchema }));

export const makeAsanaApiClient = (options: AsanaApiClientOptions): AsanaApiClientShape => {
  const { credentials, httpClient } = options;

  const performRequest = (
    method: "GET" | "POST",
    path: string,
    query: Readonly<Record<string, string>>,
    allowNotFound: boolean,
  ): Effect.Effect<unknown, TrackerAdapterError> => {
    let request = HttpClientRequest.make(method)(`${credentials.endpoint}${path}`).pipe(
      HttpClientRequest.setHeader("authorization", `Bearer ${credentials.apiKey}`),
      HttpClientRequest.setHeader("accept", "application/json"),
    );
    for (const [key, value] of Object.entries(query)) {
      request = HttpClientRequest.setUrlParam(request, key, value);
    }
    return httpClient.execute(request).pipe(
      Effect.timeoutOption(Duration.millis(DEFAULT_TIMEOUT_MS)),
      Effect.flatMap((response) => {
        if (Option.isNone(response)) {
          return Effect.fail(trackerRequestError(`Asana API ${path} timed out`));
        }
        const httpResponse = response.value;
        const status = httpResponse.status;
        if (status === 401 || status === 403) {
          return Effect.fail(
            trackerResponseError(`Asana API ${path} rejected credentials (${status})`),
          );
        }
        if (status === 404 && allowNotFound) {
          return Effect.succeed(null);
        }
        if (status === 404) {
          return Effect.fail(trackerNotFoundError(`Asana API ${path} not found`));
        }
        if (status === 429) {
          const retryAfterHeader = Headers.get(httpResponse.headers, "retry-after");
          const retryAfter = Option.isSome(retryAfterHeader) ? retryAfterHeader.value : undefined;
          const retryAfterMs =
            retryAfter === undefined || Number.isNaN(Number(retryAfter))
              ? 60_000
              : Number(retryAfter) * 1000;
          return Effect.fail(
            trackerRateLimitedError(`Asana API ${path} rate limited`, retryAfterMs),
          );
        }
        if (status < 200 || status >= 300) {
          return Effect.fail(trackerResponseError(`Asana API ${path} returned ${status}`));
        }
        return Effect.succeed(httpResponse);
      }),
      Effect.flatMap((response) => {
        if (response === null) {
          return Effect.succeed(null);
        }
        return response.json.pipe(
          Effect.mapError((cause) =>
            trackerRequestError(`Asana API ${path} failed to read body: ${messageOf(cause)}`),
          ),
        );
      }),
      Effect.mapError((cause) =>
        isTrackerAdapterError(cause)
          ? cause
          : trackerRequestError(`Asana API ${path}: ${messageOf(cause)}`),
      ),
    );
  };

  const pollTasks: AsanaApiClientShape["pollTasks"] = (input) => {
    const query: Record<string, string> = {
      limit: String(PAGE_SIZE),
      opt_fields: TASK_FIELDS.join(","),
    };
    if (input.offset !== undefined) {
      query.offset = input.offset;
    }
    return performRequest(
      "GET",
      `/projects/${encodeURIComponent(input.projectGid)}/tasks`,
      query,
      false,
    ).pipe(
      Effect.flatMap((payload) =>
        decodeTaskPage(payload).pipe(
          Effect.mapError(() => trackerResponseError("Asana API poll returned an invalid payload")),
        ),
      ),
      Effect.map((decoded) => ({
        tasks: decoded.data as ReadonlyArray<AsanaRawTask>,
        nextOffset: decoded.next_page === null ? null : decoded.next_page.offset,
      })),
    );
  };

  const fetchTasksByIds: AsanaApiClientShape["fetchTasksByIds"] = (ids, projectGid) => {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) {
      return Effect.succeed([]);
    }
    return Effect.all(
      uniqueIds.map((id) =>
        performRequest(
          "GET",
          `/tasks/${encodeURIComponent(id)}`,
          { opt_fields: TASK_FIELDS.join(",") },
          true,
        ).pipe(
          Effect.flatMap((payload) => {
            if (payload === null) {
              return Effect.succeed(null);
            }
            return decodeTaskById(payload).pipe(
              Effect.mapError(() =>
                trackerResponseError(`Asana API task ${id} returned a malformed record`),
              ),
              Effect.map((decoded) => decoded.data),
            );
          }),
        ),
      ),
    ).pipe(Effect.map((found) => found.filter((task): task is AsanaRawTask => task !== null)));
  };

  const validateCredentials: AsanaApiClientShape["validateCredentials"] = () =>
    pollTasks({ projectGid: credentials.projectGid }).pipe(Effect.asVoid);

  return { pollTasks, fetchTasksByIds, validateCredentials };
};
