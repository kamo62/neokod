import type { EffectiveWorkflowConfig, WorkItem, WorkflowRecord } from "@neokod/contracts";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  RunAttemptId,
  SymphonyProjectId,
  WorkflowId,
  WorkItemId,
} from "@neokod/contracts";
import type { ProcessBirthReader, ProcessGroupSignaller } from "@neokod/shared/processGroup";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { nowIso } from "../Domain/Time.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { WorkItemRepository } from "../Persistence/Services/WorkItemRepository.ts";
import { WorkItemRepositoryLive } from "../Persistence/Layers/WorkItemRepository.ts";
import { RunAttemptRepository } from "../Persistence/Services/RunAttemptRepository.ts";
import { RunAttemptRepositoryLive } from "../Persistence/Layers/RunAttemptRepository.ts";
import { RunEventRepository } from "../Persistence/Services/RunEventRepository.ts";
import { RunEventRepositoryLive } from "../Persistence/Layers/RunEventRepository.ts";
import { WorkflowRepository } from "../Persistence/Services/WorkflowRepository.ts";
import { WorkflowRepositoryLive } from "../Persistence/Layers/WorkflowRepository.ts";
import { RunDispatcher } from "../Runner/Dispatcher.ts";
import { reconcileStaleClaims } from "./Reconciler.ts";

const makeConfig = (repositoryPath: string): EffectiveWorkflowConfig => ({
  repositoryPath,
  workflowPath: `${repositoryPath}/WORKFLOW.md`,
  trackerKind: "github",
  trackerRequiredLabels: ["agent-ready"],
  trackerActiveStates: ["open"],
  trackerTerminalStates: ["closed"],
  trackerProvider: {},
  workspaceRoot: "/ws",
  autonomy: "observe",
  agentProvider: {
    instanceId: ProviderInstanceId.make("codex_default"),
    driver: ProviderDriverKind.make("codex"),
  },
  validationRequired: [],
  validationTestPathPatterns: [],
  approvalsProtectedPaths: [],
  approvalsPolicies: [],
  codexStallTimeoutMs: 5_000,
});

const makeWorkItem = (id: string, lifecycle: WorkItem["lifecycle"]): WorkItem => ({
  id: WorkItemId.make(id),
  mode: "symphony",
  projectId: SymphonyProjectId.make("reconciler-project"),
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
    const record: WorkflowRecord = {
      id: WorkflowId.make("wf-1"),
      repositoryPath,
      workflowPath: `${repositoryPath}/WORKFLOW.md`,
      status: "active",
      autonomy: "observe",
      validationError: null,
      definition: { config: {}, promptTemplate: "Implement." },
      effectiveConfig: makeConfig(repositoryPath),
      enabledAt: now,
      createdAt: now,
      updatedAt: now,
    };
    yield* workflows.upsert(record);
  });

const seedAttempt = (
  workItemId: WorkItemId,
  status: string,
  startedAt: string,
  finishedAt: string | null = null,
) =>
  Effect.gen(function* () {
    const runAttempts = yield* RunAttemptRepository;
    yield* runAttempts.create({
      id: RunAttemptId.make(`run-${workItemId}-${startedAt}`),
      workItemId,
      attemptNumber: 1,
      workspacePath: "/ws/1",
      provider: {
        instanceId: ProviderInstanceId.make("codex_default"),
        driver: ProviderDriverKind.make("codex"),
      },
      status: status as never,
      startedAt,
      finishedAt,
      error: null,
    });
  });

const fakeDispatcherActive = Layer.succeed(RunDispatcher, {
  dispatchWorkItem: () => Effect.never,
  cancelRun: (runAttemptId) =>
    Effect.succeed({
      status: "confirmed",
      runAttemptId,
      evidence: "no_owner_recorded",
      released: false,
    } as const),
  isAgentActive: () => Effect.succeed(true),
  stopAllRuns: () => Effect.succeed({ confirmed: 0, held: 0 }),
} as RunDispatcher["Service"]);

const fakeDispatcherIdle = Layer.succeed(RunDispatcher, {
  dispatchWorkItem: () => Effect.never,
  cancelRun: (runAttemptId) =>
    Effect.succeed({
      status: "confirmed",
      runAttemptId,
      evidence: "no_owner_recorded",
      released: false,
    } as const),
  isAgentActive: () => Effect.succeed(false),
  stopAllRuns: () => Effect.succeed({ confirmed: 0, held: 0 }),
} as RunDispatcher["Service"]);

const seedClaimed = (
  workItem: WorkItem,
  identity?: { readonly pid: number; readonly pgid?: number; readonly birthToken?: string },
) =>
  Effect.gen(function* () {
    const repo = yield* WorkItemRepository;
    yield* repo.upsert({ ...workItem, lifecycle: "queued" });
    const claimed = yield* repo.claim(workItem.id, "owner-reconciler");
    if (identity !== undefined) {
      yield* repo.setClaimOwnerProcessIdentity(
        workItem.id,
        "owner-reconciler",
        claimed.generation,
        identity,
      );
    }
    if (workItem.lifecycle !== "preparing") {
      yield* repo.transition(workItem.id, workItem.lifecycle, {
        ownerToken: "owner-reconciler",
        generation: claimed.generation,
      });
    }
  });

