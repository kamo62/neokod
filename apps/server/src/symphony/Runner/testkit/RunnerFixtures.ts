/**
 * Shared fixtures for Symphony runner flow tests.
 *
 * Copies of the dispatcher test setup, so W1 cards build on one fake
 * workspace manager, one test config shape and one queued-item seeder.
 * Test-only.
 */
import type { EffectiveWorkflowConfig, NormalizedIssue, WorkItem } from "@neokod/contracts";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  SymphonyProjectId,
  WorkItemId,
} from "@neokod/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { deriveWorkspaceKey } from "../../Domain/Keys.ts";
import { nowIso } from "../../Domain/Time.ts";
import { ServerConfig } from "../../../config.ts";
import { WorkItemRepository } from "../../Persistence/Services/WorkItemRepository.ts";
import { WorkspaceManager } from "../../Workspaces/Manager.ts";

export const makeRunnerTestConfig = (
  overrides?: Partial<EffectiveWorkflowConfig>,
): EffectiveWorkflowConfig =>
  ({
    repositoryPath: "/repo",
    workflowPath: "/repo/WORKFLOW.md",
    trackerKind: "github",
    trackerRequiredLabels: ["agent-ready"],
    trackerActiveStates: ["open"],
    trackerTerminalStates: ["closed"],
    trackerProvider: {},
    workspaceRoot: "/ws",
    autonomy: "execute",
    agentProvider: {
      instanceId: ProviderInstanceId.make("codex_default"),
      driver: ProviderDriverKind.make("codex"),
    },
    validationRequired: [],
    validationTestPathPatterns: [],
    approvalsProtectedPaths: [],
    approvalsPolicies: [],
    ...overrides,
  }) as EffectiveWorkflowConfig;

export const makeRunnerTestIssue = (id: string): NormalizedIssue => ({
  id,
  nativeRef: null,
  identifier: `#${id}`,
  title: `Issue ${id}`,
  description: null,
  priority: 1,
  state: "open",
  branchName: null,
  url: null,
  assigneeId: null,
  labels: ["agent-ready"],
  blockedBy: [],
  dispatchable: true,
  createdAt: null,
  updatedAt: null,
});

export const seedQueuedWorkItem = (id: string) =>
  Effect.gen(function* () {
    const workItems = yield* WorkItemRepository;
    const now = yield* nowIso;
    const workItem: WorkItem = {
      id: WorkItemId.make(id),
      mode: "symphony",
      projectId: SymphonyProjectId.make("dispatcher-project"),
      objective: `Implement issue ${id}`,
      description: "Seeded for runner flow tests",
      acceptanceCriteria: [],
      source: { kind: "manual" },
      trackerIssueId: id,
      lifecycle: "queued",
      priority: 1,
      eligibilityReasons: [],
      evidence: null,
      createdAt: now,
      updatedAt: now,
    };
    yield* workItems.upsert(workItem);
    return workItem;
  });

export const fakeWorkspaceManagerLayer = (options?: {
  readonly createdNow?: boolean;
  readonly ensureWorkspace?: WorkspaceManager["Service"]["ensureWorkspace"];
}): Layer.Layer<WorkspaceManager> =>
  Layer.succeed(
    WorkspaceManager,
    options?.ensureWorkspace !== undefined
      ? {
          ensureWorkspace: options.ensureWorkspace,
          removeWorkspace: () => Effect.void,
          hasCommittedHandoff: () => Effect.succeed(false),
          resolvePath: () => "/ws",
        }
      : {
          ensureWorkspace: (input: { readonly issue: NormalizedIssue }) =>
            Effect.succeed({
              key: deriveWorkspaceKey(input.issue.identifier),
              path: `/ws/${input.issue.identifier}`,
              branch: `symphony/${input.issue.identifier}`,
              baseBranch: "main",
              createdNow: options?.createdNow ?? true,
            }),
          removeWorkspace: () => Effect.void,
          hasCommittedHandoff: () => Effect.succeed(false),
          resolvePath: () => "/ws",
        },
  );

export const testServerConfigLayer = Layer.succeed(ServerConfig, {
  symphonyLogsDir: "/logs/symphony",
} as ServerConfig["Service"]);
