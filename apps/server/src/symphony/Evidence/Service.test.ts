import type {
  ChangedFileEvidence,
  EffectiveWorkflowConfig,
  NormalizedIssue,
  RunAttempt,
  RunAttemptStatus,
  WorkItem,
} from "@neokod/contracts";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  RunAttemptId,
  WorkItemId,
} from "@neokod/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeEvidenceService, type EvidenceServiceDeps } from "./Service.ts";

const makeConfig = (overrides: Partial<EffectiveWorkflowConfig> = {}): EffectiveWorkflowConfig => ({
  repositoryPath: "/repo",
  workflowPath: "/repo/WORKFLOW.md",
  trackerKind: "github",
  trackerRequiredLabels: [],
  trackerActiveStates: ["open"],
  trackerTerminalStates: ["closed"],
  trackerProvider: {},
  workspaceRoot: "/ws",
  autonomy: "execute",
  agentProvider: {
    instanceId: ProviderInstanceId.make("codex_default"),
    driver: ProviderDriverKind.make("codex"),
  },
  validationRequired: ["npm test"],
  validationTestPathPatterns: ["**/*.test.ts"],
  approvalsProtectedPaths: [],
  approvalsPolicies: [],
  ...overrides,
});

const makeWorkItem = (): WorkItem => ({
  id: WorkItemId.make("wi-1"),
  mode: "symphony",
  objective: "Implement issue",
  description: "desc",
  acceptanceCriteria: [],
  source: { kind: "manual" },
  lifecycle: "running",
  eligibilityReasons: [],
  evidence: null,
  createdAt: "2026-08-05T00:00:00.000Z",
  updatedAt: "2026-08-05T00:00:00.000Z",
});

const makeIssue = (): NormalizedIssue => ({
  id: "issue-1",
  nativeRef: null,
  identifier: "#1",
  title: "Implement issue",
  description: null,
  priority: null,
  state: "open",
  branchName: null,
  url: null,
  assigneeId: null,
  labels: [],
  blockedBy: [],
  dispatchable: true,
  createdAt: null,
  updatedAt: null,
});

const makeRunAttempt = (status: RunAttemptStatus = "succeeded"): RunAttempt => ({
  id: RunAttemptId.make("run-1"),
  workItemId: WorkItemId.make("wi-1"),
  attemptNumber: 1,
  workspacePath: "/ws/key-1",
  provider: {
    instanceId: ProviderInstanceId.make("codex_default"),
    driver: ProviderDriverKind.make("codex"),
  },
  model: "gpt-5",
  status,
  startedAt: "2026-08-05T00:00:00.000Z",
  finishedAt: "2026-08-05T00:10:00.000Z",
  error: null,
});

const DIFF_PATCH = `diff --git a/src/lib.ts b/src/lib.ts
--- a/src/lib.ts
+++ b/src/lib.ts
@@ -1,3 +1,5 @@
 line
+added
+more
-removed
diff --git a/src/lib.test.ts b/src/lib.test.ts
new file mode 100644
--- /dev/null
+++ b/src/lib.test.ts
@@ -0,0 +1,2 @@
+test 1
+test 2
`;

const COMMITS = `abc1234|2026-08-05T01:00:00.000Z|Implement feature
def5678|2026-08-05T02:00:00.000Z|Fix lint
`;

const makeDeps = (overrides: Partial<EvidenceServiceDeps> = {}): EvidenceServiceDeps => ({
  git: {
    readRangeContext: () =>
      Effect.succeed({
        commitSummary: "abc1234 Implement feature\ndef5678 Fix lint\n",
        diffSummary: "2 files changed",
        diffPatch: DIFF_PATCH,
      }),
    execute: (input: { readonly args: ReadonlyArray<string> }) => {
      if (input.args[0] === "log") {
        return Effect.succeed({
          exitCode: 0,
          stdout: COMMITS,
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        });
      }
      return Effect.fail(new Error("unexpected git call") as never);
    },
  } as unknown as EvidenceServiceDeps["git"],
  nowIsoEffect: () => Effect.succeed("2026-08-05T03:00:00.000Z"),
  ...overrides,
});

const EVIDENCE_FILE = `# Implementation Summary
Implemented the feature with caching.

## Assumptions
- Cache invalidation is out of scope

## Risks
- [high] New caching layer may regress cold starts

## Unresolved
- Benchmark cold-start latency
`;

it.effect("assembles host-derived changed files and commits", () =>
  Effect.gen(function* () {
    const bundle = yield* makeEvidenceService(makeDeps()).assemble({
      workItem: makeWorkItem(),
      issue: makeIssue(),
      runAttempt: makeRunAttempt(),
      config: makeConfig(),
      workspacePath: "/ws/key-1",
      baseBranch: "main",
      branch: "symphony/issue-1",
      validationResults: [{ command: "npm test", status: "passed", exitCode: 0 }],
      evidenceFileContent: EVIDENCE_FILE,
    });
    expect(bundle.objective).toBe("Implement issue");
    expect(bundle.changedFiles).toEqual([
      { path: "src/lib.test.ts", additions: 2, deletions: 0 },
      { path: "src/lib.ts", additions: 2, deletions: 1 },
    ]);
    expect(bundle.testsChanged).toEqual([{ path: "src/lib.test.ts", additions: 2, deletions: 0 }]);
    expect(bundle.commits).toEqual([
      { sha: "abc1234", message: "Implement feature", authoredAt: "2026-08-05T01:00:00.000Z" },
      { sha: "def5678", message: "Fix lint", authoredAt: "2026-08-05T02:00:00.000Z" },
    ]);
    expect(bundle.overallAssessment).toBe("ready_with_warnings");
  }),
);

