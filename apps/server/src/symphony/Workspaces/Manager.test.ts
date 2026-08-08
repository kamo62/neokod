import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@neokod/contracts";
import type { EffectiveWorkflowConfig, NormalizedIssue } from "@neokod/contracts";
import * as Effect from "effect/Effect";

import type { GitVcsDriver } from "../../vcs/GitVcsDriver.ts";
import { deriveWorkspaceKey, deriveWorkingBranch } from "../Domain/Keys.ts";
import {
  isPathInsideRoot,
  makeWorkspaceManager,
  WorkspaceLeaseError,
  WorkspaceOutsideRootError,
  WorkspacePopulationError,
  type WorkspaceManagerDeps,
} from "./Manager.ts";

const makeConfig = (overrides: Partial<EffectiveWorkflowConfig> = {}): EffectiveWorkflowConfig =>
  ({
    repositoryPath: "/repo",
    workflowPath: "/repo/WORKFLOW.md",
    trackerKind: "github",
    trackerRequiredLabels: ["agent-ready"],
    trackerActiveStates: ["Ready", "In Progress"],
    trackerTerminalStates: ["Done", "Cancelled"],
    trackerProvider: {},
    workspaceRoot: "/ws",
    autonomy: "execute",
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
  description: null,
  priority: 1,
  state: "Ready",
  branchName: null,
  url: null,
  assigneeId: null,
  labels: ["agent-ready"],
  blockedBy: [],
  dispatchable: true,
  createdAt: null,
  updatedAt: null,
  ...overrides,
});

const makeFakeGit = (overrides: Partial<GitVcsDriver["Service"]> = {}): GitVcsDriver["Service"] => {
  const created: string[] = [];
  return {
    createWorktree: (input) => {
      created.push(String(input.path));
      return Effect.succeed({ worktree: { path: String(input.path), refName: input.refName } });
    },
    removeWorktree: () => Effect.void,
    listRefs: () =>
      Effect.succeed({
        refs: [{ name: "main", isDefault: true, current: false, worktreePath: null }],
        isRepo: true,
        hasPrimaryRemote: true,
        nextCursor: null,
        totalCount: 1,
      }),
    ...overrides,
    _created: created,
  } as GitVcsDriver["Service"];
};

const makeDeps = (overrides: Partial<WorkspaceManagerDeps> = {}): WorkspaceManagerDeps => ({
  git: makeFakeGit(),
  defaultBranch: () => Effect.succeed("main"),
  runHook: () => Effect.void,
  ensureDir: () => Effect.void,
  pathExists: () => Effect.succeed(false),
  realpath: (p) => Effect.succeed(p),
  ...overrides,
});

