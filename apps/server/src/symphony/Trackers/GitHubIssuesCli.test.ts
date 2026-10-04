import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { GitHubIssuesCli, GitHubIssuesCliLive } from "./GitHubIssuesCli.ts";

const mockRun = vi.fn<VcsProcess.VcsProcess["Service"]["run"]>();
const layer = GitHubIssuesCliLive.pipe(
  Layer.provide(Layer.mock(VcsProcess.VcsProcess)({ run: mockRun })),
);

afterEach(() => mockRun.mockReset());

describe("GitHubIssuesCli", () => {
  it.effect("uses gh issue list's native limit without an unsupported page flag", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed({
          exitCode: ChildProcessSpawner.ExitCode(0),
          stdout: "[]",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
      );

      const cli = yield* GitHubIssuesCli;
      yield* cli.listOpenIssues({ cwd: "/repo", repo: "kamo62/neokod", limit: 250 });

      expect(mockRun).toHaveBeenCalledWith({
        operation: "GitHubIssuesCli.issue",
        command: "gh",
        args: [
          "issue",
          "list",
          "--repo",
          "kamo62/neokod",
          "--state",
          "open",
          "--limit",
          "250",
          "--json",
          "number,title,body,state,labels,assignees,createdAt,updatedAt,url",
        ],
        cwd: "/repo",
        timeoutMs: 30_000,
      });
    }).pipe(Effect.provide(layer)),
  );
});