it.effect("parses the agent handoff file", () =>
  Effect.gen(function* () {
    const bundle = yield* makeEvidenceService(makeDeps()).assemble({
      workItem: makeWorkItem(),
      issue: makeIssue(),
      runAttempt: makeRunAttempt(),
      config: makeConfig(),
      workspacePath: "/ws/key-1",
      baseBranch: "main",
      branch: "symphony/issue-1",
      validationResults: [],
      evidenceFileContent: EVIDENCE_FILE,
    });
    expect(bundle.implementationSummary).toContain("Implemented the feature with caching.");
    expect(bundle.assumptions).toEqual([
      { text: "Cache invalidation is out of scope", source: "agent" },
    ]);
    expect(bundle.risks).toEqual([
      { severity: "high", text: "New caching layer may regress cold starts", source: "agent" },
    ]);
    expect(bundle.unresolved).toEqual([{ text: "Benchmark cold-start latency", source: "agent" }]);
  }),
);

it.effect("assesses failed when a required validation failed", () =>
  Effect.gen(function* () {
    const bundle = yield* makeEvidenceService(makeDeps()).assemble({
      workItem: makeWorkItem(),
      issue: makeIssue(),
      runAttempt: makeRunAttempt(),
      config: makeConfig(),
      workspacePath: "/ws/key-1",
      baseBranch: "main",
      branch: "symphony/issue-1",
      validationResults: [{ command: "npm test", status: "failed", exitCode: 1 }],
      evidenceFileContent: EVIDENCE_FILE,
    });
    expect(bundle.overallAssessment).toBe("failed");
  }),
);

it.effect("assesses insufficient when the handoff file is missing", () =>
  Effect.gen(function* () {
    const bundle = yield* makeEvidenceService(makeDeps()).assemble({
      workItem: makeWorkItem(),
      issue: makeIssue(),
      runAttempt: makeRunAttempt(),
      config: makeConfig(),
      workspacePath: "/ws/key-1",
      baseBranch: "main",
      branch: "symphony/issue-1",
      validationResults: [{ command: "npm test", status: "passed", exitCode: 0 }],
      evidenceFileContent: null,
    });
    expect(bundle.overallAssessment).toBe("insufficient");
    expect(bundle.implementationSummary).toBeUndefined();
    expect(bundle.assumptions).toEqual([]);
  }),
);

it.effect("assesses ready_for_review when clean", () =>
  Effect.gen(function* () {
    const bundle = yield* makeEvidenceService(makeDeps()).assemble({
      workItem: makeWorkItem(),
      issue: makeIssue(),
      runAttempt: makeRunAttempt(),
      config: makeConfig(),
      workspacePath: "/ws/key-1",
      baseBranch: "main",
      branch: "symphony/issue-1",
      validationResults: [{ command: "npm test", status: "passed", exitCode: 0 }],
      evidenceFileContent: "# Implementation Summary\nDone.\n",
    });
    expect(bundle.overallAssessment).toBe("ready_for_review");
  }),
);

it.effect("handles git failures by degrading to empty host inventories", () =>
  Effect.gen(function* () {
    const deps = makeDeps({
      git: {
        readRangeContext: () => Effect.fail(new Error("not a repo") as never),
        execute: () => Effect.fail(new Error("not a repo") as never),
      } as unknown as EvidenceServiceDeps["git"],
    });
    const bundle = yield* makeEvidenceService(deps).assemble({
      workItem: makeWorkItem(),
      issue: makeIssue(),
      runAttempt: makeRunAttempt(),
      config: makeConfig(),
      workspacePath: "/ws/key-1",
      baseBranch: "main",
      branch: "symphony/issue-1",
      validationResults: [],
      evidenceFileContent: EVIDENCE_FILE,
    });
    expect(bundle.changedFiles).toEqual([]);
    expect(bundle.commits).toEqual([]);
  }),
);

it.effect("carries token usage and duration from the run attempt", () =>
  Effect.gen(function* () {
    const attempt = makeRunAttempt();
    const bundle = yield* makeEvidenceService(makeDeps()).assemble({
      workItem: makeWorkItem(),
      issue: makeIssue(),
      runAttempt: { ...attempt, tokenUsage: { totalTokens: 42 } },
      config: makeConfig(),
      workspacePath: "/ws/key-1",
      baseBranch: "main",
      branch: "symphony/issue-1",
      validationResults: [],
      evidenceFileContent: EVIDENCE_FILE,
    });
    expect(bundle.totalDurationMs).toBe(600_000);
    expect(bundle.tokenUsage).toEqual({ totalTokens: 42 });
    expect(bundle.agent).toBe("codex");
    expect(bundle.model).toBe("gpt-5");
  }),
);

it("ChangedFileEvidence does not require a status", () => {
  const file: ChangedFileEvidence = { path: "a.ts", additions: 1, deletions: 0 };
  expect(file.status).toBeUndefined();
});