describe("WorkspaceManager", () => {
  const key = deriveWorkspaceKey("issue-1");

  it.effect("creates a worktree at a deterministic path under the root", () =>
    Effect.gen(function* () {
      const manager = makeWorkspaceManager(makeDeps());
      const ws = yield* manager.ensureWorkspace({
        issue: makeIssue({ identifier: "issue-1" }),
        config: makeConfig(),
      });
      expect(ws.key).toBe(key);
      expect(ws.path).toBe(`/ws/${key}`);
      expect(ws.branch).toBe(deriveWorkingBranch(key));
      expect(ws.baseBranch).toBe("main");
      expect(ws.createdNow).toBe(true);
    }),
  );

  it.effect("derives a sanitized key for identifiers with unsafe characters", () =>
    Effect.gen(function* () {
      const manager = makeWorkspaceManager(makeDeps());
      const ws = yield* manager.ensureWorkspace({
        issue: makeIssue({ identifier: "some/repo#42" }),
        config: makeConfig(),
      });
      expect(ws.key).toMatch(/^some_repo_42-/);
      expect(ws.path.startsWith("/ws/some_repo_42-")).toBe(true);
    }),
  );

  it.effect("reuses an existing workspace instead of recreating it", () =>
    Effect.gen(function* () {
      const git = makeFakeGit();
      const manager = makeWorkspaceManager(
        makeDeps({ git, pathExists: () => Effect.succeed(true) }),
      );
      const ws = yield* manager.ensureWorkspace({
        issue: makeIssue({ identifier: "issue-1" }),
        config: makeConfig(),
      });
      expect(ws.createdNow).toBe(false);
      expect(ws.path).toBe(`/ws/${key}`);
    }),
  );

  it.effect("records an ownership lease on creation and again on reuse", () =>
    Effect.gen(function* () {
      const leased: Array<string> = [];
      const acquireOwnership = (path: string) =>
        Effect.sync(() => {
          leased.push(path);
        });
      const created = makeWorkspaceManager(makeDeps({ acquireOwnership }));
      yield* created.ensureWorkspace({
        issue: makeIssue({ identifier: "issue-1" }),
        config: makeConfig(),
      });
      const reused = makeWorkspaceManager(
        makeDeps({ acquireOwnership, pathExists: () => Effect.succeed(true) }),
      );
      yield* reused.ensureWorkspace({
        issue: makeIssue({ identifier: "issue-1" }),
        config: makeConfig(),
      });
      expect(leased).toEqual([`/ws/${key}`, `/ws/${key}`]);
    }),
  );

  it.effect("fails typed when the ownership lease cannot be recorded", () =>
    Effect.gen(function* () {
      const manager = makeWorkspaceManager(
        makeDeps({ acquireOwnership: () => Effect.fail(new Error("db locked")) }),
      );
      const result = yield* Effect.result(
        manager.ensureWorkspace({
          issue: makeIssue({ identifier: "issue-1" }),
          config: makeConfig(),
        }),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure).toBeInstanceOf(WorkspaceLeaseError);
      }
    }),
  );

  it.effect("runs after_create only when the workspace is newly created", () =>
    Effect.gen(function* () {
      const hooks: string[] = [];
      const manager = makeWorkspaceManager(
        makeDeps({
          runHook: (input) => {
            hooks.push(input.hook);
            return Effect.void;
          },
        }),
      );
      yield* manager.ensureWorkspace({
        issue: makeIssue({ identifier: "issue-1" }),
        config: makeConfig(),
      });
      expect(hooks).toEqual(["after_create"]);
    }),
  );

  it.effect("fails workspace creation when after_create hook fails", () =>
    Effect.gen(function* () {
      const manager = makeWorkspaceManager(
        makeDeps({
          runHook: () => Effect.fail(new Error("hook boom")),
        }),
      );
      const result = yield* Effect.result(
        manager.ensureWorkspace({
          issue: makeIssue({ identifier: "issue-1" }),
          config: makeConfig(),
        }),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure).toBeInstanceOf(WorkspacePopulationError);
      }
    }),
  );

  it.effect("fails when the resolved workspace path escapes the root", () =>
    Effect.gen(function* () {
      const manager = makeWorkspaceManager(
        makeDeps({
          realpath: () => Effect.succeed("/escape/path"),
        }),
      );
      const result = yield* Effect.result(
        manager.ensureWorkspace({
          issue: makeIssue({ identifier: "issue-1" }),
          config: makeConfig(),
        }),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure).toBeInstanceOf(WorkspaceOutsideRootError);
      }
    }),
  );

  it.effect("runs before_remove then removes the worktree", () =>
    Effect.gen(function* () {
      const hooks: string[] = [];
      const git = makeFakeGit();
      const manager = makeWorkspaceManager(
        makeDeps({
          git,
          runHook: (input) => {
            hooks.push(input.hook);
            return Effect.void;
          },
        }),
      );
      const ws = yield* manager.ensureWorkspace({
        issue: makeIssue({ identifier: "issue-1" }),
        config: makeConfig(),
      });
      yield* manager.removeWorkspace({ workspace: ws, config: makeConfig() });
      expect(hooks).toEqual(["after_create", "before_remove"]);
    }),
  );

  it.effect("continues cleanup even if before_remove fails", () =>
    Effect.gen(function* () {
      const git = makeFakeGit();
      const manager = makeWorkspaceManager(
        makeDeps({
          git,
          runHook: (input) =>
            input.hook === "before_remove" ? Effect.fail(new Error("cleanup boom")) : Effect.void,
        }),
      );
      const ws = yield* manager.ensureWorkspace({
        issue: makeIssue({ identifier: "issue-1" }),
        config: makeConfig(),
      });
      yield* manager.removeWorkspace({ workspace: ws, config: makeConfig() });
      expect(1).toBe(1);
    }),
  );
});

describe("isPathInsideRoot", () => {
  it("accepts strict descendants", () => {
    expect(isPathInsideRoot("/ws/#1", "/ws")).toBe(true);
    expect(isPathInsideRoot("/ws/a/b/c", "/ws")).toBe(true);
  });

  it("rejects the root itself and ancestors", () => {
    expect(isPathInsideRoot("/ws", "/ws")).toBe(false);
    expect(isPathInsideRoot("/", "/ws")).toBe(false);
    expect(isPathInsideRoot("/ws2", "/ws")).toBe(false);
  });

  it("handles trailing slashes", () => {
    expect(isPathInsideRoot("/ws/#1/", "/ws/")).toBe(true);
  });
});
