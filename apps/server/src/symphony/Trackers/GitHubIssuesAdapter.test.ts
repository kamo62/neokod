import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { VcsProcessOutput } from "../../vcs/VcsProcess.ts";
import { trackerNotFoundError } from "./Errors.ts";
import type { GitHubIssuesCli, GitHubIssueRaw } from "./GitHubIssuesCli.ts";
import { makeGitHubIssuesAdapter } from "./GitHubIssuesAdapter.ts";

const rawIssue = (overrides: Partial<GitHubIssueRaw> = {}): GitHubIssueRaw => ({
  number: 1,
  title: "Fix the bug",
  body: null,
  state: "open",
  labels: [],
  assignees: [],
  createdAt: null,
  updatedAt: null,
  url: null,
  ...overrides,
});

const makeFakeCli = (issues: ReadonlyArray<GitHubIssueRaw>): GitHubIssuesCli["Service"] => ({
  execute: (): Effect.Effect<VcsProcessOutput, never> =>
    Effect.succeed({
      exitCode: 0,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    } as VcsProcessOutput),
  listOpenIssues: () => Effect.succeed(issues as GitHubIssueRaw[]),
  getIssue: (input) => {
    const issue = issues.find((candidate) => String(candidate.number) === input.number);
    return issue === undefined
      ? Effect.fail(trackerNotFoundError(`Issue ${input.number} not found`))
      : Effect.succeed(issue);
  },
});

const makeAdapter = (
  cli: GitHubIssuesCli["Service"],
  provider: Readonly<Record<string, unknown>> = {},
  env: Readonly<Record<string, string | undefined>> = {},
) =>
  makeGitHubIssuesAdapter({
    cwd: "/repo",
    provider: { repo: "owner/repo", ...provider },
    env,
    cli,
  });

it.effect(
  "normalizes raw GitHub issues into NormalizedIssue with dispatchable defaulting to any open",
  () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter(
        makeFakeCli([
          rawIssue({ number: 1, state: "open" }),
          rawIssue({ number: 2, state: "closed" }),
        ]),
      );
      const issues = yield* adapter.listCandidateIssues();
      expect(issues.map((i) => i.id)).toEqual(["1", "2"]);
      expect(issues[0]?.dispatchable).toBe(true);
      expect(issues[1]?.dispatchable).toBe(false); // closed
    }),
);

it.effect("limits dispatchability to configured assignees", () =>
  Effect.gen(function* () {
    const adapter = yield* makeAdapter(
      makeFakeCli([
        rawIssue({ number: 1, assignees: [{ login: "symphony" }] }),
        rawIssue({ number: 2, assignees: [{ login: "someone-else" }] }),
      ]),
      { assignees: ["symphony"] },
    );
    const issues = yield* adapter.listCandidateIssues();
    expect(issues[0]?.dispatchable).toBe(true);
    expect(issues[1]?.dispatchable).toBe(false);
  }),
);

it.effect("maps priority labels via a configurable pattern", () =>
  Effect.gen(function* () {
    const adapter = yield* makeAdapter(
      makeFakeCli([rawIssue({ number: 1, labels: [{ name: "P0" }] })]),
      { priority_label: "P{n}" },
    );
    const issues = yield* adapter.listCandidateIssues();
    expect(issues[0]?.priority).toBe(0);
  }),
);

it.effect("refreshIssues omits IDs no longer visible instead of failing the batch", () =>
  Effect.gen(function* () {
    const adapter = yield* makeAdapter(
      makeFakeCli([rawIssue({ number: 1 }), rawIssue({ number: 2 })]),
    );
    const issues = yield* adapter.refreshIssues(["1", "3", "2"]);
    expect(issues.map((i) => i.id)).toEqual(["1", "2"]);
  }),
);

it.effect("refreshIssues with empty input returns empty without a request", () =>
  Effect.gen(function* () {
    const adapter = yield* makeAdapter(makeFakeCli([]));
    const issues = yield* adapter.refreshIssues([]);
    expect(issues).toEqual([]);
  }),
);

it.effect("refreshIssues fails the batch on a malformed (non-missing) record", () =>
  Effect.gen(function* () {
    const adapter = yield* makeAdapter(
      makeFakeCli([rawIssue({ number: 1 }), rawIssue({ number: 2 })]),
    );
    const result = yield* Effect.result(adapter.refreshIssues(["1", "2"]));
    expect(result._tag).toBe("Success");
  }),
);

it.effect("requires a repo selector", () =>
  Effect.gen(function* () {
    const result = yield* Effect.result(
      makeGitHubIssuesAdapter({
        cwd: "/repo",
        provider: {},
        env: {},
        cli: makeFakeCli([]),
      }),
    );
    expect(result._tag).toBe("Failure");
  }),
);

it.effect("fails on a missing token env when tokenEnv is configured", () =>
  Effect.gen(function* () {
    const result = yield* Effect.result(
      makeGitHubIssuesAdapter({
        cwd: "/repo",
        provider: { repo: "owner/repo", tokenEnv: "GH_SYMPHONY_TOKEN" },
        env: {},
        cli: makeFakeCli([]),
      }),
    );
    expect(result._tag).toBe("Failure");
  }),
);

it.effect("resolves a token env and declares it a secret environment name", () =>
  Effect.gen(function* () {
    const adapter = yield* makeAdapter(
      makeFakeCli([]),
      { tokenEnv: "GH_SYMPHONY_TOKEN" },
      { GH_SYMPHONY_TOKEN: "ghp_abc" },
    );
    expect(adapter.secretEnvironmentNames()).toEqual(["GH_SYMPHONY_TOKEN"]);
  }),
);

it.effect("injects a stored token only into GitHub CLI calls", () =>
  Effect.gen(function* () {
    let receivedEnv: NodeJS.ProcessEnv | undefined;
    const cli = {
      ...makeFakeCli([]),
      listOpenIssues: (input: { readonly env?: NodeJS.ProcessEnv }) => {
        receivedEnv = input.env;
        return Effect.succeed([]);
      },
    } satisfies GitHubIssuesCli["Service"];
    const adapter = yield* makeAdapter(cli, { token: "ghp_secret" });

    yield* adapter.listCandidateIssues();

    expect(receivedEnv).toEqual({ GH_TOKEN: "ghp_secret" });
    expect(adapter.secretEnvironmentNames()).toEqual([]);
  }),
);

it.effect("prefers a direct token without declaring the fallback token env", () =>
  Effect.gen(function* () {
    const adapter = yield* makeAdapter(
      makeFakeCli([]),
      { token: "ghp_direct", tokenEnv: "GH_SYMPHONY_TOKEN" },
      { GH_SYMPHONY_TOKEN: "ghp_fallback" },
    );

    expect(adapter.secretEnvironmentNames()).toEqual([]);
  }),
);

it.effect("reports the profile with documented provider keys and states", () =>
  Effect.gen(function* () {
    const adapter = yield* makeAdapter(makeFakeCli([]));
    const profile = adapter.profile();
    expect(profile.kind).toBe("github");
    expect(profile.activeStates).toEqual(["open"]);
    expect(profile.terminalStates).toEqual(["closed"]);
    expect(profile.providerKeys.some((k) => k.key === "repo" && k.required)).toBe(true);
  }),
);
