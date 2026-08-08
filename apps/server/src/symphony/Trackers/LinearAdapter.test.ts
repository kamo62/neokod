import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { invalidTrackerConfig, missingTrackerSecret } from "./Errors.ts";
import { makeLinearAdapter } from "./LinearAdapter.ts";

const ENDPOINT = "https://api.linear.app/graphql";

const pageResponse = (nodes: unknown[], hasNextPage = false, endCursor: string | null = null) => ({
  data: {
    issues: {
      nodes,
      pageInfo: { hasNextPage, endCursor },
    },
  },
});

const viewerResponse = () => ({ data: { viewer: { id: "user-1" } } });

const makeFakeClient = (responses: {
  readonly pages?: ReadonlyArray<unknown>;
  readonly byIds?: unknown;
  readonly viewer?: unknown;
}) =>
  HttpClient.make((request) => {
    const rawBody = (request.body as { readonly body?: Uint8Array } | undefined)?.body;
    const payload =
      typeof rawBody !== "undefined"
        ? (JSON.parse(new TextDecoder().decode(rawBody)) as {
            readonly query?: string;
            readonly variables?: Record<string, unknown>;
          })
        : {};

    if (payload.query?.includes("SymphonyLinearPoll")) {
      const pages = responses.pages ?? [pageResponse([])];
      const after = payload.variables?.after;
      const pageIndex = typeof after === "string" ? Number(after) : 0;
      const page = pages[pageIndex] ?? pages[pages.length - 1];
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(page)));
    }
    if (payload.query?.includes("SymphonyLinearIssuesById")) {
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, Response.json(responses.byIds ?? pageResponse([]))),
      );
    }
    if (payload.query?.includes("SymphonyLinearViewer")) {
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, Response.json(responses.viewer ?? viewerResponse())),
      );
    }
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({}, { status: 404 })));
  });

const makeAdapter = (overrides: {
  readonly provider?: Readonly<Record<string, unknown>>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly httpClient?: HttpClient.HttpClient;
}) =>
  makeLinearAdapter({
    provider: {
      endpoint: ENDPOINT,
      api_key: "lin-api-key",
      project_slug: "neokod",
      ...overrides.provider,
    },
    env: overrides.env ?? {},
    httpClient:
      overrides.httpClient ??
      makeFakeClient({
        pages: [pageResponse([])],
      }),
  });

const rawIssue = (overrides: Record<string, unknown> = {}) => ({
  id: "issue-uuid-1",
  identifier: "NEO-42",
  title: "Fix the login bug",
  description: "Body text",
  priority: 2,
  state: { name: "Todo" },
  branchName: "fix/login-bug",
  url: "https://linear.app/neokod/issue/NEO-42",
  assignee: { id: "user-1" },
  labels: { nodes: [{ name: "Agent Ready" }, { name: "agent-ready" }] },
  inverseRelations: { nodes: [] },
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:00.000Z",
  ...overrides,
});

