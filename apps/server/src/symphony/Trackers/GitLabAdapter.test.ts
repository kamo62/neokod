import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as UrlParams from "effect/unstable/http/UrlParams";

import { makeGitLabAdapter } from "./GitLabAdapter.ts";

const rawIssue = (overrides: Record<string, unknown> = {}) => ({
  id: 101,
  iid: 7,
  project_id: 42,
  title: "Fix the login bug",
  state: "opened",
  description: "Body text",
  web_url: "https://gitlab.com/my-org/my-project/-/issues/7",
  labels: ["Agent Ready", "agent-ready"],
  assignees: [{ id: 55, username: "worker" }],
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-02T00:00:00.000Z",
  ...overrides,
});

const makeFakeClient = (responses: {
  readonly pages?: ReadonlyArray<ReadonlyArray<unknown>>;
  readonly byId?: (id: string) => { readonly status: number; readonly body: unknown };
}) =>
  HttpClient.make((request) => {
    const url = new URL(request.url);
    const match = /\/projects\/([^/]+)\/issues(\/\d+)?$/.exec(url.pathname);
    if (match === null) {
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, Response.json({}, { status: 404 })),
      );
    }
    const id = match[2];
    if (id !== undefined) {
      const page = url.searchParams.get("page") ?? "1";
      const result = responses.byId?.(id.replace("/", ""));
      const status = result?.status ?? 404;
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json(result?.body ?? { message: "Not Found" }, { status }),
        ),
      );
    }
    const pages = responses.pages ?? [[]];
    const pageRaw = UrlParams.getAll(request.urlParams, "page")[0];
    const page = pageRaw === undefined ? 1 : Number(pageRaw);
    const issues = pages[page - 1] ?? pages[pages.length - 1] ?? [];
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(issues)));
  });

const makeAdapter = (overrides: {
  readonly provider?: Readonly<Record<string, unknown>>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly httpClient?: HttpClient.HttpClient;
}) =>
  makeGitLabAdapter({
    provider: {
      api_url: "https://gitlab.com/api/v4",
      project_path: "my-org/my-project",
      api_key: "gl-pat",
      ...overrides.provider,
    },
    env: overrides.env ?? {},
    httpClient: overrides.httpClient ?? makeFakeClient({}),
  });

