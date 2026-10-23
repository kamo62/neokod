import type { EffectiveWorkflowConfig, WorkItem, WorkflowRecord } from "@neokod/contracts";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  RunAttemptId,
  SymphonyProjectId,
  WorkflowId,
  WorkItemId,
} from "@neokod/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { ProcessBirthReader, ProcessGroupSignaller } from "@neokod/shared/processGroup";
import * as Ref from "effect/Ref";

import { nowIso } from "../Domain/Time.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  WorkItemRepository,
  type WorkItemRepositoryShape,
} from "../Persistence/Services/WorkItemRepository.ts";
import { WorkItemRepositoryLive } from "../Persistence/Layers/WorkItemRepository.ts";
import { RunAttemptRepository } from "../Persistence/Services/RunAttemptRepository.ts";
import { RunAttemptRepositoryLive } from "../Persistence/Layers/RunAttemptRepository.ts";
import { RunEventRepository } from "../Persistence/Services/RunEventRepository.ts";
import { RunEventRepositoryLive } from "../Persistence/Layers/RunEventRepository.ts";
import { WorkflowRepository } from "../Persistence/Services/WorkflowRepository.ts";
import { WorkflowRepositoryLive } from "../Persistence/Layers/WorkflowRepository.ts";
import { RunDispatcher } from "../Runner/Dispatcher.ts";
import { runStartupRecovery } from "./Recovery.ts";

const makeConfig = (repositoryPath: string): EffectiveWorkflowConfig => ({
  repositoryPath,
  workflowPath: `${repositoryPath}/WORKFLOW.md`,
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
  validationRequired: [],
  validationTestPathPatterns: [],
  approvalsProtectedPaths: [],
  approvalsPolicies: [],
  maxAttempts: 5,
});

