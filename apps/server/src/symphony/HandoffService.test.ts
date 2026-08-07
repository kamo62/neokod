import type { RunAttempt, WorkItem } from "@neokod/contracts";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  RunAttemptId,
  WorkflowId,
  WorkItemId,
} from "@neokod/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { nowIso } from "./Domain/Time.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { WorkItemRepository } from "./Persistence/Services/WorkItemRepository.ts";
import { WorkItemRepositoryLive } from "./Persistence/Layers/WorkItemRepository.ts";
import { RunAttemptRepository } from "./Persistence/Services/RunAttemptRepository.ts";
import { RunAttemptRepositoryLive } from "./Persistence/Layers/RunAttemptRepository.ts";
import { RunEventRepository } from "./Persistence/Services/RunEventRepository.ts";
import { RunEventRepositoryLive } from "./Persistence/Layers/RunEventRepository.ts";
import { WorkflowRepository } from "./Persistence/Services/WorkflowRepository.ts";
import { WorkflowRepositoryLive } from "./Persistence/Layers/WorkflowRepository.ts";
import { WorkspaceOwnershipRepository } from "./Persistence/Services/WorkspaceOwnershipRepository.ts";
import { WorkspaceOwnershipRepositoryLive } from "./Persistence/Layers/WorkspaceOwnershipRepository.ts";
import { RunDispatcher } from "./Runner/Dispatcher.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { LiveRequestsLive } from "./Runner/LiveRequests.ts";
import { HandoffService, HandoffServiceLive } from "./HandoffService.ts";
import type { WorkspaceOwnershipRecord } from "./Persistence/Services/WorkspaceOwnershipRepository.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as Option from "effect/Option";

const makeAttempt = (id: string, workItemId: string, workspacePath = "/ws/wi-1"): RunAttempt => ({
  id: RunAttemptId.make(id),
  workItemId: WorkItemId.make(workItemId),
  attemptNumber: 1,
  workspacePath,
  provider: {
    instanceId: ProviderInstanceId.make("codex_default"),
    driver: ProviderDriverKind.make("codex"),
  },
  status: "streaming_turn",
  startedAt: "2026-08-05T00:00:00.000Z",
  finishedAt: null,
  error: null,
});

const makeWorkItem = (id: string, lifecycle: WorkItem["lifecycle"] = "running"): WorkItem => ({
  id: WorkItemId.make(id),
  mode: "symphony",
  objective: `Issue ${id}`,
  acceptanceCriteria: [],
  source: { kind: "manual" },
  trackerIssueId: `manual-${id}`,
  lifecycle,
  priority: 1,
  eligibilityReasons: [],
  evidence: null,
  createdAt: "2026-08-05T00:00:00.000Z",
  updatedAt: "2026-08-05T00:00:00.000Z",
});

const seedWorkflow = (repositoryPath: string) =>
  Effect.gen(function* () {
    const workflows = yield* WorkflowRepository;
    const now = yield* nowIso;
    yield* workflows.upsert({
      id: WorkflowId.make("wf-handoff-1"),
      repositoryPath,
      workflowPath: `${repositoryPath}/WORKFLOW.md`,
      status: "active",
      autonomy: "execute",
      validationError: null,
      definition: { config: {}, promptTemplate: "Implement." },
      effectiveConfig: null,
      enabledAt: now,
      createdAt: now,
      updatedAt: now,
    });
  });

const fakeDispatcher = Layer.effect(
  RunDispatcher,
  Effect.gen(function* () {
    const attempts = yield* RunAttemptRepository;
    return {
      dispatchWorkItem: () => Effect.never,
      cancelRun: (runAttemptId) =>
        attempts
          .updateStatus(runAttemptId, "user_cancelled", {
            finishedAt: "2026-08-05T01:00:00.000Z",
          })
          .pipe(Effect.catch(() => Effect.void)),
      isAgentActive: () => Effect.succeed(false),
    } satisfies RunDispatcher["Service"];
  }),
);