describe("makeGitLabAdapter", () => {
  it.effect("normalizes GitLab issues into NormalizedIssue", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter({
        httpClient: makeFakeClient({ pages: [[rawIssue()]] }),
      });

      const issues = yield* adapter.listCandidateIssues();
      expect(issues).toHaveLength(1);
      const issue = issues[0];
      if (issue === undefined) {
        throw new Error("expected an issue");
      }
      expect(issue.id).toBe("7");
      expect(issue.identifier).toBe("GL-7");
      expect(issue.title).toBe("Fix the login bug");
      expect(issue.description).toBe("Body text");
      expect(issue.state).toBe("opened");
      expect(issue.priority).toBeNull();
      expect(issue.branchName).toBeNull();
      expect(issue.url).toBe("https://gitlab.com/my-org/my-project/-/issues/7");
      expect(issue.assigneeId).toBe("55");
      expect(issue.labels).toEqual(["agent ready", "agent-ready"]);
      expect(issue.blockedBy).toEqual([]);
      expect(issue.dispatchable).toBe(true);
      expect(issue.nativeRef).toEqual({
        id: 101,
        iid: 7,
        project_id: 42,
        project_path: "my-org/my-project",
      });
    }),
  );

  it.effect("follows pages until a short page is returned", () =>
    Effect.gen(function* () {
      const pageOf = (offset: number) =>
        Array.from({ length: 100 }, (_, index) => rawIssue({ iid: offset + index }));
      const adapter = yield* makeAdapter({
        httpClient: makeFakeClient({
          pages: [pageOf(1), pageOf(101), [rawIssue({ iid: 201 })]],
        }),
      });

      const issues = yield* adapter.listCandidateIssues();
      expect(issues).toHaveLength(201);
      expect(issues[0]?.identifier).toBe("GL-1");
      expect(issues[200]?.identifier).toBe("GL-201");
    }),
  );

  it.effect("drops records whose state is not in active_states", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter({
        httpClient: makeFakeClient({
          pages: [[rawIssue({ state: "closed" }), rawIssue({ iid: 8, state: "opened" })]],
        }),
      });

      const issues = yield* adapter.listCandidateIssues();
      expect(issues.map((issue) => issue.identifier)).toEqual(["GL-8"]);
    }),
  );

  it.effect("refreshIssues omits ids that 404", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter({
        httpClient: makeFakeClient({
          byId: (id) =>
            id === "7"
              ? { status: 200, body: rawIssue() }
              : { status: 404, body: { message: "Not Found" } },
        }),
      });

      const issues = yield* adapter.refreshIssues(["7", "999"]);
      expect(issues.map((issue) => issue.identifier)).toEqual(["GL-7"]);
    }),
  );

  it.effect("getIssue returns a single issue", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter({
        httpClient: makeFakeClient({
          byId: () => ({ status: 200, body: rawIssue() }),
        }),
      });

      const issue = yield* adapter.getIssue("7");
      expect(issue.identifier).toBe("GL-7");
    }),
  );

  it.effect("getIssue fails for a non-numeric id", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter({});
      const result = yield* Effect.result(adapter.getIssue("abc"));
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("maps the fallback assignee username when id is absent", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter({
        httpClient: makeFakeClient({
          pages: [[rawIssue({ assignees: [{ username: "worker" }] })]],
        }),
      });

      const issues = yield* adapter.listCandidateIssues();
      expect(issues[0]?.assigneeId).toBe("worker");
    }),
  );

  it.effect("resolves a $VAR api_key from the environment", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter({
        provider: { api_key: "$GITLAB_TOKEN" },
        env: { GITLAB_TOKEN: "gl-pat" },
        httpClient: makeFakeClient({ pages: [[]] }),
      });
      expect(adapter.secretEnvironmentNames()).toContain("GITLAB_TOKEN");
      yield* adapter.validateConfiguration();
    }),
  );

  it.effect("declares GITLAB_PAT and GITLAB_ACCESS_TOKEN in secretEnvironmentNames", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter({
        provider: { api_key: undefined },
        env: { GITLAB_PAT: "env-key" },
        httpClient: makeFakeClient({ pages: [[]] }),
      });
      const names = adapter.secretEnvironmentNames();
      expect(names).toContain("GITLAB_PAT");
      expect(names).toContain("GITLAB_ACCESS_TOKEN");
    }),
  );

  it.effect("fails when the API key is missing", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(makeAdapter({ provider: { api_key: undefined } }));
      if (result._tag === "Success") {
        throw new Error("expected failure");
      }
      expect(result.failure.code).toBe("missing_tracker_secret");
    }),
  );

  it.effect("fails when the project path is missing or malformed", () =>
    Effect.gen(function* () {
      const missing = yield* Effect.result(makeAdapter({ provider: { project_path: undefined } }));
      if (missing._tag === "Success") {
        throw new Error("expected failure");
      }
      expect(missing.failure.code).toBe("invalid_tracker_config");

      const malformed = yield* Effect.result(
        makeAdapter({ provider: { project_path: "has space" } }),
      );
      if (malformed._tag === "Success") {
        throw new Error("expected failure");
      }
      expect(malformed.failure.code).toBe("invalid_tracker_config");
    }),
  );

  it.effect("rejects non-https api_url at construction", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        makeAdapter({ provider: { api_url: "http://gitlab.example.com/api/v4" } }),
      );
      if (result._tag === "Success") {
        throw new Error("expected failure");
      }
      expect(result.failure.code).toBe("invalid_tracker_config");
    }),
  );

  it.effect("fails validation on invalid states", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter({
        provider: { active_states: ["wip"] },
      });
      const result = yield* Effect.result(adapter.validateConfiguration());
      if (result._tag === "Success") {
        throw new Error("expected failure");
      }
      expect(result.failure.code).toBe("invalid_tracker_config");
    }),
  );
});
