import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@neokod/contracts";
import type { EffectiveWorkflowConfig, NormalizedIssue } from "@neokod/contracts";
import * as Effect from "effect/Effect";

import { projectWorkItem, workItemIdForIssue } from "./Projection.ts";

const makeConfig = (overrides: Partial<EffectiveWorkflowConfig> = {}): EffectiveWorkflowConfig =>
  ({
    repositoryPath: "/repo",
    workflowPath: "/repo/WORKFLOW.md",
    trackerKind: "github",
    trackerRequiredLabels: ["agent-ready"],
    trackerActiveStates: ["Ready"],
    trackerTerminalStates: ["Done"],
    trackerProvider: {},
    workspaceRoot: "/ws",
    autonomy: "observe",
    agentProvider: {
      instanceId: ProviderInstanceId.make("codex_default"),
      driver: ProviderDriverKind.make("codex"),
    },
    ...overrides,
  }) as EffectiveWorkflowConfig;

const makeIssue = (overrides: Partial<NormalizedIssue> = {}): NormalizedIssue => ({
  id: "1",
  nativeRef: null,
  identifier: "#1",
  title: "Fix bug",
  description: "The login form rejects valid passwords.",
  priority: 0,
  state: "Ready",
  branchName: "fix-login",
  url: "https://github.com/owner/repo/issues/1",
  assigneeId: null,
  labels: ["agent-ready"],
  blockedBy: [{ id: "2", identifier: "#2", state: "open" }],
  dispatchable: true,
  createdAt: null,
  updatedAt: null,
  ...overrides,
});

const eligibility = { reasons: [] } as never;

const project = (issue: NormalizedIssue, config: EffectiveWorkflowConfig = makeConfig()) =>
  projectWorkItem(issue, config, eligibility, "2026-08-04T00:00:00Z");

describe("projectWorkItem", () => {
  it.effect("accumulates description, branch, priority, and blocked onto one row", () =>
    Effect.gen(function* () {
      const run = yield* project(makeIssue());
      expect(run.baseBranch).toBe("fix-login");
      expect(run.priority).toBe(0);
      expect(run.blocked).toBe(true);
      expect(run.description).toBe("The login form rejects valid passwords.");
    }),
  );

  it.effect("keeps branch and priority when a description is present (no short-circuit)", () =>
    Effect.gen(function* () {
      const run = yield* project(makeIssue({ description: "Body only." }));
      expect(run.baseBranch).toBe("fix-login");
      expect(run.priority).toBe(0);
      expect(run.blocked).toBe(true);
    }),
  );

  it.effect("omits absent fields", () =>
    Effect.gen(function* () {
      const run = yield* project(
        makeIssue({
          description: null,
          branchName: null,
          priority: null,
          blockedBy: [],
        }),
      );
      expect(run.baseBranch).toBeUndefined();
      expect(run.priority).toBeUndefined();
      expect(run.blocked).toBeUndefined();
      expect(run.description).toBeUndefined();
    }),
  );

  it("derives a deterministic work-item id from tracker kind and issue id", () => {
    expect(workItemIdForIssue("github", "1")).toBe("github:1");
  });
});