describe("makeLinearAdapter", () => {
  it.effect("normalizes Linear issues and maps them into NormalizedIssue", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter({
        httpClient: makeFakeClient({
          pages: [pageResponse([rawIssue()])],
        }),
      });

      const issues = yield* adapter.listCandidateIssues();
      expect(issues).toHaveLength(1);
      const issue = issues[0];
      if (issue === undefined) {
        throw new Error("expected an issue");
      }
      expect(issue.id).toBe("issue-uuid-1");
      expect(issue.identifier).toBe("NEO-42");
      expect(issue.title).toBe("Fix the login bug");
      expect(issue.description).toBe("Body text");
      expect(issue.state).toBe("Todo");
      expect(issue.priority).toBe(2);
      expect(issue.branchName).toBe("fix/login-bug");
      expect(issue.url).toBe("https://linear.app/neokod/issue/NEO-42");
      expect(issue.assigneeId).toBe("user-1");
      expect(issue.labels).toEqual(["agent ready", "agent-ready"]);
      expect(issue.dispatchable).toBe(true);
    }),
  );

  it.effect("follows the cursor across pages", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter({
        httpClient: makeFakeClient({
          pages: [
            pageResponse([rawIssue()], true, "cursor-1"),
            pageResponse([rawIssue({ id: "issue-uuid-2", identifier: "NEO-43" })], false),
          ],
        }),
      });

      const issues = yield* adapter.listCandidateIssues();
      expect(issues.map((issue) => issue.identifier)).toEqual(["NEO-42", "NEO-43"]);
    }),
  );

  it.effect("marks an issue blocked by a non-terminal relation as not dispatchable", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter({
        httpClient: makeFakeClient({
          pages: [
            pageResponse([
              rawIssue({
                inverseRelations: {
                  nodes: [
                    {
                      type: "blocks",
                      issue: {
                        id: "blocker-1",
                        identifier: "NEO-40",
                        state: { name: "In Progress" },
                      },
                    },
                  ],
                },
              }),
            ]),
          ],
        }),
      });

      const issues = yield* adapter.listCandidateIssues();
      expect(issues[0]?.dispatchable).toBe(false);
      expect(issues[0]?.blockedBy).toEqual([
        { id: "blocker-1", identifier: "NEO-40", state: "In Progress" },
      ]);
    }),
  );

  it.effect("ignores a non-blocks relation and non-todo blockers", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter({
        httpClient: makeFakeClient({
          pages: [
            pageResponse([
              rawIssue({
                state: { name: "In Progress" },
                inverseRelations: {
                  nodes: [
                    {
                      type: "related",
                      issue: { id: "r", identifier: "NEO-1", state: { name: "Todo" } },
                    },
                  ],
                },
              }),
            ]),
          ],
        }),
      });

      const issues = yield* adapter.listCandidateIssues();
      expect(issues[0]?.dispatchable).toBe(true);
      expect(issues[0]?.blockedBy).toEqual([]);
    }),
  );

  it.effect("applies the assignee filter and rejects unassigned issues", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter({
        provider: { assignee: "user-2" },
        httpClient: makeFakeClient({
          pages: [pageResponse([rawIssue()])],
        }),
      });

      const issues = yield* adapter.listCandidateIssues();
      expect(issues[0]?.dispatchable).toBe(false);
    }),
  );

  it.effect('resolves assignee "me" through the viewer query', () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter({
        provider: { assignee: "me" },
        httpClient: makeFakeClient({
          pages: [pageResponse([rawIssue()])],
          viewer: viewerResponse(),
        }),
      });

      const issues = yield* adapter.listCandidateIssues();
      expect(issues[0]?.dispatchable).toBe(true);
    }),
  );

  it.effect("refreshIssues returns records sorted to the requested order", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter({
        httpClient: makeFakeClient({
          byIds: pageResponse([
            rawIssue({ id: "b", identifier: "NEO-2" }),
            rawIssue({ id: "a", identifier: "NEO-1" }),
          ]),
        }),
      });

      const issues = yield* adapter.refreshIssues(["a", "b"]);
      expect(issues.map((issue) => issue.identifier)).toEqual(["NEO-1", "NEO-2"]);
    }),
  );

  it.effect("refreshIssues omits ids that are no longer visible", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter({
        httpClient: makeFakeClient({
          byIds: pageResponse([rawIssue()]),
        }),
      });

      const issues = yield* adapter.refreshIssues(["issue-uuid-1", "issue-uuid-gone"]);
      expect(issues.map((issue) => issue.id)).toEqual(["issue-uuid-1"]);
    }),
  );

  it.effect("defaults the endpoint and rejects non-https overrides", () =>
    Effect.gen(function* () {
      let requestedUrl = "";
      const adapter = yield* makeAdapter({
        provider: { endpoint: undefined, api_key: undefined },
        env: { LINEAR_API_KEY: "env-key" },
        httpClient: HttpClient.make((request) => {
          requestedUrl = request.url;
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, Response.json(pageResponse([]))),
          );
        }),
      });
      yield* adapter.listCandidateIssues();
      expect(requestedUrl).toBe("https://api.linear.app/graphql");

      const httpResult = yield* Effect.result(
        makeAdapter({ provider: { endpoint: "http://api.linear.app/graphql" } }),
      );
      if (httpResult._tag === "Success") {
        throw new Error("expected non-https rejection");
      }
      expect(httpResult.failure.code).toBe("invalid_tracker_config");
    }),
  );

  it.effect("fails when the API key is missing", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(makeAdapter({ provider: { api_key: undefined } }));
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("resolves a $VAR api_key from the environment", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter({
        provider: { api_key: "$LINEAR_TOKEN" },
        env: { LINEAR_TOKEN: "lin-api-key" },
        httpClient: makeFakeClient({ pages: [pageResponse([])] }),
      });
      expect(adapter.secretEnvironmentNames()).toContain("LINEAR_TOKEN");
      yield* adapter.validateConfiguration();
    }),
  );

  it.effect("declares LINEAR_API_KEY in secretEnvironmentNames", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter({
        provider: { api_key: undefined },
        env: { LINEAR_API_KEY: "env-key" },
        httpClient: makeFakeClient({ pages: [pageResponse([])] }),
      });
      expect(adapter.secretEnvironmentNames()).toContain("LINEAR_API_KEY");
    }),
  );

  it.effect("fails validation on empty active or terminal states", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter({
        provider: { active_states: [] },
      });
      const result = yield* Effect.result(adapter.validateConfiguration());
      if (result._tag === "Success") {
        throw new Error("expected failure");
      }
      expect(result.failure.code).toBe("invalid_tracker_config");
    }),
  );
});
