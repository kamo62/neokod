import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { missingTrackerSecret, invalidTrackerConfig } from "./Errors.ts";
import { makeJiraAdapter } from "./JiraAdapter.ts";

const BASE_URL = "https://neokod.atlassian.net";

const makeFakeClient = (responses: {
  readonly search?: unknown;
  readonly bulk?: ReadonlyArray<Record<string, unknown>>;
}) =>
  HttpClient.make((request) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/search/jql")) {
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json(responses.search ?? { issues: [], isLast: true }),
        ),
      );
    }
    if (url.pathname.endsWith("/issue/bulkfetch")) {
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, Response.json({ issues: responses.bulk ?? [] })),
      );
    }
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({}, { status: 404 })));
  });

const makeAdapter = (overrides: {
  readonly provider?: Readonly<Record<string, unknown>>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly httpClient?: HttpClient.HttpClient;
}) =>
  makeJiraAdapter({
    provider: {
      base_url: BASE_URL,
      email: "agent@neokod.dev",
      api_token: "api-token",
      project_key: "PROJ",
      ...overrides.provider,
    },
    env: overrides.env ?? {},
    httpClient:
      overrides.httpClient ??
      makeFakeClient({
        search: { issues: [], isLast: true },
      }),
  });

const rawIssue = (overrides: Record<string, unknown> = {}) => ({
  id: "10100",
  key: "PROJ-42",
  fields: {
    summary: "Fix the login bug",
    description: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Body" }] }],
    },
    status: { name: "To Do", statusCategory: { key: "new" } },
    labels: ["agent-ready"],
    assignee: { accountId: "account-1" },
    created: "2026-08-01T00:00:00.000+0000",
    updated: "2026-08-02T00:00:00.000+0000",
    project: { key: "PROJ" },
    issuelinks: [],
    ...overrides,
  },
});

describe("makeJiraAdapter", () => {
  it.effect("normalizes Jira issues and maps them into NormalizedIssue", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter({
        httpClient: makeFakeClient({
          search: {
            issues: [rawIssue()],
            isLast: true,
          },
        }),
      });
      const issues = yield* adapter.listCandidateIssues();
      expect(issues).toHaveLength(1);
      const issue = issues[0];
      expect(issue?.id).toBe("10100");
      expect(issue?.identifier).toBe("PROJ-42");
      expect(issue?.title).toBe("Fix the login bug");
      expect(issue?.description).toBe("Body");
      expect(issue?.labels).toEqual(["agent-ready"]);
      expect(issue?.assigneeId).toBe("account-1");
      expect(issue?.url).toBe(`${BASE_URL}/browse/PROJ-42`);
    }),
  );

  it.effect("marks an issue with unresolved blockers as non-dispatchable when gating", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter({
        httpClient: makeFakeClient({
          search: {
            issues: [
              rawIssue({
                issuelinks: [
                  {
                    type: { name: "Blocks" },
                    inwardIssue: {
                      id: "10101",
                      key: "PROJ-43",
                      fields: { status: { name: "In Progress" } },
                    },
                  },
                ],
              }),
            ],
            isLast: true,
          },
        }),
      });
      const issues = yield* adapter.listCandidateIssues();
      expect(issues[0]?.dispatchable).toBe(false);
    }),
  );

  it.effect("treats an issue with only terminal blockers as dispatchable", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter({
        httpClient: makeFakeClient({
          search: {
            issues: [
              rawIssue({
                issuelinks: [
                  {
                    type: { name: "Blocks" },
                    inwardIssue: {
                      id: "10101",
                      key: "PROJ-43",
                      fields: { status: { name: "Done" } },
                    },
                  },
                ],
              }),
            ],
            isLast: true,
          },
        }),
      });
      const issues = yield* adapter.listCandidateIssues();
      expect(issues[0]?.dispatchable).toBe(true);
    }),
  );

  it.effect("resolves credentials from env fallbacks", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter({
        provider: { base_url: undefined, api_token: undefined },
        env: { JIRA_BASE_URL: BASE_URL, JIRA_EMAIL: "env@neokod.dev", JIRA_API_TOKEN: "env-token" },
      });
      const profile = adapter.profile();
      expect(profile.kind).toBe("jira");
      expect(profile.providerKeys.some((k) => k.key === "project_key" && k.required)).toBe(true);
    }),
  );

  it.effect("fails when the API token is missing", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        makeAdapter({ provider: { api_token: undefined }, env: {} }),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure).toEqual(missingTrackerSecret("JIRA_API_TOKEN"));
      }
    }),
  );

  it.effect("fails when the project key is missing", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        makeAdapter({ provider: { project_key: undefined }, env: { JIRA_PROJECT_KEY: "PROJ" } }),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure).toEqual(
          invalidTrackerConfig("tracker.provider.project_key must be a Jira project key"),
        );
      }
    }),
  );

  it.effect("fails when base_url is not https", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        makeAdapter({ provider: { base_url: "http://insecure.example.com" } }),
      );
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("refreshIssues omits missing issues and keeps present ones", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter({
        httpClient: HttpClient.make((request) => {
          const url = new URL(request.url);
          if (url.pathname.endsWith("/issue/bulkfetch")) {
            return Effect.succeed(
              HttpClientResponse.fromWeb(request, Response.json({ issues: [rawIssue()] })),
            );
          }
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, Response.json({ issues: [], isLast: true })),
          );
        }),
      });
      const issues = yield* adapter.refreshIssues(["10100", "99999"]);
      expect(issues.map((i) => i.id)).toEqual(["10100"]);
    }),
  );

  it.effect("declares secret environment names including the api token env var", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter({
        provider: { api_token: "$JIRA_PAT" },
        env: { JIRA_PAT: "pat-value" },
      });
      expect(adapter.secretEnvironmentNames()).toContain("JIRA_API_TOKEN");
      expect(adapter.secretEnvironmentNames()).toContain("JIRA_PAT");
    }),
  );
});