// Fake git: the takeover workspace checks out the branch derived from its
// leaf directory name, matching deriveThreadBranch's fallback.
const fakeGitLayer = Layer.succeed(GitVcsDriver, {
  status: (input: { readonly cwd: string }) => {
    const segments = input.cwd.split("/").filter((segment) => segment.length > 0);
    const leaf = segments[segments.length - 1] ?? "workspace";
    return Effect.succeed({
      isRepo: true,
      refName: `symphony/${leaf}`,
      hasPrimaryRemote: false,
      isDefaultRef: false,
      hasWorkingTreeChanges: false,
      workingTree: { files: [], untrackedFiles: [] },
    });
  },
} as unknown as GitVcsDriver["Service"]);

// Fake engine: records dispatched commands so the binding tests can assert
// real thread/project creation.
const dispatchedCommands: Array<{ readonly type: string; readonly worktreePath: unknown }> = [];

const fakeEngineLayer = Layer.succeed(OrchestrationEngine.OrchestrationEngineService, {
  dispatch: (command: { readonly type: string; readonly worktreePath?: unknown }) =>
    Effect.sync(() => {
      dispatchedCommands.push({
        type: command.type,
        worktreePath: command.worktreePath,
      });
    }),
} as unknown as OrchestrationEngine.OrchestrationEngineService["Service"]);

const fakeProjectionLayer = Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
  getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
  getThreadShellById: (threadId: string) =>
    Effect.succeed(
      threadId === "th-1" || threadId === "th-4" || threadId === "th-5"
        ? Option.some({ worktreePath: "/ws/wi-1" })
        : Option.none(),
    ),
} as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]);

