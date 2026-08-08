import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as UrlParams from "effect/unstable/http/UrlParams";

import { makeAsanaAdapter } from "./AsanaAdapter.ts";

const rawTask = (overrides: Record<string, unknown> = {}) => ({
  gid: "task-gid-1",
  name: "Fix the login bug",
  notes: "Body text",
  completed: false,
  resource_subtype: "default_task",
  permalink_url: "https://app.asana.com/0/project-gid-1/task-gid-1",
  created_at: "2026-08-01T00:00:00.000Z",
  modified_at: "2026-08-02T00:00:00.000Z",
  assignee: { gid: "user-1" },
  tags: [{ name: "Agent Ready" }, { name: "agent-ready" }],
  memberships: [
    {
      project: { gid: "project-gid-1" },
      section: { gid: "section-1", name: "Todo" },
    },
  ],
  ...overrides,
});

const pageResponse = (tasks: unknown[], nextPage: unknown) => ({
  data: tasks,
  next_page: nextPage,
});

const makeFakeClient = (responses: {
  readonly pages?: ReadonlyArray<unknown>;
  readonly byId?: (id: string) => { readonly status: number; readonly body: unknown };
}) =>
  HttpClient.make((request) => {
    const url = new URL(request.url);
    const match = /\/tasks\/([^/]+)$/.exec(url.pathname);
    if (match !== null) {
      const id = match[1] ?? "";
      const result = responses.byId?.(id);
      const status = result?.status ?? 404;
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json(result?.body ?? { errors: [{ message: "Not Found" }] }, { status }),
        ),
      );
    }
    if (!/\/projects\/[^/]+\/tasks$/.test(url.pathname)) {
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, Response.json({}, { status: 404 })),
      );
    }
    const pages = responses.pages ?? [pageResponse([], null)];
    const offsetRaw = UrlParams.getAll(request.urlParams, "offset")[0];
    const requestedOffset = offsetRaw === undefined ? "" : offsetRaw;
    let index = -1;
    for (let i = 0; i < pages.length && index < 0; i += 1) {
      const key =
        i === 0
          ? ""
          : (pages[i - 1] as { next_page?: { offset?: string } | null }).next_page?.offset;
      if (key === requestedOffset) {
        index = i;
      }
    }
    const page = index >= 0 ? pages[index] : pages[0];
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(page)));
  });

const makeAdapter = (overrides: {
  readonly provider?: Readonly<Record<string, unknown>>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly httpClient?: HttpClient.HttpClient;
}) =>
  makeAsanaAdapter({
    provider: {
      project_gid: "project-gid-1",
      api_key: "asana-pat",
      ...overrides.provider,
    },
    env: overrides.env ?? {},
    httpClient: overrides.httpClient ?? makeFakeClient({}),
  });