const makeWorkItem = (id: string, lifecycle: WorkItem["lifecycle"]): WorkItem => ({
  id: WorkItemId.make(id),
  mode: "symphony",
  projectId: SymphonyProjectId.make("recovery-project"),
  objective: `Issue ${id}`,
  acceptanceCriteria: [],
  source: { kind: "manual" },
  trackerIssueId: `manual-${id}`,
  lifecycle,
  priority: 1,
  eligibilityReasons: [],
  evidence: null,
  // A crash orphan has a live claim (audit item 3): recovery only adopts
  // runs a dispatcher actually owned.
  claimedAt: "2026-08-05T00:00:00.000Z",
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
      autonomy: "execute",
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
  attemptNumber = 1,
  startedAt = "2026-08-05T00:00:00.000Z",
  finishedAt: string | null = null,
) =>
  Effect.gen(function* () {
    const runAttempts = yield* RunAttemptRepository;
    yield* runAttempts.create({
      id: RunAttemptId.make(`run-${workItemId}-${startedAt}`),
      workItemId,
      attemptNumber,
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

const layer = it.layer(
  fakeDispatcherIdle.pipe(
    Layer.provideMerge(WorkItemRepositoryLive),
    Layer.provideMerge(RunAttemptRepositoryLive),
    Layer.provideMerge(RunEventRepositoryLive),
    Layer.provideMerge(WorkflowRepositoryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const runRecovery = () =>
  Effect.gen(function* () {
    const workItems = yield* WorkItemRepository;
    const runAttempts = yield* RunAttemptRepository;
    const runEvents = yield* RunEventRepository;
    const workflows = yield* WorkflowRepository;
    const dispatcher = yield* RunDispatcher;
    yield* runStartupRecovery({ workItems, runAttempts, runEvents, workflows, dispatcher });
  });

layer("Recovery startup", (it) => {
  it.effect("lands a succeeded-but-untransited run in ready_for_review, not a re-dispatch", () =>
    Effect.gen(function* () {
      yield* seedWorkflow("/repo");
      const workItem = makeWorkItem("3001", "running");
      yield* WorkItemRepository.pipe(Effect.flatMap((repo) => repo.upsert(workItem)));
      yield* seedAttempt(
        workItem.id,
        "succeeded",
        1,
        "2026-08-05T00:00:00.000Z",
        "2026-08-05T00:05:00.000Z",
      );

      yield* runRecovery();

      const after = yield* WorkItemRepository.pipe(
        Effect.flatMap((repo) => repo.getById(workItem.id)),
      );
      // REVIEW P1 #11: a completed agent must not be re-run; the item lands
      // in its review state instead of being re-dispatched.
      expect(after?.lifecycle).toBe("ready_for_review");
    }),
  );

  it.effect("marks a non-terminal run interrupted and re-schedules it for retry", () =>
    Effect.gen(function* () {
      yield* seedWorkflow("/repo");
      const workItem = makeWorkItem("3002", "running");
      yield* WorkItemRepository.pipe(Effect.flatMap((repo) => repo.upsert(workItem)));
      yield* seedAttempt(workItem.id, "streaming_turn");

      yield* runRecovery();

      const workItems = yield* WorkItemRepository;
      const after = yield* workItems.getById(workItem.id);
      expect(after?.lifecycle).toBe("retry_scheduled");

      const runAttempts = yield* RunAttemptRepository;
      const attempt = yield* runAttempts.latestForWorkItem(workItem.id);
      expect(attempt?.status).toBe("interrupted");
      expect(attempt?.finishedAt).not.toBeNull();

      const runEvents = yield* RunEventRepository;
      const events = yield* runEvents.listForAttempt(attempt?.id ?? RunAttemptId.make("none"));
      expect(events.some((event) => event.eventType === "interrupted")).toBe(true);
    }),
  );

  it.effect("releases to queued when the attempt cap is reached", () =>
    Effect.gen(function* () {
      yield* seedWorkflow("/repo");
      const workItem = makeWorkItem("3003", "running");
      yield* WorkItemRepository.pipe(Effect.flatMap((repo) => repo.upsert(workItem)));
      yield* seedAttempt(workItem.id, "streaming_turn", 5);

      yield* runRecovery();

      const workItems = yield* WorkItemRepository;
      const after = yield* workItems.getById(workItem.id);
      expect(after?.lifecycle).toBe("queued");
    }),
  );

  it.effect("is idempotent on a second run", () =>
    Effect.gen(function* () {
      yield* seedWorkflow("/repo");
      const workItem = makeWorkItem("3004", "running");
      yield* WorkItemRepository.pipe(Effect.flatMap((repo) => repo.upsert(workItem)));
      yield* seedAttempt(workItem.id, "streaming_turn");

      yield* runRecovery();
      yield* runRecovery();

      const workItems = yield* WorkItemRepository;
      const after = yield* workItems.getById(workItem.id);
      expect(after?.lifecycle).toBe("retry_scheduled");
    }),
  );

  const makeRecordingSignaller = (config: {
    readonly aliveAfterTerm: boolean;
    readonly aliveAfterKill: boolean;
  }) =>
    Effect.gen(function* () {
      const signals = yield* Ref.make<
        Array<{ readonly pgid: number; readonly signal: NodeJS.Signals }>
      >([]);
      const alive = yield* Ref.make(true);
      const signaller: ProcessGroupSignaller = {
        signalGroup: (pgid, signal) =>
          Effect.gen(function* () {
            yield* Ref.update(signals, (previous) => [...previous, { pgid, signal }]);
            if (signal === "SIGTERM") {
              yield* Ref.set(alive, config.aliveAfterTerm);
            } else {
              yield* Ref.set(alive, config.aliveAfterKill);
            }
            return "sent" as const;
          }),
        isGroupAlive: () => Ref.get(alive),
      };
      return { signaller, signals };
    });

  const tokenReader = (tokens: Readonly<Record<number, string>>): ProcessBirthReader => ({
    readBirthToken: (pid) => {
      const token = tokens[pid];
      return Effect.succeed(
        token === undefined
          ? ({ kind: "no_such_process" } as const)
          : ({ kind: "token", token } as const),
      );
    },
  });

  const seedClaimPid = (workItemId: WorkItemId, pid: number) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE symphony_work_items SET owner_pid = ${pid} WHERE id = ${workItemId}`;
    });

  const seedClaimedItem = (
    workItem: WorkItem,
    identity: { readonly pid: number; readonly pgid?: number; readonly birthToken?: string },
  ) =>
    Effect.gen(function* () {
      const repo = yield* WorkItemRepository;
      yield* repo.upsert({ ...workItem, lifecycle: "queued" });
      const claimed = yield* repo.claim(workItem.id, "owner-recovery");
      yield* repo.setClaimOwnerProcessIdentity(
        workItem.id,
        "owner-recovery",
        claimed.generation,
        identity,
      );
      yield* repo.transition(workItem.id, "running", {
        ownerToken: "owner-recovery",
        generation: claimed.generation,
      });
    });

  /** Expose persisted group identity that the current schema cannot store yet. */
  const withIdentity = (
    base: WorkItemRepositoryShape,
    identities: ReadonlyMap<
      string,
      Partial<Pick<WorkItem, "ownerPid" | "ownerPgid" | "ownerBirthToken">>
    >,
    readOverride?: (item: WorkItem) => WorkItem,
  ): WorkItemRepositoryShape => ({
    ...base,
    listByLifecycle: (lifecycles, options) =>
      base
        .listByLifecycle(lifecycles, options)
        .pipe(
          Effect.map((items) =>
            items.map((item) => ({ ...item, ...(identities.get(String(item.id)) ?? {}) })),
          ),
        ),
    getById: (id) =>
      base.getById(id).pipe(
        Effect.map((item) => {
          if (item === null) return null;
          const decorated = { ...item, ...(identities.get(String(item.id)) ?? {}) };
          return readOverride === undefined ? decorated : readOverride(decorated);
        }),
      ),
  });

  const runRecoveryWith = (input: {
    readonly workItems?: WorkItemRepositoryShape;
    readonly processClosure?: Parameters<typeof runStartupRecovery>[0]["processClosure"];
    readonly ownPid?: number;
  }) =>
    Effect.gen(function* () {
      const baseWorkItems = yield* WorkItemRepository;
      const runAttempts = yield* RunAttemptRepository;
      const runEvents = yield* RunEventRepository;
      const workflows = yield* WorkflowRepository;
      const dispatcher = yield* RunDispatcher;
      yield* runStartupRecovery({
        workItems: input.workItems ?? baseWorkItems,
        runAttempts,
        runEvents,
        workflows,
        dispatcher,
        ...(input.processClosure === undefined ? {} : { processClosure: input.processClosure }),
        ...(input.ownPid === undefined ? {} : { ownPid: input.ownPid }),
      });
    });

  const latestAttempt = (workItemId: WorkItemId) =>
    RunAttemptRepository.pipe(
      Effect.flatMap((runAttempts) => runAttempts.latestForWorkItem(workItemId)),
    );

  it.effect("holds a legacy pid-only claim without signalling", () =>
    Effect.gen(function* () {
      yield* seedWorkflow("/repo");
      const workItem = makeWorkItem("3101", "running");
      yield* WorkItemRepository.pipe(Effect.flatMap((repo) => repo.upsert(workItem)));
      yield* seedAttempt(workItem.id, "streaming_turn");
      yield* seedClaimPid(workItem.id, 987654);
      const { signaller, signals } = yield* makeRecordingSignaller({
        aliveAfterTerm: false,
        aliveAfterKill: false,
      });
      yield* runRecoveryWith({
        processClosure: {
          signaller,
          reader: tokenReader({ 987654: "born" }),
          platform: "linux",
          graceMs: 1,
        },
        ownPid: 1,
      });
      expect(yield* Ref.get(signals)).toEqual([]);
      const workItems = yield* WorkItemRepository;
      const after = yield* workItems.getById(workItem.id);
      // The claim and lease stay held: no identity proof means no signal and
      // no release.
      expect(after?.lifecycle).toBe("running");
      const attempt = yield* latestAttempt(workItem.id);
      expect(attempt?.status).toBe("streaming_turn");
      const events = yield* RunEventRepository.pipe(
        Effect.flatMap((runEvents) =>
          runEvents.listForAttempt(attempt?.id ?? RunAttemptId.make("none")),
        ),
      );
      const hold = events.find((event) => event.eventType === "recovery_hold");
      expect(hold?.payload).toMatchObject({ reason: "unproven_group_identity" });
    }),
  );

  it.effect("never signals the server's own pid", () =>
    Effect.gen(function* () {
      yield* seedWorkflow("/repo");
      const workItem = makeWorkItem("3102", "running");
      yield* WorkItemRepository.pipe(Effect.flatMap((repo) => repo.upsert(workItem)));
      yield* seedAttempt(workItem.id, "streaming_turn");
      yield* seedClaimPid(workItem.id, process.pid);
      const { signaller, signals } = yield* makeRecordingSignaller({
        aliveAfterTerm: false,
        aliveAfterKill: false,
      });
      yield* runRecoveryWith({
        processClosure: { signaller, reader: tokenReader({}), platform: "linux" },
      });
      expect(yield* Ref.get(signals)).toEqual([]);
      const workItems = yield* WorkItemRepository;
      expect((yield* workItems.getById(workItem.id))?.lifecycle).toBe("running");
    }),
  );

  it.effect("releases when no owner process was ever recorded", () =>
    Effect.gen(function* () {
      yield* seedWorkflow("/repo");
      const workItem = makeWorkItem("3103", "running");
      yield* WorkItemRepository.pipe(Effect.flatMap((repo) => repo.upsert(workItem)));
      yield* seedAttempt(workItem.id, "streaming_turn");
      const { signaller, signals } = yield* makeRecordingSignaller({
        aliveAfterTerm: false,
        aliveAfterKill: false,
      });
      yield* runRecoveryWith({
        processClosure: { signaller, reader: tokenReader({}), platform: "linux" },
      });
      expect(yield* Ref.get(signals)).toEqual([]);
      const workItems = yield* WorkItemRepository;
      expect((yield* workItems.getById(workItem.id))?.lifecycle).toBe("retry_scheduled");
    }),
  );

  it.effect("never signals a recycled pid and keeps ownership held", () =>
    Effect.gen(function* () {
      yield* seedWorkflow("/repo");
      const workItem = makeWorkItem("3201", "running");
      const base = yield* WorkItemRepository;
      yield* seedClaimedItem(workItem, {
        pid: 4242,
        pgid: 4242,
        birthToken: "spawned-token",
      });
      yield* seedAttempt(workItem.id, "streaming_turn");
      const { signaller, signals } = yield* makeRecordingSignaller({
        aliveAfterTerm: false,
        aliveAfterKill: false,
      });
      yield* runRecoveryWith({
        processClosure: {
          signaller,
          // The pid now belongs to a different process.
          reader: tokenReader({ 4242: "replacement-token" }),
          platform: "linux",
          graceMs: 1,
        },
      });
      expect(yield* Ref.get(signals)).toEqual([]);
      expect((yield* base.getById(workItem.id))?.lifecycle).toBe("running");
      const attempt = yield* latestAttempt(workItem.id);
      const events = yield* RunEventRepository.pipe(
        Effect.flatMap((runEvents) =>
          runEvents.listForAttempt(attempt?.id ?? RunAttemptId.make("none")),
        ),
      );
      expect(events.find((event) => event.eventType === "recovery_hold")?.payload).toMatchObject({
        reason: "pid_recycled",
      });
    }),
  );

  it.effect("does not signal when the generation/claim changed after the snapshot", () =>
    Effect.gen(function* () {
      yield* seedWorkflow("/repo");
      const workItem = makeWorkItem("3202", "running");
      const base = yield* WorkItemRepository;
      yield* seedClaimedItem(workItem, {
        pid: 5151,
        pgid: 5151,
        birthToken: "born-5151",
      });
      yield* seedAttempt(workItem.id, "streaming_turn");
      const { signaller, signals } = yield* makeRecordingSignaller({
        aliveAfterTerm: false,
        aliveAfterKill: false,
      });
      yield* runRecoveryWith({
        workItems: withIdentity(
          base,
          new Map([
            [
              String(workItem.id),
              { ownerPid: 5151, ownerPgid: 5151, ownerBirthToken: "born-5151" },
            ],
          ]),
          // A re-claim/stop changed the recorded owner between reads.
          (item) => ({ ...item, ownerPid: 6161 }),
        ),
        processClosure: {
          signaller,
          reader: tokenReader({ 5151: "born-5151", 6161: "born-6161" }),
          platform: "linux",
          graceMs: 1,
        },
      });
      expect(yield* Ref.get(signals)).toEqual([]);
      expect((yield* base.getById(workItem.id))?.lifecycle).toBe("running");
    }),
  );

  it.effect("does not release a terminal attempt while closure is unproven", () =>
    Effect.gen(function* () {
      yield* seedWorkflow("/repo");
      const workItem = makeWorkItem("3203", "running");
      const base = yield* WorkItemRepository;
      yield* seedClaimedItem(workItem, { pid: 7171 });
      yield* seedAttempt(
        workItem.id,
        "succeeded",
        1,
        "2026-08-05T00:00:00.000Z",
        "2026-08-05T00:05:00.000Z",
      );
      const { signaller, signals } = yield* makeRecordingSignaller({
        aliveAfterTerm: false,
        aliveAfterKill: false,
      });
      yield* runRecoveryWith({
        processClosure: {
          signaller,
          reader: tokenReader({ 7171: "born-7171" }),
          platform: "linux",
          graceMs: 1,
        },
      });
      expect(yield* Ref.get(signals)).toEqual([]);
      // The terminal-attempt shortcut is not proof of process closure: the
      // item must not land in ready_for_review on a bare pid.
      expect((yield* base.getById(workItem.id))?.lifecycle).toBe("running");
    }),
  );

  it.effect("confirms closure, terminates once and releases once", () =>
    Effect.gen(function* () {
      yield* seedWorkflow("/repo");
      const workItem = makeWorkItem("3204", "running");
      const base = yield* WorkItemRepository;
      yield* seedClaimedItem(workItem, {
        pid: 8181,
        pgid: 8181,
        birthToken: "born-8181",
      });
      yield* seedAttempt(workItem.id, "streaming_turn");
      const { signaller, signals } = yield* makeRecordingSignaller({
        aliveAfterTerm: false,
        aliveAfterKill: false,
      });
      const deps = {
        processClosure: {
          signaller,
          reader: tokenReader({ 8181: "born-8181" }),
          platform: "linux" as const,
          graceMs: 1,
        },
      };
      yield* runRecoveryWith(deps);
      yield* runRecoveryWith(deps);

      expect(yield* Ref.get(signals)).toEqual([{ pgid: 8181, signal: "SIGTERM" }]);
      expect((yield* base.getById(workItem.id))?.lifecycle).toBe("retry_scheduled");
      const attempt = yield* latestAttempt(workItem.id);
      expect(attempt?.status).toBe("interrupted");
      const events = yield* RunEventRepository.pipe(
        Effect.flatMap((runEvents) =>
          runEvents.listForAttempt(attempt?.id ?? RunAttemptId.make("none")),
        ),
      );
      expect(events.filter((event) => event.eventType === "interrupted")).toHaveLength(1);
    }),
  );

  it.effect("holds ownership when the leader exits but its group may survive", () =>
    Effect.gen(function* () {
      yield* seedWorkflow("/repo");
      const workItem = makeWorkItem("3205", "running");
      const base = yield* WorkItemRepository;
      yield* seedClaimedItem(workItem, {
        pid: 9191,
        pgid: 9191,
        birthToken: "born-9191",
      });
      yield* seedAttempt(workItem.id, "streaming_turn");
      const { signaller, signals } = yield* makeRecordingSignaller({
        aliveAfterTerm: true,
        aliveAfterKill: false,
      });
      // Alive for the pre-signal checks, gone before the KILL revalidation.
      const reads = yield* Ref.make(0);
      const reader: ProcessBirthReader = {
        readBirthToken: () =>
          Ref.modify(reads, (count) => [
            count < 2
              ? ({ kind: "token", token: "born-9191" } as const)
              : ({ kind: "no_such_process" } as const),
            count + 1,
          ]),
      };
      yield* runRecoveryWith({
        processClosure: { signaller, reader, platform: "linux", graceMs: 0 },
      });
      // TERM was sent, but the leader's exit is not group closure: no KILL,
      // no release, no retry.
      expect((yield* Ref.get(signals)).map((entry) => entry.signal)).toEqual(["SIGTERM"]);
      expect((yield* base.getById(workItem.id))?.lifecycle).toBe("running");
      expect((yield* latestAttempt(workItem.id))?.status).toBe("streaming_turn");
    }),
  );
});
