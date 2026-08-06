import * as Effect from "effect/Effect";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as Schema from "effect/Schema";

import { trackerNotFoundError, trackerResponseError, trackerRateLimitedError } from "./Errors.ts";
import type { TrackerAdapterError } from "./Errors.ts";

/**
 * Azure Boards API client (plan 6/10, WS-Q).
 *
 * Thin wrapper over the Azure DevOps REST API for work items. Authentication
 * is Basic auth with a PAT (`:token` user). Queries run as flat WIQL against
 * the project; the returned work item ids are then batch-fetched with
 * `$expand=Fields` so each poll carries full field data.
 *
 * API reference: https://learn.microsoft.com/rest/api/azure/devops/wit
 */

export interface AzureBoardsCredentials {
  readonly organization: string;
  readonly project: string;
  readonly pat: string;
  readonly apiVersion?: string;
}

const DEFAULT_API_VERSION = "7.1";

const WorkItemReferenceSchema = Schema.Struct({
  id: Schema.Number,
});

const WorkItemReferencesResultSchema = Schema.Struct({
  workItems: Schema.Array(WorkItemReferenceSchema),
});

export const AzureBoardsWorkItemSchema = Schema.Struct({
  id: Schema.Number,
  rev: Schema.Number,
  url: Schema.String,
  fields: Schema.Record(Schema.String, Schema.Unknown),
  _links: Schema.optional(
    Schema.Record(Schema.String, Schema.Struct({ href: Schema.optional(Schema.String) })),
  ),
});

export type AzureBoardsWorkItem = Schema.Schema.Type<typeof AzureBoardsWorkItemSchema>;

const decodeWorkItemReferences = Schema.decodeUnknownEffect(WorkItemReferencesResultSchema);
const WorkItemListResultSchema = Schema.Struct({
  value: Schema.Array(AzureBoardsWorkItemSchema),
});
const decodeWorkItemList = Schema.decodeUnknownEffect(WorkItemListResultSchema);
const decodeWorkItem = Schema.decodeUnknownEffect(AzureBoardsWorkItemSchema);

