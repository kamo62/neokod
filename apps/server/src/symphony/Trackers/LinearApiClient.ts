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
  trackerRateLimitedError,
  trackerRequestError,
  trackerResponseError,
} from "./Errors.ts";

/**
 * Thin Linear GraphQL client for project-scoped issue polling (SPEC 11.2,
 * plan 5.0.1, mirrored from `.repos/symphony/elixir/.../linear/client.ex`).
 *
 * Linear has no CLI; the adapter talks to the Linear GraphQL API
 * (`POST /graphql`) with the API key as the `Authorization` header (no Bearer
 * prefix, per Linear's documented convention). Polling is cursor-paginated at
 * 50 issues per page; ID refresh batches at 50 per request and returns records
 * in the requested order.
 */

const DEFAULT_TIMEOUT_MS = 30_000;
export const LINEAR_PAGE_SIZE = 50;

export interface LinearRawIssue {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly description: string | null;
  readonly priority: number | null;
  readonly state: string;
  readonly branchName: string | null;
  readonly url: string | null;
  readonly assigneeId: string | null;
  readonly labels: ReadonlyArray<string>;
  readonly blockedBy: ReadonlyArray<{
    readonly id: string;
    readonly identifier: string;
    readonly state: string | null;
  }>;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

const LinearIssueNodeSchema = Schema.Struct({
  id: Schema.String,
  identifier: Schema.String,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  priority: Schema.NullOr(Schema.Int),
  state: Schema.Struct({ name: Schema.String }),
  branchName: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
  assignee: Schema.NullOr(Schema.Struct({ id: Schema.String })),
  labels: Schema.Struct({
    nodes: Schema.Array(Schema.Struct({ name: Schema.String })),
  }),
  inverseRelations: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        type: Schema.String,
        issue: Schema.Struct({
          id: Schema.String,
          identifier: Schema.String,
          state: Schema.Struct({ name: Schema.String }),
        }),
      }),
    ),
  }),
  createdAt: Schema.NullOr(Schema.String),
  updatedAt: Schema.NullOr(Schema.String),
});

const LinearPageInfoSchema = Schema.Struct({
  hasNextPage: Schema.Boolean,
  endCursor: Schema.NullOr(Schema.String),
});

const LinearIssuesResponseSchema = Schema.Struct({
  data: Schema.Struct({
    issues: Schema.Struct({
      nodes: Schema.Array(LinearIssueNodeSchema),
      pageInfo: LinearPageInfoSchema,
    }),
  }),
});

const LinearIssuesByIdsResponseSchema = Schema.Struct({
  data: Schema.Struct({
    issues: Schema.Struct({
      nodes: Schema.Array(LinearIssueNodeSchema),
    }),
  }),
});

const LinearViewerResponseSchema = Schema.Struct({
  data: Schema.Struct({
    viewer: Schema.Struct({ id: Schema.String }),
  }),
});

export interface LinearApiClientShape {
  readonly pollIssues: (input: {
    readonly projectSlug: string;
    readonly stateNames: ReadonlyArray<string>;
    readonly after?: string;
  }) => Effect.Effect<
    {
      readonly issues: ReadonlyArray<LinearRawIssue>;
      readonly hasNextPage: boolean;
      readonly endCursor: string | null;
    },
    TrackerAdapterError
  >;
  readonly fetchIssuesByIds: (
    ids: ReadonlyArray<string>,
    projectSlug: string,
  ) => Effect.Effect<ReadonlyArray<LinearRawIssue>, TrackerAdapterError>;
  readonly fetchViewerId: () => Effect.Effect<string | null, TrackerAdapterError>;
  readonly validateCredentials: () => Effect.Effect<void, TrackerAdapterError>;
}

export interface LinearCredentials {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly projectSlug: string;
}

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : "unknown error";

const decodePage = Schema.decodeUnknownEffect(LinearIssuesResponseSchema);
const decodeByIds = Schema.decodeUnknownEffect(LinearIssuesByIdsResponseSchema);
const decodeViewer = Schema.decodeUnknownEffect(LinearViewerResponseSchema);

const normalizeRawIssue = (
  node: Schema.Schema.Type<typeof LinearIssueNodeSchema>,
): LinearRawIssue => ({
  id: node.id,
  identifier: node.identifier,
  title: node.title,
  description: node.description,
  priority: node.priority,
  state: node.state.name,
  branchName: node.branchName,
  url: node.url,
  assigneeId: node.assignee === null ? null : node.assignee.id,
  labels: node.labels.nodes.map((label) => label.name),
  blockedBy: node.inverseRelations.nodes
    .filter((relation) => relation.type.trim().toLowerCase() === "blocks")
    .map((relation) => ({
      id: relation.issue.id,
      identifier: relation.issue.identifier,
      state: relation.issue.state.name,
    })),
  createdAt: node.createdAt,
  updatedAt: node.updatedAt,
});

