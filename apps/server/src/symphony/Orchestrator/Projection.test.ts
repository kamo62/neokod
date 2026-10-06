import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, SymphonyProjectId } from "@neokod/contracts";
import type { EffectiveWorkflowConfig, NormalizedIssue } from "@neokod/contracts";
import * as Effect from "effect/Effect";

import { projectWorkItem, resolveBaseBranch, workItemIdForIssue } from "./Projection.ts";

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
const PROJECT_ID = SymphonyProjectId.make("project-1");

const project = (issue: NormalizedIssue, config: EffectiveWorkflowConfig = makeConfig()) =>
  projectWorkItem(issue, config, eligibility, "2026-08-04T00:00:00Z", PROJECT_ID);

describe("projectWorkItem", () => {
  it.effect("accumulates description, priority, and blocked onto one row", () =>
    Effect.gen(function* () {
      const run = yield* project(makeIssue());
      expect(run.baseBranch).toBeUndefined();
      expect(run.priority).toBe(0);
      expect(run.blocked).toBe(true);
      expect(run.description).toBe("The login form rejects valid passwords.");
    }),
  );

  it.effect("keeps priority and blocked when a description is present", () =>
    Effect.gen(function* () {
      const run = yield* project(makeIssue({ description: "Body only." }));
      expect(run.baseBranch).toBeUndefined();
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

  it("derives a deterministic work-item id from project, tracker kind, and issue id", () => {
    expect(workItemIdForIssue(PROJECT_ID, "github", "1")).toBe("project-1:github:1");
  });

  it("resolveBaseBranch prefers the recorded dispatch branch", () => {
    expect(
      resolveBaseBranch({ baseBranch: "develop" }, {
        pullRequest: { baseBranch: "main" },
      } as never),
    ).toBe("develop");
  });

  it("resolveBaseBranch falls back to the stored PR evidence branch", () => {
    expect(resolveBaseBranch({}, { pullRequest: { baseBranch: "develop" } } as never)).toBe(
      "develop",
    );
  });

  it("resolveBaseBranch is undefined when neither records a base branch", () => {
    expect(resolveBaseBranch({}, null)).toBeUndefined();
    expect(resolveBaseBranch({}, { pullRequest: null } as never)).toBeUndefined();
  });
});
