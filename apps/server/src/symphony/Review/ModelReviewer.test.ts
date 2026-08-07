import { describe, expect, it } from "@effect/vitest";
import type { EffectiveWorkflowConfig, WorkItem } from "@neokod/contracts";
import { ProviderInstanceId, TextGenerationError } from "@neokod/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import type { ProviderInstance } from "../../provider/ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";
import { ReviewService } from "../../review/ReviewService.ts";
import { GitVcsDriver } from "../../vcs/GitVcsDriver.ts";
import * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import { makeSymphonyModelReviewer } from "./ModelReviewer.ts";

const reviewedAt = "2026-08-07T12:00:00.000Z";

const makeTextGeneration = (
  generateCodeReview: TextGeneration.TextGeneration["Service"]["generateCodeReview"],
): TextGeneration.TextGeneration["Service"] =>
  TextGeneration.TextGeneration.of({
    generateCommitMessage: () => Effect.die("unused"),
    generatePrContent: () => Effect.die("unused"),
    generateCodeReview,
    generateBranchName: () => Effect.die("unused"),
    generateThreadTitle: () => Effect.die("unused"),
  });

const makeInstance = (input: {
  readonly id: string;
  readonly models: ReadonlyArray<string>;
  readonly review: TextGeneration.TextGeneration["Service"]["generateCodeReview"];
}): ProviderInstance =>
  ({
    instanceId: ProviderInstanceId.make(input.id),
    driverKind: input.id as ProviderInstance["driverKind"],
    continuationIdentity: {
      driverKind: input.id as ProviderInstance["driverKind"],
      continuationKey: `${input.id}:test`,
    },
    displayName: input.id,
    enabled: true,
    snapshot: {
      maintenanceCapabilities: {},
      getSnapshot: Effect.succeed({
        availability: "available",
        models: input.models.map((slug) => ({
          slug,
          name: slug,
          isCustom: false,
          capabilities: null,
        })),
      } as never),
      refresh: Effect.die("unused"),
      streamChanges: Stream.empty,
    } as unknown as ProviderInstance["snapshot"],
    adapter: {} as ProviderInstance["adapter"],
    textGeneration: makeTextGeneration(input.review),
  }) satisfies ProviderInstance;

const makeRegistry = (
  instances: ReadonlyArray<ProviderInstance>,
): ProviderInstanceRegistry["Service"] => ({
  getInstance: (id) => Effect.succeed(instances.find((instance) => instance.instanceId === id)),
  listInstances: Effect.succeed(instances),
  listUnavailable: Effect.succeed([]),
  streamChanges: Stream.empty,
  subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
});

const reviewService = ReviewService.of({
  getDiffPreview: ({ cwd, baseRef }) =>
    Effect.succeed({
      cwd,
      generatedAt: DateTime.nowUnsafe(),
      sources: [
        {
          id: "branch-range",
          kind: "branch-range",
          title: "Branch changes",
          baseRef: baseRef ?? null,
          headRef: "HEAD",
          diff: "diff --git a/src/a.ts b/src/a.ts\n+export const value = 1;",
          diffHash: "hash-review",
          truncated: false,
        },
      ],
    }),
});

const fakeGit = {
  execute: (input: { readonly args: ReadonlyArray<string> }) =>
    Effect.succeed({
      exitCode: 0,
      stdout: input.args.at(-1)?.startsWith("main") ? "base-sha\n" : "head-sha\n",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    }),
} as unknown as GitVcsDriver["Service"];

const workItem = {
  objective: "Implement reviewer fan-out",
  acceptanceCriteria: ["Collect every reviewer verdict"],
} as unknown as WorkItem;

const makeConfig = (
  reviewAgents: ReadonlyArray<string>,
  reviewRequirement: "all-approve" | "any-approve" | "advisory",
) => ({ reviewAgents, reviewRequirement }) as EffectiveWorkflowConfig;

const runReview = (instances: ReadonlyArray<ProviderInstance>, config: EffectiveWorkflowConfig) =>
  makeSymphonyModelReviewer({
    registry: makeRegistry(instances),
    reviewService,
    git: fakeGit,
    nowIsoEffect: () => Effect.succeed(reviewedAt),
  }).review({
    config,
    workItem,
    workspacePath: "/repo/worktree",
    baseRef: "main",
    headRef: "HEAD",
  });