const layer = it.layer(
  HandoffServiceLive.pipe(
    Layer.provideMerge(WorkItemRepositoryLive),
    Layer.provideMerge(RunAttemptRepositoryLive),
    Layer.provideMerge(RunEventRepositoryLive),
    Layer.provideMerge(WorkflowRepositoryLive),
    Layer.provideMerge(WorkspaceOwnershipRepositoryLive),
    Layer.provideMerge(fakeDispatcher.pipe(Layer.provide(RunAttemptRepositoryLive))),
    Layer.provideMerge(LiveRequestsLive),
    Layer.provideMerge(fakeGitLayer),
    Layer.provideMerge(fakeEngineLayer),
    Layer.provideMerge(fakeProjectionLayer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const bindingLayer = it.layer(
  HandoffServiceLive.pipe(
    Layer.provideMerge(WorkItemRepositoryLive),
    Layer.provideMerge(RunAttemptRepositoryLive),
    Layer.provideMerge(RunEventRepositoryLive),
    Layer.provideMerge(WorkflowRepositoryLive),
    Layer.provideMerge(WorkspaceOwnershipRepositoryLive),
    Layer.provideMerge(fakeDispatcher.pipe(Layer.provide(RunAttemptRepositoryLive))),
    Layer.provideMerge(LiveRequestsLive),
    Layer.provideMerge(fakeGitLayer),
    Layer.provideMerge(fakeEngineLayer),
    Layer.provideMerge(fakeProjectionLayer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

layer("HandoffService takeOver", (it) => {
  it.effect("fails when the workspace is held by another owner", () =>
    Effect.gen(function* () {
      const workItem = makeWorkItem("wi-2");
      yield* WorkItemRepository.pipe(Effect.flatMap((repo) => repo.upsert(workItem)));
      const attempts = yield* RunAttemptRepository;
      yield* attempts.create(makeAttempt("run-2", "wi-2", "/ws/wi-2"));
      const ownership = yield* WorkspaceOwnershipRepository;
      yield* ownership.acquire({ workspacePath: "/ws/wi-2", owner: "work", threadId: "th-other" });

      const handoff = yield* HandoffService;
      const result = yield* Effect.result(
        handoff.takeOver({ runAttemptId: "run-2", threadId: "th-2" }),
      );
      expect(result._tag).toBe("Failure");
    }),
  );
});

const driftBindingLayer = it.layer(
  HandoffServiceLive.pipe(
    Layer.provideMerge(WorkItemRepositoryLive),
    Layer.provideMerge(RunAttemptRepositoryLive),
    Layer.provideMerge(RunEventRepositoryLive),
    Layer.provideMerge(WorkflowRepositoryLive),
    Layer.provideMerge(WorkspaceOwnershipRepositoryLive),
    Layer.provideMerge(fakeDispatcher.pipe(Layer.provide(RunAttemptRepositoryLive))),
    Layer.provideMerge(LiveRequestsLive),
    Layer.provideMerge(
      Layer.succeed(GitVcsDriver, {
        status: () =>
          Effect.succeed({
            isRepo: true,
            refName: "main",
            hasPrimaryRemote: false,
            isDefaultRef: true,
            hasWorkingTreeChanges: false,
            workingTree: { files: [], untrackedFiles: [] },
          }),
      } as unknown as GitVcsDriver["Service"]),
    ),
    Layer.provideMerge(fakeEngineLayer),
    Layer.provideMerge(fakeProjectionLayer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

driftBindingLayer("HandoffService takeover drift", (it) => {
  it.effect("aborts before transferring ownership when the branch drifted", () =>
    Effect.gen(function* () {
      const handoff = yield* HandoffService;
      const workItem = makeWorkItem("wi-7");
      yield* WorkItemRepository.pipe(Effect.flatMap((repo) => repo.upsert(workItem)));
      const attempts = yield* RunAttemptRepository;
      yield* attempts.create(makeAttempt("run-7", "wi-7", "/ws/wi-7"));
      const ownership = yield* WorkspaceOwnershipRepository;
      yield* ownership.acquire({
        workspacePath: "/ws/wi-7",
        owner: "symphony",
        workItemId: WorkItemId.make("wi-7"),
      });

      const result = yield* Effect.result(handoff.takeOver({ runAttemptId: "run-7" }));
      expect(result._tag).toBe("Failure");

      const record = yield* ownership.getByWorkspacePath("/ws/wi-7");
      expect(record?.owner).toBe("symphony");
    }),
  );
});

bindingLayer("HandoffService takeOver thread binding", (it) => {
  it.effect("stops the run, transfers ownership to work and parks the item", () =>
    Effect.gen(function* () {
      const workItem = makeWorkItem("wi-1");
      yield* WorkItemRepository.pipe(Effect.flatMap((repo) => repo.upsert(workItem)));
      const attempts = yield* RunAttemptRepository;
      const attempt = makeAttempt("run-1", "wi-1");
      yield* attempts.create(attempt);
      const ownership = yield* WorkspaceOwnershipRepository;
      yield* ownership.acquire({
        workspacePath: "/ws/wi-1",
        owner: "symphony",
        workItemId: WorkItemId.make("wi-1"),
      });

      const handoff = yield* HandoffService;
      const result = yield* handoff.takeOver({ runAttemptId: "run-1", threadId: "th-1" });

      expect(result.workspacePath).toBe("/ws/wi-1");
      expect(result.threadId).toBe("th-1");

      const cancelled = yield* attempts.getById(RunAttemptId.make("run-1"));
      expect(cancelled?.status).toBe("user_cancelled");

      const record = yield* ownership.getByWorkspacePath("/ws/wi-1");
      expect(record?.owner).toBe("work");
      expect(record?.threadId).toBe("th-1");

      const parked = yield* WorkItemRepository.pipe(
        Effect.flatMap((repo) => repo.getById(workItem.id)),
      );
      expect(parked?.lifecycle).toBe("blocked");

      const events = yield* RunEventRepository.pipe(
        Effect.flatMap((repo) => repo.listForAttempt(RunAttemptId.make("run-1"))),
      );
      expect(events.some((event) => event.eventType === "handed_over_to_work")).toBe(true);
    }),
  );

  it.effect("creates a Work thread bound to the workspace when no thread id is given", () =>
    Effect.gen(function* () {
      dispatchedCommands.length = 0;
      const workItem = makeWorkItem("wi-6");
      yield* WorkItemRepository.pipe(Effect.flatMap((repo) => repo.upsert(workItem)));
      const attempts = yield* RunAttemptRepository;
      yield* attempts.create(makeAttempt("run-6", "wi-6", "/ws/wi-6"));
      const ownership = yield* WorkspaceOwnershipRepository;
      yield* ownership.acquire({
        workspacePath: "/ws/wi-6",
        owner: "symphony",
        workItemId: WorkItemId.make("wi-6"),
      });

      const handoff = yield* HandoffService;
      const result = yield* handoff.takeOver({ runAttemptId: "run-6" });

      // A project and a thread were dispatched; the thread carries the
      // workspace path and the derived branch.
      const types = dispatchedCommands.map((command) => command.type);
      expect(types).toContain("project.create");
      expect(types).toContain("thread.create");
      const threadCreate = dispatchedCommands.find((command) => command.type === "thread.create");
      expect(threadCreate?.worktreePath).toBe("/ws/wi-6");

      expect(result.threadId).toMatch(/^[0-9a-f-]{36}$/);
      expect(result.workspacePath).toBe("/ws/wi-6");
      expect(result.branch).toBe("symphony/wi-6");

      const record = yield* ownership.getByWorkspacePath("/ws/wi-6");
      expect(record?.owner).toBe("work");
      expect(record?.threadId).toBe(result.threadId);
    }),
  );

  it.effect("rejects a caller-provided thread id that is not bound to the workspace", () =>
    Effect.gen(function* () {
      dispatchedCommands.length = 0;
      const workItem = makeWorkItem("wi-7");
      yield* WorkItemRepository.pipe(Effect.flatMap((repo) => repo.upsert(workItem)));
      const attempts = yield* RunAttemptRepository;
      yield* attempts.create(makeAttempt("run-7", "wi-7", "/ws/wi-7"));
      const ownership = yield* WorkspaceOwnershipRepository;
      yield* ownership.acquire({
        workspacePath: "/ws/wi-7",
        owner: "symphony",
        workItemId: WorkItemId.make("wi-7"),
      });

      const handoff = yield* HandoffService;
      const result = yield* Effect.result(
        handoff.takeOver({ runAttemptId: "run-7", threadId: "th-existing" }),
      );
      expect(result._tag).toBe("Failure");
      // Ownership must not have moved.
      const record = yield* ownership.getByWorkspacePath("/ws/wi-7");
      expect(record?.owner).toBe("symphony");
    }),
  );
});

layer("HandoffService resumeAutonomous", (it) => {
  it.effect("transfers ownership back and re-queues the work item", () =>
    Effect.gen(function* () {
      // The resumable shape: takeover parks the item as blocked, so resume
      // re-queues from blocked (never from running — audit item 1: a running
      // lifecycle means a live agent, and resume must not admit a second
      // agent into the same workspace).
      const workItem = makeWorkItem("wi-3", "blocked");
      yield* WorkItemRepository.pipe(Effect.flatMap((repo) => repo.upsert(workItem)));
      const attempts = yield* RunAttemptRepository;
      yield* attempts.create(makeAttempt("run-3", "wi-3", "/ws/wi-3"));
      const ownership = yield* WorkspaceOwnershipRepository;
      yield* ownership.acquire({
        workspacePath: "/ws/wi-3",
        owner: "work",
        workItemId: WorkItemId.make("wi-3"),
        threadId: "th-3",
      });

      const handoff = yield* HandoffService;
      yield* handoff.resumeAutonomous({ workItemId: "wi-3" });

      const record = yield* ownership.getByWorkspacePath("/ws/wi-3");
      expect(record?.owner).toBe("symphony");

      const resumed = yield* WorkItemRepository.pipe(
        Effect.flatMap((repo) => repo.getById(workItem.id)),
      );
      expect(resumed?.lifecycle).toBe("queued");
    }),
  );
});

const busyProjectionLayer = it.layer(
  HandoffServiceLive.pipe(
    Layer.provideMerge(WorkItemRepositoryLive),
    Layer.provideMerge(RunAttemptRepositoryLive),
    Layer.provideMerge(RunEventRepositoryLive),
    Layer.provideMerge(WorkflowRepositoryLive),
    Layer.provideMerge(WorkspaceOwnershipRepositoryLive),
    Layer.provideMerge(fakeDispatcher.pipe(Layer.provide(RunAttemptRepositoryLive))),
    Layer.provideMerge(LiveRequestsLive),
    Layer.provideMerge(fakeGitLayer),
    Layer.provideMerge(fakeEngineLayer),
    Layer.provideMerge(
      Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getThreadShellById: () =>
          Effect.succeed(
            Option.some({
              worktreePath: "/ws/wi-8",
              session: { status: "running" },
            }),
          ),
      } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]),
    ),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

busyProjectionLayer("HandoffService resume idleness", (it) => {
  it.effect("refuses to resume while the Work thread has an active session", () =>
    Effect.gen(function* () {
      // The projection reports the bound thread's session as running:
      // resume must abort (audit item 1 — a Work agent is mid-turn).
      const handoff = yield* HandoffService;
      const workItem = makeWorkItem("wi-8", "blocked");
      yield* WorkItemRepository.pipe(Effect.flatMap((repo) => repo.upsert(workItem)));
      const attempts = yield* RunAttemptRepository;
      yield* attempts.create(makeAttempt("run-8", "wi-8", "/ws/wi-8"));
      const ownership = yield* WorkspaceOwnershipRepository;
      yield* ownership.acquire({
        workspacePath: "/ws/wi-8",
        owner: "work",
        workItemId: WorkItemId.make("wi-8"),
        threadId: "th-8",
      });

      const result = yield* Effect.result(handoff.resumeAutonomous({ workItemId: "wi-8" }));
      expect(result._tag).toBe("Failure");

      // Ownership still with work: nothing transferred.
      const record = yield* ownership.getByWorkspacePath("/ws/wi-8");
      expect(record?.owner).toBe("work");
    }),
  );
});

layer("HandoffService delegateFromThread", (it) => {
  it.effect("creates a work item from thread input and binds the workflow", () =>
    Effect.gen(function* () {
      yield* seedWorkflow("/repo/handoff");
      const handoff = yield* HandoffService;
      const id = yield* handoff.delegateFromThread({
        threadId: "th-4",
        objective: "Fix the flaky test",
        repositoryPath: "/repo/handoff",
        branch: "fix/flaky",
        summary: "Summary from the thread",
        acceptanceCriteria: ["Test passes"],
      });

      const created = yield* WorkItemRepository.pipe(Effect.flatMap((repo) => repo.getById(id)));
      expect(created?.objective).toBe("Fix the flaky test");
      expect(created?.description).toBe("Summary from the thread");
      expect(created?.acceptanceCriteria).toEqual(["Test passes"]);
      expect(created?.baseBranch).toBe("fix/flaky");
      expect(created?.lifecycle).toBe("eligible");
      expect(created?.workflowId).toBe(WorkflowId.make("wf-handoff-1"));
    }),
  );

  it.effect("creates without a workflow when the repository is unknown", () =>
    Effect.gen(function* () {
      const handoff = yield* HandoffService;
      const id = yield* handoff.delegateFromThread({
        threadId: "th-5",
        objective: "Something else",
      });
      const created = yield* WorkItemRepository.pipe(Effect.flatMap((repo) => repo.getById(id)));
      expect(created?.workflowId).toBeUndefined();
    }),
  );
});

const _ownershipRecordType: WorkspaceOwnershipRecord | null = null;
void _ownershipRecordType;
