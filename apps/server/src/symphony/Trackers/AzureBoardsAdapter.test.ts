import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { makeAzureBoardsAdapter } from "./AzureBoardsAdapter.ts";

const rawWorkItem = (overrides: Record<string, unknown> = {}) => ({
  id: 123,
  rev: 3,
  url: "https://dev.azure.com/acme/proj/_apis/wit/workItems/123",
  fields: {
    "System.Title": "Fix the login bug",
    "System.Description": "Body text",
    "System.State": "Active",
    "System.Tags": "Agent Ready; agent-ready",
    "System.AssignedTo": "worker@example.com <worker@example.com>",
    "System.CreatedDate": "2026-08-01T00:00:00.000Z",
    "System.ChangedDate": "2026-08-02T00:00:00.000Z",
    "System.WorkItemType": "Bug",
    ...((overrides.fields ?? {}) as Record<string, unknown>),
  },
  ...overrides,
});

const makeFakeClient = (options: {
  readonly queryIds?: ReadonlyArray<number>;
  readonly byId?: (id: string) => { readonly status: number; readonly body: unknown };
}) =>
  HttpClient.make((request) => {
    const url = new URL(request.url);
    const wiql = url.pathname.endsWith("/_apis/wit/wiql");
    if (wiql) {
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({ workItems: (options.queryIds ?? []).map((id) => ({ id })) }),
        ),
      );
    }
    const byId = /\/_apis\/wit\/workitems\/(\d+)/.exec(url.pathname);
    if (byId !== null) {
      const result = options.byId?.(byId[1] ?? "");
      const status = result?.status ?? 404;
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json(result?.body ?? { message: "Not Found" }, { status }),
        ),
      );
    }
    if (url.pathname.endsWith("/_apis/wit/workitems")) {
      const ids = url.searchParams.get("ids")?.split(",") ?? [];
      const value = ids
        .map((id) => options.byId?.(id))
        .filter((result): result is { status: number; body: unknown } => result !== undefined)
        .map((result) => result.body);
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ value })));
    }
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({}, { status: 404 })));
  });

const makeAdapter = (
  overrides: {
    readonly provider?: Readonly<Record<string, unknown>>;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly httpClient?: HttpClient.HttpClient;
  } = {},
) =>
  makeAzureBoardsAdapter({
    provider: {
      organization: "acme",
      project: "proj",
      api_key: "az-pat",
      ...overrides.provider,
    },
    env: overrides.env ?? {},
    httpClient: overrides.httpClient ?? makeFakeClient({}),
  });

describe("makeAzureBoardsAdapter", () => {
  it.effect("normalizes Azure Boards work items into NormalizedIssue", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter({
        httpClient: makeFakeClient({
          queryIds: [123],
          byId: () => ({ status: 200, body: rawWorkItem() }),
        }),
      });

      const issues = yield* adapter.listCandidateIssues();
      expect(issues).toHaveLength(1);
      const issue = issues[0];
      if (issue === undefined) {
        throw new Error("expected an issue");
      }
      expect(issue.id).toBe("123");
      expect(issue.identifier).toBe("AB-123");
      expect(issue.title).toBe("Fix the login bug");
      expect(issue.description).toBe("Body text");
      expect(issue.state).toBe("Active");
      expect(issue.priority).toBeNull();
      expect(issue.branchName).toBeNull();
      expect(issue.url).toContain("workItems/123");
      expect(issue.assigneeId).toBe("worker@example.com");
      expect(issue.labels).toEqual(["agent ready", "agent-ready"]);
      expect(issue.dispatchable).toBe(true);
      expect(issue.createdAt).toBe("2026-08-01T00:00:00.000Z");
      expect(issue.updatedAt).toBe("2026-08-02T00:00:00.000Z");
      expect(issue.nativeRef).toMatchObject({ id: 123, organization: "acme", project: "proj" });
    }),
  );

  it.effect("filters work items whose state is not active", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter({
        httpClient: makeFakeClient({
          queryIds: [123, 124],
          byId: (id) =>
            id === "124"
              ? {
                  status: 200,
                  body: rawWorkItem({ fields: { "System.State": "Closed" } }),
                }
              : { status: 200, body: rawWorkItem() },
        }),
      });

      const issues = yield* adapter.listCandidateIssues();
      expect(issues.map((issue) => issue.id)).toEqual(["123"]);
    }),
  );

  it.effect("refreshes by id and omits missing work items", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter({
        httpClient: makeFakeClient({
          byId: (id) =>
            id === "123"
              ? { status: 200, body: rawWorkItem() }
              : { status: 404, body: { message: "Not Found" } },
        }),
      });

      const issues = yield* adapter.refreshIssues(["123", "999"]);
      expect(issues.map((issue) => issue.id)).toEqual(["123"]);
    }),
  );

  it.effect("getIssue returns the single work item", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter({
        httpClient: makeFakeClient({
          byId: () => ({ status: 200, body: rawWorkItem() }),
        }),
      });
      const issue = yield* adapter.getIssue("123");
      expect(issue.identifier).toBe("AB-123");
    }),
  );

  it.effect("getIssue fails for a missing work item", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter({
        httpClient: makeFakeClient({
          byId: () => ({ status: 404, body: { message: "Not Found" } }),
        }),
      });
      const result = yield* Effect.result(adapter.getIssue("999"));
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("fails without a PAT", () =>
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
        provider: { api_key: "$AZDO_PAT" },
        env: { AZDO_PAT: "secret-value" },
      });
      const names = adapter.secretEnvironmentNames();
      expect(names).toContain("AZDO_PAT");
      expect(names).toContain("AZURE_DEVOPS_PAT");
    }),
  );

  it.effect("reports credentials via the probe", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter({
        httpClient: makeFakeClient({}),
      });
      const result = yield* Effect.result(adapter.probe());
      expect(result._tag).toBe("Success");
    }),
  );

  it.effect("declares the profile with the documented keys", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter();
      const profile = adapter.profile();
      expect(profile.kind).toBe("azure_boards");
      expect(profile.providerKeys.map((key) => key.key)).toEqual([
        "organization",
        "project",
        "api_key",
      ]);
      expect(profile.scopeSelection).toContain("acme/proj");
    }),
  );
});