export const makeLinearApiClient = (options: {
  readonly credentials: LinearCredentials;
  readonly httpClient: HttpClient.HttpClient;
}): LinearApiClientShape => {
  const { credentials, httpClient } = options;

  const performRequest = (
    query: string,
    variables: Readonly<Record<string, unknown>>,
  ): Effect.Effect<unknown, TrackerAdapterError> => {
    const request = HttpClientRequest.post(credentials.endpoint).pipe(
      HttpClientRequest.setHeader("authorization", credentials.apiKey),
      HttpClientRequest.setHeader("accept", "application/json"),
      HttpClientRequest.setHeader("content-type", "application/json"),
      HttpClientRequest.setBody(HttpBody.jsonUnsafe({ query, variables })),
    );
    return httpClient.execute(request).pipe(
      Effect.timeoutOption(Duration.millis(DEFAULT_TIMEOUT_MS)),
      Effect.flatMap((response) => {
        if (Option.isNone(response)) {
          return Effect.fail(trackerRequestError(`Linear GraphQL request timed out`));
        }
        const httpResponse = response.value;
        const status = httpResponse.status;
        if (status === 401 || status === 403) {
          return Effect.fail(
            trackerResponseError(`Linear GraphQL request rejected credentials (${status})`),
          );
        }
        if (status === 429) {
          const retryAfterHeader = Headers.get(httpResponse.headers, "retry-after");
          const retryAfter = Option.isSome(retryAfterHeader) ? retryAfterHeader.value : undefined;
          const retryAfterMs =
            retryAfter === undefined || Number.isNaN(Number(retryAfter))
              ? 60_000
              : Number(retryAfter) * 1000;
          return Effect.fail(
            trackerRateLimitedError(`Linear GraphQL request rate limited`, retryAfterMs),
          );
        }
        if (status < 200 || status >= 300) {
          return Effect.fail(trackerResponseError(`Linear GraphQL request returned ${status}`));
        }
        return Effect.succeed(httpResponse);
      }),
      Effect.flatMap((response) =>
        response.json.pipe(
          Effect.mapError((cause) =>
            trackerRequestError(`Linear GraphQL request failed to read body: ${messageOf(cause)}`),
          ),
        ),
      ),
      Effect.mapError((cause) =>
        cause instanceof TrackerAdapterError
          ? cause
          : trackerRequestError(`Linear GraphQL request: ${messageOf(cause)}`),
      ),
    );
  };

  const pollIssues: LinearApiClientShape["pollIssues"] = (input) =>
    performRequest(
      `query SymphonyLinearPoll($projectSlug: String!, $stateNames: [String!]!, $first: Int!, $relationFirst: Int!, $after: String) {
  issues(filter: {project: {slugId: {eq: $projectSlug}}, state: {name: {in: $stateNames}}}, first: $first, after: $after) {
    nodes { id identifier title description priority state { name } branchName url assignee { id } labels { nodes { name } } inverseRelations(first: $relationFirst) { nodes { type issue { id identifier state { name } } } } createdAt updatedAt }
    pageInfo { hasNextPage endCursor }
  }
}`,
      {
        projectSlug: input.projectSlug,
        stateNames: [...input.stateNames],
        first: LINEAR_PAGE_SIZE,
        relationFirst: LINEAR_PAGE_SIZE,
        ...(input.after === undefined ? {} : { after: input.after }),
      },
    ).pipe(
      Effect.flatMap((payload) =>
        decodePage(payload).pipe(
          Effect.mapError(() => trackerResponseError("Linear poll returned an invalid payload")),
        ),
      ),
      Effect.map((decoded) => ({
        issues: decoded.data.issues.nodes.map(normalizeRawIssue),
        hasNextPage: decoded.data.issues.pageInfo.hasNextPage,
        endCursor: decoded.data.issues.pageInfo.endCursor,
      })),
    );

  const fetchIssuesByIds: LinearApiClientShape["fetchIssuesByIds"] = (ids, projectSlug) =>
    Effect.gen(function* () {
      const uniqueIds = [...new Set(ids)];
      const issues: LinearRawIssue[] = [];
      for (let index = 0; index < uniqueIds.length; index += LINEAR_PAGE_SIZE) {
        const batch = uniqueIds.slice(index, index + LINEAR_PAGE_SIZE);
        const decoded = yield* performRequest(
          `query SymphonyLinearIssuesById($ids: [ID!]!, $projectSlug: String!, $first: Int!, $relationFirst: Int!) {
  issues(filter: {id: {in: $ids}, project: {slugId: {eq: $projectSlug}}}, first: $first) {
    nodes { id identifier title description priority state { name } branchName url assignee { id } labels { nodes { name } } inverseRelations(first: $relationFirst) { nodes { type issue { id identifier state { name } } } } createdAt updatedAt }
  }
}`,
          {
            ids: batch,
            projectSlug,
            first: batch.length,
            relationFirst: LINEAR_PAGE_SIZE,
          },
        ).pipe(
          Effect.flatMap((payload) =>
            decodeByIds(payload).pipe(
              Effect.mapError(() =>
                trackerResponseError("Linear ID refresh returned an invalid payload"),
              ),
            ),
          ),
        );
        issues.push(...decoded.data.issues.nodes.map(normalizeRawIssue));
      }
      const orderIndex = new Map(uniqueIds.map((id, index) => [id, index] as const));
      const fallbackIndex = uniqueIds.length;
      return issues.toSorted(
        (left, right) =>
          (orderIndex.get(left.id) ?? fallbackIndex) - (orderIndex.get(right.id) ?? fallbackIndex),
      );
    });

  const fetchViewerId: LinearApiClientShape["fetchViewerId"] = () =>
    performRequest(
      `query SymphonyLinearViewer {
  viewer { id }
}`,
      {},
    ).pipe(
      Effect.flatMap((payload) =>
        decodeViewer(payload).pipe(
          Effect.mapError(() =>
            trackerResponseError("Linear viewer query returned an invalid payload"),
          ),
        ),
      ),
      Effect.map((decoded) => decoded.data.viewer.id),
    );

  const validateCredentials: LinearApiClientShape["validateCredentials"] = () =>
    fetchViewerId().pipe(Effect.asVoid);

  return { pollIssues, fetchIssuesByIds, fetchViewerId, validateCredentials };
};