describe("SymphonyModelReviewer", () => {
  it.effect("returns null when no reviewer models are configured", () =>
    Effect.gen(function* () {
      const result = yield* runReview([], makeConfig([], "advisory"));
      expect(result).toBeNull();
    }),
  );

  it.effect("fans out across provider instances and passes all-approve", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const approve = (provider: string) =>
        makeInstance({
          id: provider,
          models: [provider === "codex_review" ? "gpt-5.6-sol" : "claude-fable-5"],
          review: (input) => {
            calls.push(`${provider}:${input.modelSelection.model}`);
            return Effect.succeed({
              verdict: "approve",
              summary: "Looks correct.",
              findings: [],
            });
          },
        });
      const result = yield* runReview(
        [approve("codex_review"), approve("claude_review")],
        makeConfig(["gpt-5.6-sol", "claude-fable-5"], "all-approve"),
      );

      expect(result?.passed).toBe(true);
      expect(result?.verdict).toBe("approve");
      expect(result?.baseSha).toBe("base-sha");
      expect(result?.headSha).toBe("head-sha");
      expect(result?.sourceHashes).toEqual(["hash-review"]);
      expect(result?.reviewers.map((reviewer) => reviewer.status)).toEqual([
        "completed",
        "completed",
      ]);
      expect(calls.sort()).toEqual(["claude_review:claude-fable-5", "codex_review:gpt-5.6-sol"]);
    }),
  );

  it.effect("fails all-approve when a provider review fails", () =>
    Effect.gen(function* () {
      const result = yield* runReview(
        [
          makeInstance({
            id: "codex_review",
            models: ["gpt-5.6-sol"],
            review: () => Effect.succeed({ verdict: "approve", summary: "Fine.", findings: [] }),
          }),
          makeInstance({
            id: "claude_review",
            models: ["claude-fable-5"],
            review: () =>
              Effect.fail(
                new TextGenerationError({
                  operation: "generateCodeReview",
                  detail: "provider unavailable",
                }),
              ),
          }),
        ],
        makeConfig(["gpt-5.6-sol", "claude-fable-5"], "all-approve"),
      );

      expect(result?.passed).toBe(false);
      expect(result?.verdict).toBe("request_changes");
      expect(result?.reviewers[1]?.status).toBe("failed");
    }),
  );

  it.effect("passes any-approve with one approval and records unresolved models", () =>
    Effect.gen(function* () {
      const result = yield* runReview(
        [
          makeInstance({
            id: "codex_review",
            models: ["gpt-5.6-sol"],
            review: () => Effect.succeed({ verdict: "approve", summary: "Fine.", findings: [] }),
          }),
        ],
        makeConfig(["gpt-5.6-sol", "missing-model"], "any-approve"),
      );

      expect(result?.passed).toBe(true);
      expect(result?.reviewers[1]?.status).toBe("failed");
      expect(result?.reviewers[1]?.error).toContain("No enabled provider instance");
    }),
  );

  it.effect("keeps advisory non-blocking and normalizes blocking findings", () =>
    Effect.gen(function* () {
      const result = yield* runReview(
        [
          makeInstance({
            id: "cursor_review",
            models: ["cursor-reviewer"],
            review: () =>
              Effect.succeed({
                verdict: "approve",
                summary: "One blocking issue.",
                findings: [
                  {
                    severity: "blocking",
                    title: "  Unsafe fallback  ",
                    detail: "  The fallback bypasses the gate.  ",
                    path: " src/gate.ts ",
                  },
                ],
              }),
          }),
        ],
        makeConfig(["cursor-reviewer"], "advisory"),
      );

      expect(result?.passed).toBe(true);
      expect(result?.verdict).toBe("advisory");
      expect(result?.reviewers[0]?.verdict).toBe("request_changes");
      expect(result?.reviewers[0]?.findings[0]).toEqual({
        severity: "blocking",
        title: "Unsafe fallback",
        detail: "The fallback bypasses the gate.",
        path: "src/gate.ts",
      });
    }),
  );
});