const layer = (dispatcher: Layer.Layer<RunDispatcher>) =>
  it.layer(
    dispatcher.pipe(
      Layer.provideMerge(WorkItemRepositoryLive),
      Layer.provideMerge(RunAttemptRepositoryLive),
      Layer.provideMerge(RunEventRepositoryLive),
      Layer.provideMerge(WorkflowRepositoryLive),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(NodeServices.layer),
    ),
  );

const runReconcile = (input?: {
  readonly processClosure?: {
    readonly reader?: ProcessBirthReader;
    readonly signaller?: ProcessGroupSignaller;
    readonly platform?: NodeJS.Platform;
    readonly graceMs?: number;
  };
}) =>
  Effect.gen(function* () {
    const workItems = yield* WorkItemRepository;
    const runAttempts = yield* RunAttemptRepository;
    const runEvents = yield* RunEventRepository;
    const workflows = yield* WorkflowRepository;
    const dispatcher = yield* RunDispatcher;
    yield* reconcileStaleClaims({
      workItems,
      runAttempts,
      runEvents,
      workflows,
      dispatcher,
      ...(input?.processClosure === undefined ? {} : { processClosure: input.processClosure }),
      ownPid: 999_999,
    });
  });

layer(fakeDispatcherIdle)("Reconciler claim release", (it) => {
  it.effect("releases a claim whose run is already terminal", () =>
    Effect.gen(function* () {
      yield* seedWorkflow("/repo");
      const workItem = makeWorkItem("2001", "preparing");
      yield* seedClaimed(workItem);
      yield* seedAttempt(workItem.id, "user_cancelled", yield* nowIso, yield* nowIso);

      yield* runReconcile();

      const after = yield* WorkItemRepository.pipe(
        Effect.flatMap((repo) => repo.getById(workItem.id)),
      );
      expect(after?.lifecycle).toBe("queued");
    }),
  );

  it.effect("marks a stale non-terminal run stalled and releases the claim", () =>
    Effect.gen(function* () {
      yield* seedWorkflow("/repo");
      const workItem = makeWorkItem("2002", "running");
      yield* seedClaimed(workItem);
      yield* seedAttempt(workItem.id, "streaming_turn", yield* nowIso);
      yield* TestClock.adjust("600000 millis");

      yield* runReconcile();

      const workItems = yield* WorkItemRepository;
      const after = yield* workItems
        .getById(workItem.id)
        .pipe(
          Effect.flatMap((value) =>
            value === null ? Effect.die("missing") : Effect.succeed(value),
          ),
        );
      expect(after.lifecycle).toBe("queued");

      const runAttempts = yield* RunAttemptRepository;
      const attempt = yield* runAttempts
        .latestForWorkItem(workItem.id)
        .pipe(
          Effect.flatMap((value) =>
            value === null ? Effect.die("missing") : Effect.succeed(value),
          ),
        );
      expect(attempt.status).toBe("stalled");
      expect(attempt.finishedAt).not.toBeNull();

      const runEvents = yield* RunEventRepository;
      const events = yield* runEvents.listForAttempt(attempt.id);
      expect(events.some((event) => event.eventType === "stalled")).toBe(true);
    }),
  );

  it.effect("does not release a held Stop claim past the stall timeout", () =>
    Effect.gen(function* () {
      yield* seedWorkflow("/repo");
      const workItem = makeWorkItem("2010", "queued");
      const repo = yield* WorkItemRepository;
      yield* repo.upsert(workItem);
      const claimed = yield* repo.claim(workItem.id, "owner-held");
      yield* repo.setClaimOwnerPid(workItem.id, "owner-held", claimed.generation, 654_321);
      yield* repo.transition(workItem.id, "running", {
        ownerToken: "owner-held",
        generation: claimed.generation,
      });
      yield* seedAttempt(workItem.id, "streaming_turn", "1970-01-01T00:00:00.000Z");
      yield* TestClock.adjust("600000 millis");

      const signals = yield* Ref.make<ReadonlyArray<number>>([]);
      const signaller: ProcessGroupSignaller = {
        signalGroup: (pgid) =>
          Ref.update(signals, (ids) => [...ids, pgid]).pipe(Effect.as("sent" as const)),
        isGroupAlive: () => Effect.succeed(false),
      };
      const reader: ProcessBirthReader = {
        readBirthToken: () => Effect.succeed({ kind: "no_such_process" } as const),
      };
      yield* runReconcile({
        processClosure: { reader, signaller, platform: "linux", graceMs: 0 },
      });

      // A startup/Stop hold survives the sweeper and is never requeued.
      expect((yield* repo.getById(workItem.id))?.lifecycle).toBe("running");
      expect(yield* Ref.get(signals)).toEqual([]);
      const attempts = yield* RunAttemptRepository;
      const attempt = yield* attempts.latestForWorkItem(workItem.id);
      expect(attempt?.status).toBe("streaming_turn");
      const events = yield* RunEventRepository;
      expect(
        (yield* events.listForAttempt(attempt?.id ?? RunAttemptId.make("none"))).some(
          (event) => event.eventType === "reconciliation_hold",
        ),
      ).toBe(true);
    }),
  );

  it.effect("never requeues a succeeded run whose ownership is unverified", () =>
    Effect.gen(function* () {
      yield* seedWorkflow("/repo");
      const workItem = makeWorkItem("2011", "queued");
      const repo = yield* WorkItemRepository;
      yield* repo.upsert(workItem);
      const claimed = yield* repo.claim(workItem.id, "owner-succeeded");
      yield* repo.setClaimOwnerPid(workItem.id, "owner-succeeded", claimed.generation, 654_322);
      yield* repo.transition(workItem.id, "running", {
        ownerToken: "owner-succeeded",
        generation: claimed.generation,
      });
      yield* seedAttempt(
        workItem.id,
        "succeeded",
        "2026-08-05T00:00:00.000Z",
        "2026-08-05T00:05:00.000Z",
      );

      yield* runReconcile({
        processClosure: {
          reader: { readBirthToken: () => Effect.succeed({ kind: "no_such_process" } as const) },
          signaller: {
            signalGroup: () => Effect.succeed("sent"),
            isGroupAlive: () => Effect.succeed(false),
          },
          platform: "linux",
          graceMs: 0,
        },
      });

      const after = yield* repo.getById(workItem.id);
      expect(after?.lifecycle).toBe("running");
      expect(after?.ownerPid).toBe(654_322);
    }),
  );

  it.effect("settles a held Stop once late descendants exit, never requeueing", () =>
    Effect.gen(function* () {
      yield* seedWorkflow("/repo");
      const workItem = makeWorkItem("2012", "running");
      const repo = yield* WorkItemRepository;
      yield* seedClaimed(workItem, { pid: 838_383, pgid: 838_383, birthToken: "born-838383" });
      yield* seedAttempt(workItem.id, "streaming_turn", yield* nowIso);
      const attempts = yield* RunAttemptRepository;
      const attempt = yield* attempts.latestForWorkItem(workItem.id);
      const events = yield* RunEventRepository;
      yield* events.append(attempt?.id ?? RunAttemptId.make("none"), "stop_requested", {
        workItemId: String(workItem.id),
      });
      yield* events.append(attempt?.id ?? RunAttemptId.make("none"), "stop_unconfirmed", {
        workItemId: String(workItem.id),
        reason: "leader_gone_descendants_unconfirmed",
      });
      yield* TestClock.adjust("600000 millis");

      // The leader and group are now gone, so closure is finally confirmed.
      yield* runReconcile({
        processClosure: {
          reader: { readBirthToken: () => Effect.succeed({ kind: "no_such_process" } as const) },
          signaller: {
            signalGroup: () => Effect.succeed("no_such_group"),
            isGroupAlive: () => Effect.succeed(false),
          },
          platform: "linux",
          graceMs: 0,
        },
      });

      const after = yield* repo.getById(workItem.id);
      expect(after?.lifecycle).toBe("cancelled");
      expect(after?.ownerPid ?? null).toBeNull();
      const settled = yield* attempts.latestForWorkItem(workItem.id);
      expect(settled?.status).toBe("user_cancelled");
      const settledEvents = yield* events.listForAttempt(settled?.id ?? RunAttemptId.make("none"));
      expect(settledEvents.some((event) => event.eventType === "stop_confirmed")).toBe(true);
      expect(settledEvents.some((event) => event.eventType === "stalled")).toBe(false);
    }),
  );

  it.effect("leaves a recent non-terminal run alone", () =>
    Effect.gen(function* () {
      yield* seedWorkflow("/repo");
      const workItem = makeWorkItem("2003", "running");
      yield* seedClaimed(workItem);
      yield* seedAttempt(workItem.id, "streaming_turn", yield* nowIso);

      yield* runReconcile();

      const workItems = yield* WorkItemRepository;
      const after = yield* workItems
        .getById(workItem.id)
        .pipe(
          Effect.flatMap((value) =>
            value === null ? Effect.die("missing") : Effect.succeed(value),
          ),
        );
      expect(after.lifecycle).toBe("running");
    }),
  );
});

layer(fakeDispatcherActive)("Reconciler live agent", (it) => {
  it.effect("never touches a run with a live agent", () =>
    Effect.gen(function* () {
      yield* seedWorkflow("/repo");
      const workItem = makeWorkItem("2004", "running");
      yield* seedClaimed(workItem);
      yield* seedAttempt(workItem.id, "streaming_turn", yield* nowIso);

      yield* runReconcile();

      const workItems = yield* WorkItemRepository;
      const after = yield* workItems
        .getById(workItem.id)
        .pipe(
          Effect.flatMap((value) =>
            value === null ? Effect.die("missing") : Effect.succeed(value),
          ),
        );
      expect(after.lifecycle).toBe("running");
    }),
  );
});
