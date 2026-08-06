import * as Effect from "effect/Effect";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as Schema from "effect/Schema";

import { trackerNotFoundError, trackerRateLimitedError, trackerResponseError } from "./Errors.ts";
import type { TrackerAdapterError } from "./Errors.ts";

/**
 * GitHub Projects v2 API client (plan 6, WS-Q).
 *
 * Thin GraphQL wrapper over the GitHub Projects v2 API. Projects v2 live at
 * the owner (org or user) level, not per-repository; the adapter is scoped by
 * `owner` + project `number`. Polling reads project items with their issue
 * content and the single-select status field value (the item's state).
 *
 * API reference: https://docs.github.com/graphql/reference/objects#projectv2
 */

export interface GitHubProjectsCredentials {
  readonly owner: string;
  readonly projectNumber: number;
  readonly token: string;
  readonly apiUrl?: string;
}

const DEFAULT_API_URL = "https://api.github.com/graphql";

export const GitHubProjectItemSchema = Schema.Struct({
  id: Schema.String,
  statusField: Schema.optional(
    Schema.Struct({
      __typename: Schema.optional(Schema.String),
      name: Schema.optional(Schema.String),
    }),
  ),
  fieldValues: Schema.optional(
    Schema.Struct({
      nodes: Schema.optional(
        Schema.Array(
          Schema.Union([
            Schema.Struct({
              __typename: Schema.Literal("ProjectV2ItemFieldSingleSelectValue"),
              name: Schema.optional(Schema.String),
            }),
            Schema.Struct({
              __typename: Schema.Unknown,
            }),
          ]),
        ),
      ),
    }),
  ),
  content: Schema.optional(
    Schema.Union([
      Schema.Struct({
        __typename: Schema.Literal("Issue"),
        id: Schema.String,
        number: Schema.Number,
        title: Schema.String,
        body: Schema.optional(Schema.String),
        url: Schema.String,
        state: Schema.String,
        labels: Schema.optional(
          Schema.Struct({
            nodes: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String }))),
          }),
        ),
        assignees: Schema.optional(
          Schema.Struct({
            nodes: Schema.optional(Schema.Array(Schema.Struct({ login: Schema.String }))),
          }),
        ),
        createdAt: Schema.optional(Schema.String),
        updatedAt: Schema.optional(Schema.String),
      }),
      Schema.Struct({
        __typename: Schema.Unknown,
      }),
    ]),
  ),
});

export type GitHubProjectItem = Schema.Schema.Type<typeof GitHubProjectItemSchema>;

export interface GitHubProjectsApiClientShape {
  readonly listProjectItems: () => Effect.Effect<
    ReadonlyArray<GitHubProjectItem>,
    TrackerAdapterError
  >;

  readonly fetchItem: (itemId: string) => Effect.Effect<GitHubProjectItem, TrackerAdapterError>;

  readonly validateCredentials: () => Effect.Effect<void, TrackerAdapterError>;
}

const ITEM_FRAGMENT = `
  fragment ItemFields on ProjectV2Item {
    id
    statusField: fieldValueByName(name: "Status") {
      __typename
      ... on ProjectV2ItemFieldSingleSelectValue {
        name
      }
    }
    fieldValues(first: 100) {
      nodes {
        __typename
        ... on ProjectV2ItemFieldSingleSelectValue {
          name
        }
      }
    }
    content {
      __typename
      ... on Issue {
        id
        number
        title
        body
        url
        state
        labels(first: 100) { nodes { name } }
        assignees(first: 100) { nodes { login } }
        createdAt
        updatedAt
      }
    }
  }
`;

