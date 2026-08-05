import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { makeGitHubProjectsAdapter } from "./GitHubProjectsAdapter.ts";

const rawItem = (overrides: Record<string, unknown> = {}) => ({
  id: "item-1",
  fieldValues: {
    nodes: [{ __typename: "ProjectV2ItemFieldSingleSelectValue", name: "Open" }],
  },
  content: {
    __typename: "Issue",
    id: "issue-1",
    number: 42,
    title: "Fix the login bug",
    body: "Body text",
    url: "https://github.com/acme/proj/issues/42",
    state: "OPEN",
    labels: { nodes: [{ name: "Agent Ready" }, { name: "agent-ready" }] },
    assignees: { nodes: [{ login: "worker" }] },
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
  },
  ...overrides,
});

const makeFakeClient = (options: {
  readonly items?: ReadonlyArray<unknown>;
  readonly byItemId?: (id: string) => unknown | null;
  readonly errors?: boolean;
}) =>
  HttpClient.make((request) => {
    const url = new URL(request.url);
    if (url.pathname !== "/graphql") {
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, Response.json({}, { status: 404 })),
      );
    }
    const body = request.body as unknown;
    let rawBody: Uint8Array | undefined;
    if (body instanceof Uint8Array) {
      rawBody = body;
    } else if (typeof body === "object" && body !== null) {
      const candidate = (body as { readonly body?: Uint8Array }).body;
      if (candidate instanceof Uint8Array) {
        rawBody = candidate;
      }
    }
    if (rawBody === undefined) {
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({})));
    }
    const payload = JSON.parse(new TextDecoder().decode(rawBody)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    if (options.errors === true) {
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, Response.json({ errors: [{ message: "boom" }] })),
      );
    }
    if (payload.query.includes("viewer")) {
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, Response.json({ data: { viewer: { login: "me" } } })),
      );
    }
    const itemId = /itemId: "([^"]+)"/.exec(payload.query)?.[1];
    if (itemId !== undefined) {
      const item = options.byItemId?.(itemId) ?? null;
      const nodes = item === null ? [] : [item];
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            data: {
              owner: { projectV2: { items: { nodes } } },
            },
          }),
        ),
      );
    }
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json({
          data: {
            owner: { projectV2: { items: { nodes: options.items ?? [] } } },
          },
        }),
      ),
    );
  });

const makeAdapter = (
  overrides: {
    readonly provider?: Readonly<Record<string, unknown>>;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly httpClient?: HttpClient.HttpClient;
  } = {},
) =>
  makeGitHubProjectsAdapter({
    provider: {
      owner: "acme",
      number: "7",
      api_key: "gh-pat",
      ...overrides.provider,
    },
    env: overrides.env ?? {},
    httpClient: overrides.httpClient ?? makeFakeClient({}),
  });

describe("makeGitHubProjectsAdapter", () => {
  it.effect("normalizes project issue items into NormalizedIssue", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter({
        httpClient: makeFakeClient({ items: [rawItem()] }),
      });

      const issues = yield* adapter.listCandidateIssues();
      expect(issues).toHaveLength(1);
      const issue = issues[0];
      if (issue === undefined) {
        throw new Error("expected an issue");
      }
      expect(issue.id).toBe("item-1");
      expect(issue.identifier).toBe("GH-42");
      expect(issue.title).toBe("Fix the login bug");
      expect(issue.description).toBe("Body text");
      expect(issue.state).toBe("Open");
      expect(issue.priority).toBeNull();
      expect(issue.branchName).toBeNull();
      expect(issue.url).toContain("issues/42");
      expect(issue.assigneeId).toBe("worker");
      expect(issue.labels).toEqual(["agent ready", "agent-ready"]);
      expect(issue.dispatchable).toBe(true);
      expect(issue.createdAt).toBe("2026-08-01T00:00:00.000Z");
      expect(issue.updatedAt).toBe("2026-08-02T00:00:00.000Z");
      expect(issue.nativeRef).toMatchObject({ item_id: "item-1", owner: "acme" });
    }),
  );

  it.effect("omits items that are not issues", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter({
        httpClient: makeFakeClient({
          items: [rawItem(), { id: "item-2", content: { __typename: "PullRequest", number: 3 } }],
        }),
      });
      const issues = yield* adapter.listCandidateIssues();
      expect(issues.map((issue) => issue.id)).toEqual(["item-1"]);
    }),
  );

  it.effect("filters items whose status is not active", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter({
        httpClient: makeFakeClient({
          items: [
            rawItem(),
            rawItem({
              id: "item-2",
              fieldValues: {
                nodes: [{ __typename: "ProjectV2ItemFieldSingleSelectValue", name: "Done" }],
              },
            }),
          ],
        }),
      });
      const issues = yield* adapter.listCandidateIssues();
      expect(issues.map((issue) => issue.id)).toEqual(["item-1"]);
    }),
  );

  it.effect("refreshes by item id and omits missing items", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter({
        httpClient: makeFakeClient({
          byItemId: (id) => (id === "item-1" ? rawItem() : null),
        }),
      });
      const issues = yield* adapter.refreshIssues(["item-1", "item-9"]);
      expect(issues.map((issue) => issue.id)).toEqual(["item-1"]);
    }),
  );

  it.effect("getIssue returns the single item", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter({
        httpClient: makeFakeClient({ byItemId: () => rawItem() }),
      });
      const issue = yield* adapter.getIssue("item-1");
      expect(issue.identifier).toBe("GH-42");
    }),
  );

  it.effect("getIssue fails for a missing item", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter({
        httpClient: makeFakeClient({ byItemId: () => null }),
      });
      const result = yield* Effect.result(adapter.getIssue("item-9"));
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("fails without a token", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        makeAdapter({ provider: { api_key: undefined }, env: {} }),
      );
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("resolves $VAR api_key references and declares the env name", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter({
        provider: { api_key: "$GH_TOKEN" },
        env: { GH_TOKEN: "secret-value" },
      });
      const names = adapter.secretEnvironmentNames();
      expect(names).toContain("GH_TOKEN");
      expect(names).toContain("GITHUB_PAT");
    }),
  );

  it.effect("maps GraphQL errors to tracker_response", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter({
        httpClient: makeFakeClient({ errors: true }),
      });
      const result = yield* Effect.result(adapter.probe());
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("declares the profile with the documented keys", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter();
      const profile = adapter.profile();
      expect(profile.kind).toBe("github_projects");
      expect(profile.providerKeys.map((key) => key.key)).toEqual(["owner", "number", "api_key"]);
      expect(profile.scopeSelection).toContain("acme/7");
    }),
  );
});