describe("makeAsanaAdapter", () => {
  it.effect("normalizes Asana tasks into NormalizedIssue", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter({
        httpClient: makeFakeClient({
          pages: [pageResponse([rawTask()], null)],
        }),
      });

      const issues = yield* adapter.listCandidateIssues();
      expect(issues).toHaveLength(1);
      const issue = issues[0];
      if (issue === undefined) {
        throw new Error("expected an issue");
      }
      expect(issue.id).toBe("task-gid-1");
      expect(issue.identifier).toBe("ASANA-task-gid-1");
      expect(issue.title).toBe("Fix the login bug");
      expect(issue.description).toBe("Body text");
      expect(issue.state).toBe("Todo");
      expect(issue.priority).toBeNull();
      expect(issue.branchName).toBeNull();
      expect(issue.url).toBe("https://app.asana.com/0/project-gid-1/task-gid-1");
      expect(issue.assigneeId).toBe("user-1");
      expect(issue.labels).toEqual(["agent ready", "agent-ready"]);
      expect(issue.blockedBy).toEqual([]);
      expect(issue.dispatchable).toBe(true);
      expect(issue.nativeRef).toEqual({
        task_gid: "task-gid-1",
        project_gid: "project-gid-1",
        section_gid: "section-1",
      });
    }),
  );

  it.effect("follows next_page offsets until the last page", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter({
        httpClient: makeFakeClient({
          pages: [
            pageResponse([rawTask({ gid: "a" })], { offset: "abc" }),
            pageResponse([rawTask({ gid: "b" })], { offset: "def" }),
            pageResponse([rawTask({ gid: "c" })], null),
          ],
        }),
      });

      const issues = yield* adapter.listCandidateIssues();
      expect(issues.map((issue) => issue.id)).toEqual(["a", "b", "c"]);
    }),
  );

  it.effect("marks completed and section tasks as not dispatchable", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter({
        httpClient: makeFakeClient({
          pages: [
            pageResponse(
              [
                rawTask({ gid: "done", completed: true }),
                rawTask({ gid: "section", resource_subtype: "section" }),
              ],
              null,
            ),
          ],
        }),
      });

      const issues = yield* adapter.listCandidateIssues();
      expect(issues[0]?.dispatchable).toBe(false);
      expect(issues[1]?.dispatchable).toBe(false);
    }),
  );

  it.effect("drops tasks outside the configured project membership", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter({
        httpClient: makeFakeClient({
          pages: [
            pageResponse(
              [
                rawTask({
                  memberships: [
                    { project: { gid: "other-project" }, section: { gid: "s", name: "Todo" } },
                  ],
                }),
              ],
              null,
            ),
          ],
        }),
      });

      const issues = yield* adapter.listCandidateIssues();
      expect(issues).toHaveLength(0);
    }),
  );

  it.effect("filters by configured active_states", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter({
        provider: { active_states: ["In Progress"] },
        httpClient: makeFakeClient({
          pages: [
            pageResponse(
              [
                rawTask({
                  gid: "todo",
                  memberships: [
                    { project: { gid: "project-gid-1" }, section: { gid: "s1", name: "Todo" } },
                  ],
                }),
                rawTask({
                  gid: "wip",
                  memberships: [
                    {
                      project: { gid: "project-gid-1" },
                      section: { gid: "s2", name: "In Progress" },
                    },
                  ],
                }),
              ],
              null,
            ),
          ],
        }),
      });

      const issues = yield* adapter.listCandidateIssues();
      expect(issues.map((issue) => issue.id)).toEqual(["wip"]);
    }),
  );

  it.effect("refreshIssues omits 404s and tasks outside the project", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter({
        httpClient: makeFakeClient({
          byId: (id) => {
            if (id === "task-gid-1") {
              return { status: 200, body: { data: rawTask() } };
            }
            if (id === "outside") {
              return {
                status: 200,
                body: {
                  data: rawTask({
                    memberships: [
                      { project: { gid: "other-project" }, section: { gid: "s", name: "Todo" } },
                    ],
                  }),
                },
              };
            }
            return { status: 404, body: {} };
          },
        }),
      });

      const issues = yield* adapter.refreshIssues(["task-gid-1", "outside", "gone"]);
      expect(issues.map((issue) => issue.id)).toEqual(["task-gid-1"]);
    }),
  );

  it.effect("getIssue returns a single task", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter({
        httpClient: makeFakeClient({
          byId: () => ({ status: 200, body: { data: rawTask() } }),
        }),
      });

      const issue = yield* adapter.getIssue("task-gid-1");
      expect(issue.identifier).toBe("ASANA-task-gid-1");
    }),
  );

  it.effect("getIssue fails when the task is not found", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter({
        httpClient: makeFakeClient({ byId: () => ({ status: 404, body: {} }) }),
      });
      const result = yield* Effect.result(adapter.getIssue("nope"));
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("resolves a $VAR api_key from the environment", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter({
        provider: { api_key: "$ASANA_TOKEN" },
        env: { ASANA_TOKEN: "asana-pat" },
        httpClient: makeFakeClient({ pages: [pageResponse([], null)] }),
      });
      expect(adapter.secretEnvironmentNames()).toContain("ASANA_TOKEN");
      yield* adapter.validateConfiguration();
    }),
  );

  it.effect("declares ASANA_PAT in secretEnvironmentNames", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter({
        provider: { api_key: undefined },
        env: { ASANA_PAT: "env-key" },
        httpClient: makeFakeClient({ pages: [pageResponse([], null)] }),
      });
      expect(adapter.secretEnvironmentNames()).toContain("ASANA_PAT");
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

  it.effect("fails when the project gid is missing", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(makeAdapter({ provider: { project_gid: undefined } }));
      if (result._tag === "Success") {
        throw new Error("expected failure");
      }
      expect(result.failure.code).toBe("invalid_tracker_config");
    }),
  );

  it.effect("rejects a non-https endpoint at construction", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        makeAdapter({ provider: { endpoint: "http://app.asana.com/api/1.0" } }),
      );
      if (result._tag === "Success") {
        throw new Error("expected failure");
      }
      expect(result.failure.code).toBe("invalid_tracker_config");
    }),
  );
});