export const makeGitHubProjectsApiClient = (input: {
  readonly credentials: GitHubProjectsCredentials;
  readonly httpClient: HttpClient.HttpClient;
}): GitHubProjectsApiClientShape => {
  const { credentials, httpClient } = input;
  const apiUrl = credentials.apiUrl ?? DEFAULT_API_URL;

  const executeGraphql = <A>(
    operation: string,
    query: string,
    variables: Record<string, unknown>,
    onStatus: (json: unknown) => Effect.Effect<A, TrackerAdapterError>,
  ): Effect.Effect<A, TrackerAdapterError> =>
    Effect.gen(function* () {
      const request = HttpClientRequest.setBody(
        HttpClientRequest.post(apiUrl),
        HttpBody.jsonUnsafe({ query, variables }),
      );
      const response = yield* httpClient
        .execute(HttpClientRequest.bearerToken(request, credentials.token))
        .pipe(
          Effect.mapError((cause) =>
            trackerResponseError(cause instanceof Error ? cause.message : String(cause)),
          ),
        );
      if (response.status === 401 || response.status === 403) {
        return yield* Effect.fail(
          trackerResponseError(`GitHub Projects rejected the token (HTTP ${response.status})`),
        );
      }
      if (response.status === 429) {
        return yield* Effect.fail(trackerRateLimitedError(operation, 60_000));
      }
      if (response.status >= 400) {
        const body = yield* response.text.pipe(Effect.catch(() => Effect.succeed("")));
        return yield* Effect.fail(
          trackerResponseError(`HTTP ${response.status}: ${body.slice(0, 300)}`),
        );
      }
      const json = yield* response.json.pipe(
        Effect.mapError((cause) =>
          trackerResponseError(cause instanceof Error ? cause.message : String(cause)),
        ),
      );
      const withErrors = Schema.Struct({ errors: Schema.optional(Schema.Array(Schema.Unknown)) });
      const decoded = yield* Schema.decodeUnknownEffect(withErrors)(json).pipe(
        Effect.mapError((cause) =>
          trackerResponseError(cause instanceof Error ? cause.message : String(cause)),
        ),
      );
      if ((decoded.errors?.length ?? 0) > 0) {
        return yield* Effect.fail(
          trackerResponseError(`GitHub GraphQL error: ${JSON.stringify(decoded.errors?.[0])}`),
        );
      }
      return yield* onStatus(json);
    });

  const projectQuery = () => `
    query($cursor: String) {
      owner: repositoryOwner(login: "${credentials.owner}") {
        projectV2(number: ${credentials.projectNumber}) {
          items(first: 100, after: $cursor) {
            nodes { ...ItemFields }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }
    ${ITEM_FRAGMENT}
  `;

  const itemQuery = (itemId: string) => `
    query {
      node(id: "${itemId}") {
        ...ItemFields
      }
    }
    ${ITEM_FRAGMENT}
  `;

  const decodePage = (
    json: unknown,
    operation: string,
  ): Effect.Effect<
    {
      readonly items: ReadonlyArray<GitHubProjectItem>;
      readonly hasNextPage: boolean;
      readonly endCursor: string | null;
    },
    TrackerAdapterError
  > => {
    const shape = Schema.Struct({
      data: Schema.Struct({
        owner: Schema.Struct({
          projectV2: Schema.NullOr(
            Schema.Struct({
              items: Schema.Struct({
                nodes: Schema.optional(Schema.Array(GitHubProjectItemSchema)),
                pageInfo: Schema.Struct({
                  hasNextPage: Schema.Boolean,
                  endCursor: Schema.NullOr(Schema.String),
                }),
              }),
            }),
          ),
        }),
      }),
    });
    return Schema.decodeUnknownEffect(shape)(json).pipe(
      Effect.mapError((cause) =>
        trackerResponseError(cause instanceof Error ? cause.message : String(cause)),
      ),
      Effect.flatMap((decoded) => {
        const project = decoded.data.owner.projectV2;
        if (project === null) {
          return Effect.fail(trackerNotFoundError(operation));
        }
        return Effect.succeed({
          items: project.items.nodes ?? [],
          hasNextPage: project.items.pageInfo.hasNextPage,
          endCursor: project.items.pageInfo.endCursor ?? null,
        });
      }),
    );
  };

  const decodeNodeItem = (
    json: unknown,
    _operation: string,
  ): Effect.Effect<GitHubProjectItem | null, TrackerAdapterError> => {
    const shape = Schema.Struct({
      data: Schema.Struct({
        node: Schema.NullOr(GitHubProjectItemSchema),
      }),
    });
    return Schema.decodeUnknownEffect(shape)(json).pipe(
      Effect.mapError((cause) =>
        trackerResponseError(cause instanceof Error ? cause.message : String(cause)),
      ),
      Effect.map((decoded) => decoded.data.node),
    );
  };

  const listProjectItems: GitHubProjectsApiClientShape["listProjectItems"] = () =>
    Effect.gen(function* () {
      const all: GitHubProjectItem[] = [];
      let cursor: string | null = null;
      for (;;) {
        const page: {
          readonly items: ReadonlyArray<GitHubProjectItem>;
          readonly hasNextPage: boolean;
          readonly endCursor: string | null;
        } = yield* executeGraphql(
          "GitHubProjects.listProjectItems",
          projectQuery(),
          { cursor },
          (json) => decodePage(json, "GitHubProjects.listProjectItems"),
        );
        all.push(...page.items);
        if (!page.hasNextPage || page.endCursor === null) {
          break;
        }
        cursor = page.endCursor;
      }
      return all;
    });

  const fetchItem: GitHubProjectsApiClientShape["fetchItem"] = (itemId) =>
    Effect.gen(function* () {
      // `items(itemId:)` is not a valid argument for the ProjectV2Item
      // connection (REVIEW P1 #12); fetch by node id instead.
      const item = yield* executeGraphql(
        "GitHubProjects.fetchItem",
        itemQuery(itemId),
        {},
        (json) => decodeNodeItem(json, "GitHubProjects.fetchItem"),
      );
      if (item === null) {
        return yield* Effect.fail(trackerNotFoundError(`GitHub project item ${itemId} not found`));
      }
      return item;
    });

  const validateCredentials: GitHubProjectsApiClientShape["validateCredentials"] = () =>
    Effect.gen(function* () {
      const body = yield* executeGraphql(
        "GitHubProjects.validateCredentials",
        `
          query {
            viewer { login }
          }
        `,
        {},
        (json) => Effect.succeed(json),
      );
      void body;
    });

  return { listProjectItems, fetchItem, validateCredentials };
};