export interface AzureBoardsApiClientShape {
  /** Run a flat WIQL query and return the referenced work item ids. */
  readonly queryWorkItemIds: (
    states: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<number>, TrackerAdapterError>;

  /** Batch-fetch work item details by id with fields expanded. */
  readonly fetchWorkItemsByIds: (
    ids: ReadonlyArray<number>,
  ) => Effect.Effect<ReadonlyArray<AzureBoardsWorkItem>, TrackerAdapterError>;

  /** Single work item by id. */
  readonly fetchWorkItem: (id: number) => Effect.Effect<AzureBoardsWorkItem, TrackerAdapterError>;

  readonly validateCredentials: () => Effect.Effect<void, TrackerAdapterError>;
}

export const makeAzureBoardsApiClient = (input: {
  readonly credentials: AzureBoardsCredentials;
  readonly httpClient: HttpClient.HttpClient;
}): AzureBoardsApiClientShape => {
  const { credentials, httpClient } = input;
  const apiVersion = credentials.apiVersion ?? DEFAULT_API_VERSION;
  const baseUrl = `https://dev.azure.com/${credentials.organization}/${credentials.project}`;

  const authed = (request: HttpClientRequest.HttpClientRequest) =>
    HttpClientRequest.setHeader(
      HttpClientRequest.basicAuth(request, "", credentials.pat),
      "Accept",
      "application/json",
    );

  const execute = (
    operation: string,
    request: HttpClientRequest.HttpClientRequest,
    onStatus: (
      response: HttpClientResponse.HttpClientResponse,
    ) => Effect.Effect<unknown, TrackerAdapterError>,
  ) =>
    Effect.gen(function* () {
      const response = yield* httpClient
        .execute(authed(request))
        .pipe(
          Effect.mapError((cause) =>
            trackerResponseError(cause instanceof Error ? cause.message : String(cause)),
          ),
        );
      if (response.status === 401 || response.status === 403) {
        return yield* Effect.fail(
          trackerResponseError(`Azure Boards rejected the credential (HTTP ${response.status})`),
        );
      }
      if (response.status === 429) {
        return yield* Effect.fail(trackerRateLimitedError(operation, 60_000));
      }
      if (response.status === 404) {
        return yield* Effect.fail(trackerNotFoundError(operation));
      }
      if (response.status >= 400) {
        const body = yield* response.text.pipe(Effect.catch(() => Effect.succeed("")));
        return yield* Effect.fail(
          trackerResponseError(`HTTP ${response.status}: ${body.slice(0, 300)}`),
        );
      }
      return yield* onStatus(response);
    });

  const queryWorkItemIds: AzureBoardsApiClientShape["queryWorkItemIds"] = (states) =>
    Effect.gen(function* () {
      const stateFilter = states
        .map((state) => `[System.State] = '${state.replaceAll("'", "''")}'`)
        .join(" OR ");
      const query = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${credentials.project.replaceAll("'", "''")}' AND (${stateFilter}) ORDER BY [System.CreatedDate] ASC`;
      const request = HttpClientRequest.setBody(
        HttpClientRequest.post(`${baseUrl}/_apis/wit/wiql?api-version=${apiVersion}`),
        HttpBody.jsonUnsafe({ query }),
      );
      const body = yield* execute("AzureBoards.queryWorkItemIds", request, (response) =>
        Effect.gen(function* () {
          const json = yield* response.json.pipe(
            Effect.mapError((cause) =>
              trackerResponseError(cause instanceof Error ? cause.message : String(cause)),
            ),
          );
          const decoded = yield* decodeWorkItemReferences(json).pipe(
            Effect.mapError((cause) =>
              trackerResponseError(cause instanceof Error ? cause.message : String(cause)),
            ),
          );
          return decoded.workItems.map((item) => item.id);
        }),
      );
      return body as ReadonlyArray<number>;
    });

  const fetchWorkItemsByIds: AzureBoardsApiClientShape["fetchWorkItemsByIds"] = (ids) =>
    Effect.gen(function* () {
      if (ids.length === 0) {
        return [];
      }
      // The Azure DevOps REST endpoint rejects more than 200 ids per request
      // (HTTP 400). Chunk so a real board over 200 active items does not fail
      // the whole poll (REVIEW P1).
      const all: AzureBoardsWorkItem[] = [];
      for (let offset = 0; offset < ids.length; offset += 200) {
        const chunk = ids.slice(offset, offset + 200);
        const url = `${baseUrl}/_apis/wit/workitems?ids=${chunk.join(",")}&fields=System.Id,System.Title,System.Description,System.State,System.Tags,System.AssignedTo,System.CreatedDate,System.ChangedDate,System.WorkItemType&api-version=${apiVersion}`;
        const body = yield* execute(
          "AzureBoards.fetchWorkItemsByIds",
          HttpClientRequest.get(url),
          (response) =>
            Effect.gen(function* () {
              const json = yield* response.json.pipe(
                Effect.mapError((cause) =>
                  trackerResponseError(cause instanceof Error ? cause.message : String(cause)),
                ),
              );
              const decoded = yield* decodeWorkItemList(json).pipe(
                Effect.mapError((cause) =>
                  trackerResponseError(cause instanceof Error ? cause.message : String(cause)),
                ),
              );
              return decoded.value;
            }),
        );
        all.push(...(body as ReadonlyArray<AzureBoardsWorkItem>));
      }
      return all;
    });

  const fetchWorkItem: AzureBoardsApiClientShape["fetchWorkItem"] = (id) =>
    Effect.gen(function* () {
      const url = `${baseUrl}/_apis/wit/workitems/${id}?fields=System.Id,System.Title,System.Description,System.State,System.Tags,System.AssignedTo,System.CreatedDate,System.ChangedDate,System.WorkItemType&api-version=${apiVersion}`;
      const body = yield* execute(
        "AzureBoards.fetchWorkItem",
        HttpClientRequest.get(url),
        (response) =>
          Effect.gen(function* () {
            const json = yield* response.json.pipe(
              Effect.mapError((cause) =>
                trackerResponseError(cause instanceof Error ? cause.message : String(cause)),
              ),
            );
            const decoded = yield* decodeWorkItem(json).pipe(
              Effect.mapError((cause) =>
                trackerResponseError(cause instanceof Error ? cause.message : String(cause)),
              ),
            );
            return decoded;
          }),
      );
      return body as AzureBoardsWorkItem;
    });

  const validateCredentials: AzureBoardsApiClientShape["validateCredentials"] = () =>
    Effect.gen(function* () {
      // Probe the project resource, which exists for any valid credential;
      // probing work item id 1 reported valid credentials as invalid on real
      // boards (REVIEW P2).
      const url = `${baseUrl}/_apis/projects/${credentials.project}?api-version=${apiVersion}`;
      yield* execute(
        "AzureBoards.validateCredentials",
        HttpClientRequest.get(url),
        () => Effect.void,
      );
    });

  return { queryWorkItemIds, fetchWorkItemsByIds, fetchWorkItem, validateCredentials };
};
