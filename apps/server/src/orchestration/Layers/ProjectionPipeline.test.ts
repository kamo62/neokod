import {
  CheckpointRef,
  CommandId,
  CorrelationId,
  EventId,
  MessageId,
  ProjectId,
  RuntimeItemId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
  ProviderInstanceId,
  type OrchestrationThreadActivity,
  type RuntimeItemKind,
  type RuntimeItemProviderState,
} from "@neokod/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { WorktreeRemovalLeaseLive } from "../../git/WorktreeRemovalLease.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import {
  ORCHESTRATION_PROJECTOR_NAMES,
  OrchestrationProjectionPipelineLive,
} from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ServerConfig } from "../../config.ts";

const makeProjectionPipelinePrefixedTestLayer = (prefix: string) =>
  OrchestrationProjectionPipelineLive.pipe(
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix })),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  );

const exists = (filePath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const fileInfo = yield* Effect.result(fileSystem.stat(filePath));
    return fileInfo._tag === "Success";
  });

const BaseTestLayer = makeProjectionPipelinePrefixedTestLayer("neokod-projection-pipeline-test-");

it.layer(BaseTestLayer)("OrchestrationProjectionPipeline", (it) => {
  it.effect("bootstraps all projection states and writes projection rows", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.make("evt-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-1"),
        occurredAt: now,
        commandId: CommandId.make("cmd-1"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-1"),
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.make("evt-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        occurredAt: now,
        commandId: CommandId.make("cmd-2"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-1"),
          projectId: ProjectId.make("project-1"),
          title: "Thread 1",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        occurredAt: now,
        commandId: CommandId.make("cmd-3"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("message-1"),
          role: "assistant",
          text: "hello",
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;

      const projectRows = yield* sql<{
        readonly projectId: string;
        readonly title: string;
        readonly scriptsJson: string;
      }>`
        SELECT
          project_id AS "projectId",
          title,
          scripts_json AS "scriptsJson"
        FROM projection_projects
      `;
      assert.deepEqual(projectRows, [
        { projectId: "project-1", title: "Project 1", scriptsJson: "[]" },
      ]);

      const messageRows = yield* sql<{
        readonly messageId: string;
        readonly text: string;
      }>`
        SELECT
          message_id AS "messageId",
          text
        FROM projection_thread_messages
      `;
      assert.deepEqual(messageRows, [{ messageId: "message-1", text: "hello" }]);

      const stateRows = yield* sql<{
        readonly projector: string;
        readonly lastAppliedSequence: number;
      }>`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
        ORDER BY projector ASC
      `;
      assert.equal(stateRows.length, Object.keys(ORCHESTRATION_PROJECTOR_NAMES).length);
      for (const row of stateRows) {
        assert.equal(row.lastAppliedSequence, 3);
      }
    }),
  );
});

it.layer(BaseTestLayer)("OrchestrationProjectionPipeline worker count", (it) => {
  it.effect("counts active workers and clears unfinished workers at turn end", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-worker-count");
      const turnId = TurnId.make("turn-worker-count");
      let activitySequence = 0;

      const readWorkerCount = () =>
        sql<{ readonly workerCount: number }>`
          SELECT worker_count AS "workerCount"
          FROM projection_threads
          WHERE thread_id = ${threadId}
        `.pipe(Effect.map((rows) => rows[0]?.workerCount ?? -1));

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.make("evt-worker-count-created"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2026-07-26T00:00:00.000Z",
        commandId: CommandId.make("cmd-worker-count-created"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-worker-count-created"),
        metadata: {},
        payload: {
          threadId,
          projectId: ProjectId.make("project-worker-count"),
          title: "Worker count",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: "2026-07-26T00:00:00.000Z",
          updatedAt: "2026-07-26T00:00:00.000Z",
        },
      });
      yield* projectionPipeline.bootstrap;

      yield* eventStore.append({
        type: "thread.session-set",
        eventId: EventId.make("evt-worker-count-running"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2026-07-26T00:00:01.000Z",
        commandId: CommandId.make("cmd-worker-count-running"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-worker-count-running"),
        metadata: {},
        payload: {
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: "2026-07-26T00:00:01.000Z",
          },
        },
      });
      yield* projectionPipeline.bootstrap;

      const appendActivity = (
        eventId: string,
        kind: "task.started" | "task.completed",
        taskId: string,
      ) =>
        eventStore.append({
          type: "thread.activity-appended",
          eventId: EventId.make(eventId),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: `2026-07-26T00:00:0${activitySequence + 2}.000Z`,
          commandId: CommandId.make(`cmd-${eventId}`),
          causationEventId: null,
          correlationId: CommandId.make(`cmd-${eventId}`),
          metadata: {},
          payload: {
            threadId,
            activity: {
              id: EventId.make(`${eventId}-activity`),
              tone: "info",
              kind,
              summary: kind === "task.started" ? "Task started" : "Task completed",
              payload: kind === "task.started" ? { taskId } : { taskId, status: "completed" },
              turnId,
              sequence: activitySequence++,
              createdAt: `2026-07-26T00:00:0${activitySequence + 1}.000Z`,
            },
          },
        });

      yield* appendActivity("evt-worker-count-a-started", "task.started", "task-a");
      yield* appendActivity("evt-worker-count-b-started", "task.started", "task-b");
      yield* projectionPipeline.bootstrap;
      assert.equal(yield* readWorkerCount(), 2);

      yield* appendActivity("evt-worker-count-a-completed", "task.completed", "task-a");
      yield* projectionPipeline.bootstrap;
      assert.equal(yield* readWorkerCount(), 1);

      // A missed task.completed must not leak past the authoritative turn end.
      yield* eventStore.append({
        type: "thread.session-set",
        eventId: EventId.make("evt-worker-count-ended"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2026-07-26T00:01:00.000Z",
        commandId: CommandId.make("cmd-worker-count-ended"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-worker-count-ended"),
        metadata: {},
        payload: {
          threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-07-26T00:01:00.000Z",
          },
        },
      });
      yield* projectionPipeline.bootstrap;
      assert.equal(yield* readWorkerCount(), 0);
    }),
  );

  it.effect("selects durable shell-summary evidence independently per lifecycle kind", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-mixed-runtime-evidence");
      const turnId = TurnId.make("turn-mixed-runtime-evidence");
      const now = "2026-07-26T01:00:00.000Z";
      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));
      const appendActivity = (eventId: string, activity: OrchestrationThreadActivity) =>
        appendAndProject({
          type: "thread.activity-appended",
          eventId: EventId.make(eventId),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: activity.createdAt,
          commandId: CommandId.make(`cmd-${eventId}`),
          causationEventId: null,
          correlationId: CommandId.make(`cmd-${eventId}`),
          metadata: {},
          payload: { threadId, activity },
        });
      const appendObservation = (
        suffix: string,
        kind: RuntimeItemKind,
        providerState: RuntimeItemProviderState,
      ) =>
        appendAndProject({
          type: "thread.runtime-item-observed",
          eventId: EventId.make(`evt-mixed-runtime-${suffix}`),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: now,
          commandId: CommandId.make(`cmd-mixed-runtime-${suffix}`),
          causationEventId: null,
          correlationId: CommandId.make(`cmd-mixed-runtime-${suffix}`),
          metadata: {},
          payload: {
            threadId,
            observation: {
              runtimeItemId: RuntimeItemId.make(`runtime-mixed-${suffix}`),
              providerItemId: null,
              sessionId: RuntimeSessionId.make("session-mixed-runtime-evidence"),
              kind,
              scope: "turn",
              turnId,
              providerState,
              label: `Mixed ${kind}`,
              providerEventId: EventId.make(`provider-mixed-${suffix}`),
              observedAt: now,
            },
          },
        });
      const readCounts = () =>
        sql<{
          readonly pendingApprovalCount: number;
          readonly pendingUserInputCount: number;
          readonly workerCount: number;
        }>`
          SELECT
            pending_approval_count AS "pendingApprovalCount",
            pending_user_input_count AS "pendingUserInputCount",
            worker_count AS "workerCount"
          FROM projection_threads
          WHERE thread_id = ${threadId}
        `.pipe(Effect.map((rows) => rows[0]));

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.make("evt-mixed-runtime-created"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-mixed-runtime-created"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-mixed-runtime-created"),
        metadata: {},
        payload: {
          threadId,
          projectId: ProjectId.make("project-mixed-runtime-evidence"),
          title: "Mixed runtime evidence",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* appendAndProject({
        type: "thread.session-set",
        eventId: EventId.make("evt-mixed-runtime-session"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-mixed-runtime-session"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-mixed-runtime-session"),
        metadata: {},
        payload: {
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: now,
          },
        },
      });
      yield* appendActivity("evt-mixed-runtime-legacy-approval", {
        id: EventId.make("activity-mixed-runtime-approval"),
        tone: "approval",
        kind: "approval.requested",
        summary: "Approval requested",
        payload: { requestId: "approval-mixed-runtime", requestKind: "command" },
        turnId,
        sequence: 1,
        createdAt: now,
      });
      yield* appendActivity("evt-mixed-runtime-legacy-user-input", {
        id: EventId.make("activity-mixed-runtime-user-input"),
        tone: "info",
        kind: "user-input.requested",
        summary: "User input requested",
        payload: { requestId: "user-input-mixed-runtime", questions: [] },
        turnId,
        sequence: 2,
        createdAt: now,
      });
      yield* appendActivity("evt-mixed-runtime-legacy-task", {
        id: EventId.make("activity-mixed-runtime-task"),
        tone: "info",
        kind: "task.started",
        summary: "Task started",
        payload: { taskId: "task-mixed-runtime" },
        turnId,
        sequence: 3,
        createdAt: now,
      });

      yield* appendObservation("tool", "tool", "active");
      assert.deepEqual(yield* readCounts(), {
        pendingApprovalCount: 1,
        pendingUserInputCount: 1,
        workerCount: 1,
      });

      yield* appendObservation("approval", "approval", "completed");
      yield* appendObservation("user-input", "user-input", "completed");
      yield* appendObservation("delegated-task", "delegated-task", "completed");
      assert.deepEqual(yield* readCounts(), {
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
        workerCount: 0,
      });
    }),
  );
});

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("neokod-runtime-mode-persisted-")))(
  "OrchestrationProjectionPipeline",
  (it) => {
    it.effect("persists a runtime-mode change without retaining the prior mode", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const threads = yield* ProjectionThreadRepository;
        const threadId = ThreadId.make("thread-runtime-mode-persisted");
        const createdAt = "2026-07-26T12:00:00.000Z";
        const updatedAt = "2026-07-26T12:00:01.000Z";

        const createdEvent = yield* eventStore.append({
          type: "thread.created",
          eventId: EventId.make("evt-runtime-mode-persisted-1"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: createdAt,
          commandId: CommandId.make("cmd-runtime-mode-persisted-1"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-runtime-mode-persisted-1"),
          metadata: {},
          payload: {
            threadId,
            projectId: ProjectId.make("project-runtime-mode-persisted"),
            title: "Runtime mode persistence",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        });
        yield* projectionPipeline.projectEvent(createdEvent);

        const runtimeModeSetEvent = yield* eventStore.append({
          type: "thread.runtime-mode-set",
          eventId: EventId.make("evt-runtime-mode-persisted-2"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: updatedAt,
          commandId: CommandId.make("cmd-runtime-mode-persisted-2"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-runtime-mode-persisted-2"),
          metadata: {},
          payload: {
            threadId,
            runtimeMode: "approval-required",
            updatedAt,
          },
        });
        yield* projectionPipeline.projectEvent(runtimeModeSetEvent);

        const persisted = yield* threads.getById({ threadId });
        const row = Option.getOrNull(persisted);
        if (row === null) {
          return yield* Effect.die("Expected projection_threads row to exist.");
        }
        assert.strictEqual(row.runtimeMode, "approval-required");
      }),
    );
  },
);

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("neokod-base-")))(
  "OrchestrationProjectionPipeline",
  (it) => {
    it.effect("stores message attachment references without mutating payloads", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const now = "2026-01-01T00:00:00.000Z";

        yield* eventStore.append({
          type: "thread.message-sent",
          eventId: EventId.make("evt-attachments"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-attachments"),
          occurredAt: now,
          commandId: CommandId.make("cmd-attachments"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-attachments"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-attachments"),
            messageId: MessageId.make("message-attachments"),
            role: "user",
            text: "Inspect this",
            attachments: [
              {
                type: "image",
                id: "thread-attachments-att-1",
                name: "example.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* projectionPipeline.bootstrap;

        const rows = yield* sql<{
          readonly attachmentsJson: string | null;
        }>`
            SELECT
              attachments_json AS "attachmentsJson"
            FROM projection_thread_messages
            WHERE message_id = 'message-attachments'
          `;
        assert.equal(rows.length, 1);
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        assert.deepEqual(JSON.parse(rows[0]?.attachmentsJson ?? "null"), [
          {
            type: "image",
            id: "thread-attachments-att-1",
            name: "example.png",
            mimeType: "image/png",
            sizeBytes: 5,
          },
        ]);
      }),
    );
  },
);

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("neokod-projection-attachments-safe-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("preserves mixed image attachment metadata as-is", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-attachments-safe"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-attachments-safe"),
        occurredAt: now,
        commandId: CommandId.make("cmd-attachments-safe"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-attachments-safe"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-attachments-safe"),
          messageId: MessageId.make("message-attachments-safe"),
          role: "user",
          text: "Inspect this",
          attachments: [
            {
              type: "image",
              id: "thread-attachments-safe-att-1",
              name: "untrusted.exe",
              mimeType: "image/x-unknown",
              sizeBytes: 5,
            },
            {
              type: "image",
              id: "thread-attachments-safe-att-2",
              name: "not-image.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;

      const rows = yield* sql<{
        readonly attachmentsJson: string | null;
      }>`
            SELECT
              attachments_json AS "attachmentsJson"
            FROM projection_thread_messages
            WHERE message_id = 'message-attachments-safe'
          `;
      assert.equal(rows.length, 1);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      assert.deepEqual(JSON.parse(rows[0]?.attachmentsJson ?? "null"), [
        {
          type: "image",
          id: "thread-attachments-safe-att-1",
          name: "untrusted.exe",
          mimeType: "image/x-unknown",
          sizeBytes: 5,
        },
        {
          type: "image",
          id: "thread-attachments-safe-att-2",
          name: "not-image.png",
          mimeType: "image/png",
          sizeBytes: 5,
        },
      ]);
    }),
  );
});

it.layer(BaseTestLayer)("OrchestrationProjectionPipeline", (it) => {
  it.effect(
    "passes explicit empty attachment arrays through the projection pipeline to clear attachments",
    () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const now = "2026-01-01T00:00:00.000Z";
        const later = "2026-01-01T00:00:01.000Z";

        yield* eventStore.append({
          type: "project.created",
          eventId: EventId.make("evt-clear-attachments-1"),
          aggregateKind: "project",
          aggregateId: ProjectId.make("project-clear-attachments"),
          occurredAt: now,
          commandId: CommandId.make("cmd-clear-attachments-1"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-clear-attachments-1"),
          metadata: {},
          payload: {
            projectId: ProjectId.make("project-clear-attachments"),
            title: "Project Clear Attachments",
            workspaceRoot: "/tmp/project-clear-attachments",
            defaultModelSelection: null,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* eventStore.append({
          type: "thread.created",
          eventId: EventId.make("evt-clear-attachments-2"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-clear-attachments"),
          occurredAt: now,
          commandId: CommandId.make("cmd-clear-attachments-2"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-clear-attachments-2"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-clear-attachments"),
            projectId: ProjectId.make("project-clear-attachments"),
            title: "Thread Clear Attachments",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* eventStore.append({
          type: "thread.message-sent",
          eventId: EventId.make("evt-clear-attachments-3"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-clear-attachments"),
          occurredAt: now,
          commandId: CommandId.make("cmd-clear-attachments-3"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-clear-attachments-3"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-clear-attachments"),
            messageId: MessageId.make("message-clear-attachments"),
            role: "user",
            text: "Has attachments",
            attachments: [
              {
                type: "image",
                id: "thread-clear-attachments-att-1",
                name: "clear.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* eventStore.append({
          type: "thread.message-sent",
          eventId: EventId.make("evt-clear-attachments-4"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-clear-attachments"),
          occurredAt: later,
          commandId: CommandId.make("cmd-clear-attachments-4"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-clear-attachments-4"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-clear-attachments"),
            messageId: MessageId.make("message-clear-attachments"),
            role: "user",
            text: "",
            attachments: [],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: later,
          },
        });

        yield* projectionPipeline.bootstrap;

        const rows = yield* sql<{
          readonly attachmentsJson: string | null;
        }>`
          SELECT
            attachments_json AS "attachmentsJson"
          FROM projection_thread_messages
          WHERE message_id = 'message-clear-attachments'
        `;
        assert.equal(rows.length, 1);
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        assert.deepEqual(JSON.parse(rows[0]?.attachmentsJson ?? "null"), []);
      }),
  );
});

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("neokod-projection-attachments-overwrite-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("overwrites stored attachment references when a message updates attachments", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";
      const later = "2026-01-01T00:00:01.000Z";

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.make("evt-overwrite-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-overwrite"),
        occurredAt: now,
        commandId: CommandId.make("cmd-overwrite-1"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-overwrite-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-overwrite"),
          title: "Project Overwrite",
          workspaceRoot: "/tmp/project-overwrite",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.make("evt-overwrite-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-overwrite"),
        occurredAt: now,
        commandId: CommandId.make("cmd-overwrite-2"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-overwrite-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-overwrite"),
          projectId: ProjectId.make("project-overwrite"),
          title: "Thread Overwrite",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-overwrite-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-overwrite"),
        occurredAt: now,
        commandId: CommandId.make("cmd-overwrite-3"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-overwrite-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-overwrite"),
          messageId: MessageId.make("message-overwrite"),
          role: "user",
          text: "first image",
          attachments: [
            {
              type: "image",
              id: "thread-overwrite-att-1",
              name: "file.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-overwrite-4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-overwrite"),
        occurredAt: later,
        commandId: CommandId.make("cmd-overwrite-4"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-overwrite-4"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-overwrite"),
          messageId: MessageId.make("message-overwrite"),
          role: "user",
          text: "",
          attachments: [
            {
              type: "image",
              id: "thread-overwrite-att-2",
              name: "file.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: later,
        },
      });

      yield* projectionPipeline.bootstrap;

      const rows = yield* sql<{
        readonly attachmentsJson: string | null;
      }>`
              SELECT attachments_json AS "attachmentsJson"
              FROM projection_thread_messages
              WHERE message_id = 'message-overwrite'
            `;
      assert.equal(rows.length, 1);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      assert.deepEqual(JSON.parse(rows[0]?.attachmentsJson ?? "null"), [
        {
          type: "image",
          id: "thread-overwrite-att-2",
          name: "file.png",
          mimeType: "image/png",
          sizeBytes: 5,
        },
      ]);
    }),
  );
});

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("neokod-projection-attachments-rollback-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("does not persist attachment files when projector transaction rolls back", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const path = yield* Path.Path;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";

      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.make("evt-rollback-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-rollback"),
        occurredAt: now,
        commandId: CommandId.make("cmd-rollback-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-rollback-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-rollback"),
          title: "Project Rollback",
          workspaceRoot: "/tmp/project-rollback",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.make("evt-rollback-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-rollback"),
        occurredAt: now,
        commandId: CommandId.make("cmd-rollback-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-rollback-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-rollback"),
          projectId: ProjectId.make("project-rollback"),
          title: "Thread Rollback",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* sql`
        CREATE TRIGGER fail_thread_messages_projection_state_update
        BEFORE UPDATE ON projection_state
        WHEN NEW.projector = 'projection.thread-messages'
        BEGIN
          SELECT RAISE(ABORT, 'forced-projection-state-failure');
        END;
      `;

      const result = yield* Effect.result(
        appendAndProject({
          type: "thread.message-sent",
          eventId: EventId.make("evt-rollback-3"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-rollback"),
          occurredAt: now,
          commandId: CommandId.make("cmd-rollback-3"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-rollback-3"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-rollback"),
            messageId: MessageId.make("message-rollback"),
            role: "user",
            text: "Rollback me",
            attachments: [
              {
                type: "image",
                id: "thread-rollback-att-1",
                name: "rollback.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        }),
      );
      assert.equal(result._tag, "Failure");

      const rows = yield* sql<{
        readonly count: number;
      }>`
        SELECT COUNT(*) AS "count"
        FROM projection_thread_messages
        WHERE message_id = 'message-rollback'
      `;
      assert.equal(rows[0]?.count ?? 0, 0);

      const { attachmentsDir } = yield* ServerConfig;
      const attachmentPath = path.join(attachmentsDir, "thread-rollback-att-1.png");
      assert.isFalse(yield* exists(attachmentPath));
      yield* sql`DROP TRIGGER IF EXISTS fail_thread_messages_projection_state_update`;
    }),
  );
});

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("neokod-projection-attachments-overwrite-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("removes unreferenced attachment files when a thread is reverted", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const { attachmentsDir } = yield* ServerConfig;
      const now = "2026-01-01T00:00:00.000Z";
      const threadId = ThreadId.make("Thread Revert.Files");
      const keepAttachmentId = "thread-revert-files-00000000-0000-4000-8000-000000000001";
      const removeAttachmentId = "thread-revert-files-00000000-0000-4000-8000-000000000002";
      const otherThreadAttachmentId =
        "thread-revert-files-extra-00000000-0000-4000-8000-000000000003";

      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.make("evt-revert-files-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-revert-files"),
        occurredAt: now,
        commandId: CommandId.make("cmd-revert-files-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-files-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-revert-files"),
          title: "Project Revert Files",
          workspaceRoot: "/tmp/project-revert-files",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.make("evt-revert-files-2"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-revert-files-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-files-2"),
        metadata: {},
        payload: {
          threadId,
          projectId: ProjectId.make("project-revert-files"),
          title: "Thread Revert Files",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.turn-diff-completed",
        eventId: EventId.make("evt-revert-files-3"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-revert-files-3"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-files-3"),
        metadata: {},
        payload: {
          threadId,
          turnId: TurnId.make("turn-keep"),
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.make("refs/neokod/checkpoints/thread-revert-files/turn/1"),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.make("message-keep"),
          completedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.make("evt-revert-files-4"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-revert-files-4"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-files-4"),
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.make("message-keep"),
          role: "assistant",
          text: "Keep",
          attachments: [
            {
              type: "image",
              id: keepAttachmentId,
              name: "keep.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          turnId: TurnId.make("turn-keep"),
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.turn-diff-completed",
        eventId: EventId.make("evt-revert-files-5"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-revert-files-5"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-files-5"),
        metadata: {},
        payload: {
          threadId,
          turnId: TurnId.make("turn-remove"),
          checkpointTurnCount: 2,
          checkpointRef: CheckpointRef.make("refs/neokod/checkpoints/thread-revert-files/turn/2"),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.make("message-remove"),
          completedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.make("evt-revert-files-6"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-revert-files-6"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-files-6"),
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.make("message-remove"),
          role: "assistant",
          text: "Remove",
          attachments: [
            {
              type: "image",
              id: removeAttachmentId,
              name: "remove.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          turnId: TurnId.make("turn-remove"),
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      const keepPath = path.join(attachmentsDir, `${keepAttachmentId}.png`);
      const removePath = path.join(attachmentsDir, `${removeAttachmentId}.png`);
      yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
      yield* fileSystem.writeFileString(keepPath, "keep");
      yield* fileSystem.writeFileString(removePath, "remove");
      const otherThreadPath = path.join(attachmentsDir, `${otherThreadAttachmentId}.png`);
      yield* fileSystem.writeFileString(otherThreadPath, "other");
      assert.isTrue(yield* exists(keepPath));
      assert.isTrue(yield* exists(removePath));
      assert.isTrue(yield* exists(otherThreadPath));

      yield* appendAndProject({
        type: "thread.reverted",
        eventId: EventId.make("evt-revert-files-7"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-revert-files-7"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-files-7"),
        metadata: {},
        payload: {
          threadId,
          turnCount: 1,
        },
      });

      assert.isTrue(yield* exists(keepPath));
      assert.isFalse(yield* exists(removePath));
      assert.isTrue(yield* exists(otherThreadPath));
    }),
  );
});

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("neokod-projection-attachments-revert-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("removes thread attachment directory when thread is deleted", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const { attachmentsDir } = yield* ServerConfig;
      const now = "2026-01-01T00:00:00.000Z";
      const threadId = ThreadId.make("Thread Delete.Files");
      const attachmentId = "thread-delete-files-00000000-0000-4000-8000-000000000001";
      const otherThreadAttachmentId =
        "thread-delete-files-extra-00000000-0000-4000-8000-000000000002";

      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.make("evt-delete-files-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-delete-files"),
        occurredAt: now,
        commandId: CommandId.make("cmd-delete-files-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-delete-files-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-delete-files"),
          title: "Project Delete Files",
          workspaceRoot: "/tmp/project-delete-files",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.make("evt-delete-files-2"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-delete-files-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-delete-files-2"),
        metadata: {},
        payload: {
          threadId,
          projectId: ProjectId.make("project-delete-files"),
          title: "Thread Delete Files",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.make("evt-delete-files-3"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-delete-files-3"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-delete-files-3"),
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.make("message-delete-files"),
          role: "user",
          text: "Delete",
          attachments: [
            {
              type: "image",
              id: attachmentId,
              name: "delete.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      const threadAttachmentPath = path.join(attachmentsDir, `${attachmentId}.png`);
      const otherThreadAttachmentPath = path.join(attachmentsDir, `${otherThreadAttachmentId}.png`);
      yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
      yield* fileSystem.writeFileString(threadAttachmentPath, "delete");
      yield* fileSystem.writeFileString(otherThreadAttachmentPath, "other-thread");
      assert.isTrue(yield* exists(threadAttachmentPath));
      assert.isTrue(yield* exists(otherThreadAttachmentPath));

      yield* appendAndProject({
        type: "thread.deleted",
        eventId: EventId.make("evt-delete-files-4"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-delete-files-4"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-delete-files-4"),
        metadata: {},
        payload: {
          threadId,
          deletedAt: now,
        },
      });

      assert.isFalse(yield* exists(threadAttachmentPath));
      assert.isTrue(yield* exists(otherThreadAttachmentPath));
    }),
  );
});

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("neokod-projection-attachments-delete-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("ignores unsafe thread ids for attachment cleanup paths", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const now = "2026-01-01T00:00:00.000Z";
      const { attachmentsDir: attachmentsRootDir, stateDir } = yield* ServerConfig;
      const attachmentsSentinelPath = path.join(attachmentsRootDir, "sentinel.txt");
      const stateDirSentinelPath = path.join(stateDir, "state-sentinel.txt");
      yield* fileSystem.makeDirectory(attachmentsRootDir, { recursive: true });
      yield* fileSystem.writeFileString(attachmentsSentinelPath, "keep-attachments-root");
      yield* fileSystem.writeFileString(stateDirSentinelPath, "keep-state-dir");

      yield* eventStore.append({
        type: "thread.deleted",
        eventId: EventId.make("evt-unsafe-thread-delete"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make(".."),
        occurredAt: now,
        commandId: CommandId.make("cmd-unsafe-thread-delete"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-unsafe-thread-delete"),
        metadata: {},
        payload: {
          threadId: ThreadId.make(".."),
          deletedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;

      assert.isTrue(yield* exists(attachmentsRootDir));
      assert.isTrue(yield* exists(attachmentsSentinelPath));
      assert.isTrue(yield* exists(stateDirSentinelPath));
    }),
  );
});

it.layer(BaseTestLayer)("OrchestrationProjectionPipeline", (it) => {
  it.effect("resumes from projector last_applied_sequence without replaying older events", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.make("evt-a1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-a"),
        occurredAt: now,
        commandId: CommandId.make("cmd-a1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-a1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-a"),
          title: "Project A",
          workspaceRoot: "/tmp/project-a",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.make("evt-a2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-a"),
        occurredAt: now,
        commandId: CommandId.make("cmd-a2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-a2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-a"),
          projectId: ProjectId.make("project-a"),
          title: "Thread A",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-a3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-a"),
        occurredAt: now,
        commandId: CommandId.make("cmd-a3"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-a3"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-a"),
          messageId: MessageId.make("message-a"),
          role: "assistant",
          text: "hello",
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-a4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-a"),
        occurredAt: now,
        commandId: CommandId.make("cmd-a4"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-a4"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-a"),
          messageId: MessageId.make("message-a"),
          role: "assistant",
          text: " world",
          turnId: null,
          streaming: true,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;
      yield* projectionPipeline.bootstrap;

      const messageRows = yield* sql<{ readonly text: string }>`
        SELECT text FROM projection_thread_messages WHERE message_id = 'message-a'
      `;
      assert.deepEqual(messageRows, [{ text: "hello world" }]);

      const stateRows = yield* sql<{
        readonly projector: string;
        readonly lastAppliedSequence: number;
      }>`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
      `;
      const maxSequenceRows = yield* sql<{ readonly maxSequence: number }>`
        SELECT MAX(sequence) AS "maxSequence" FROM orchestration_events
      `;
      const maxSequence = maxSequenceRows[0]?.maxSequence ?? 0;
      for (const row of stateRows) {
        assert.equal(row.lastAppliedSequence, maxSequence);
      }
    }),
  );

  it.effect("keeps the turn running across interim assistant messages until the session ends", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";
      const threadId = ThreadId.make("thread-turn-lifecycle");
      const turnId = TurnId.make("turn-lifecycle-1");

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.make("evt-tl1"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-tl1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-tl1"),
        metadata: {},
        payload: {
          threadId,
          projectId: ProjectId.make("project-turn-lifecycle"),
          title: "Turn lifecycle",
          modelSelection: {
            instanceId: ProviderInstanceId.make("claude"),
            model: "claude-opus",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.session-set",
        eventId: EventId.make("evt-tl2"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2026-01-01T00:00:01.000Z",
        commandId: CommandId.make("cmd-tl2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-tl2"),
        metadata: {},
        payload: {
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "claude",
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: "2026-01-01T00:00:01.000Z",
          },
        },
      });

      // Interim assistant message completes mid-turn (commentary between
      // tool calls) — the turn must stay running and unsettled.
      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-tl3"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2026-01-01T00:00:05.000Z",
        commandId: CommandId.make("cmd-tl3"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-tl3"),
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.make("message-tl-interim"),
          role: "assistant",
          text: "interim commentary",
          turnId,
          streaming: false,
          createdAt: "2026-01-01T00:00:05.000Z",
          updatedAt: "2026-01-01T00:00:05.000Z",
        },
      });

      yield* projectionPipeline.bootstrap;

      const runningRows = yield* sql<{
        readonly state: string;
        readonly completedAt: string | null;
      }>`
        SELECT state, completed_at AS "completedAt"
        FROM projection_turns
        WHERE thread_id = ${threadId} AND turn_id = ${turnId}
      `;
      assert.deepEqual(runningRows, [{ state: "running", completedAt: null }]);

      // The session leaving "running" is the turn-end signal.
      yield* eventStore.append({
        type: "thread.session-set",
        eventId: EventId.make("evt-tl4"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2026-01-01T00:01:00.000Z",
        commandId: CommandId.make("cmd-tl4"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-tl4"),
        metadata: {},
        payload: {
          threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "claude",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-01-01T00:01:00.000Z",
          },
        },
      });

      yield* projectionPipeline.bootstrap;

      const settledRows = yield* sql<{
        readonly state: string;
        readonly completedAt: string | null;
      }>`
        SELECT state, completed_at AS "completedAt"
        FROM projection_turns
        WHERE thread_id = ${threadId} AND turn_id = ${turnId}
      `;
      assert.deepEqual(settledRows, [
        { state: "completed", completedAt: "2026-01-01T00:01:00.000Z" },
      ]);
      const threadRows = yield* sql<{ readonly latestTurnId: string | null }>`
        SELECT latest_turn_id AS "latestTurnId"
        FROM projection_threads
        WHERE thread_id = ${threadId}
      `;
      assert.deepEqual(threadRows, [{ latestTurnId: turnId }]);
    }),
  );

  it.effect(
    "freezes a recovered turn at the session's last observation, not the recovery event time",
    () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const startedAt = "2026-01-01T00:00:00.000Z";
        const lastObservedAt = "2026-01-01T00:05:00.000Z";
        const recoveredAt = "2026-01-02T08:00:00.000Z";
        const threadId = ThreadId.make("thread-recovered-turn-completion");
        const turnId = TurnId.make("turn-recovered-completion");

        yield* eventStore.append({
          type: "thread.created",
          eventId: EventId.make("evt-recovered-turn-created"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: startedAt,
          commandId: CommandId.make("cmd-recovered-turn-created"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-recovered-turn-created"),
          metadata: {},
          payload: {
            threadId,
            projectId: ProjectId.make("project-recovered-turn"),
            title: "Recovered turn",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: startedAt,
            updatedAt: startedAt,
          },
        });

        yield* eventStore.append({
          type: "thread.session-set",
          eventId: EventId.make("evt-recovered-turn-running"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: startedAt,
          commandId: CommandId.make("cmd-recovered-turn-running"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-recovered-turn-running"),
          metadata: {},
          payload: {
            threadId,
            session: {
              threadId,
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: turnId,
              lastError: null,
              updatedAt: startedAt,
            },
          },
        });
        yield* projectionPipeline.bootstrap;

        // Boot recovery arrives the next day, but the last evidence we hold
        // ended five minutes into the turn. The event keeps its server clock
        // position; only the turn's completion freezes at the observation.
        yield* eventStore.append({
          type: "thread.session-set",
          eventId: EventId.make("evt-recovered-turn-interrupted"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: recoveredAt,
          commandId: CommandId.make("cmd-recovered-turn-interrupted"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-recovered-turn-interrupted"),
          metadata: {},
          payload: {
            threadId,
            session: {
              threadId,
              status: "interrupted",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: "recovered after restart",
              updatedAt: recoveredAt,
            },
            latestTurnCompletedAt: lastObservedAt,
          },
        });
        yield* projectionPipeline.bootstrap;

        const turnRows = yield* sql<{
          readonly state: string;
          readonly completedAt: string | null;
        }>`
          SELECT state, completed_at AS "completedAt"
          FROM projection_turns
          WHERE thread_id = ${threadId} AND turn_id = ${turnId}
        `;
        assert.deepEqual(turnRows, [{ state: "interrupted", completedAt: lastObservedAt }]);

        const threadRows = yield* sql<{ readonly updatedAt: string }>`
          SELECT updated_at AS "updatedAt"
          FROM projection_threads
          WHERE thread_id = ${threadId}
        `;
        assert.deepEqual(threadRows, [{ updatedAt: recoveredAt }]);
      }),
  );

  it.effect(
    "keeps an explicitly unknown recovered completion null instead of using recovery time",
    () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const startedAt = "2026-01-01T00:00:00.000Z";
        const recoveredAt = "2026-01-02T08:00:00.000Z";
        const threadId = ThreadId.make("thread-unknown-recovered-completion");
        const turnId = TurnId.make("turn-unknown-recovered-completion");

        yield* eventStore.append({
          type: "thread.created",
          eventId: EventId.make("evt-unknown-recovered-created"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: startedAt,
          commandId: CommandId.make("cmd-unknown-recovered-created"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-unknown-recovered-created"),
          metadata: {},
          payload: {
            threadId,
            projectId: ProjectId.make("project-unknown-recovered"),
            title: "Unknown recovered turn",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: startedAt,
            updatedAt: startedAt,
          },
        });

        yield* eventStore.append({
          type: "thread.session-set",
          eventId: EventId.make("evt-unknown-recovered-running"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: startedAt,
          commandId: CommandId.make("cmd-unknown-recovered-running"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-unknown-recovered-running"),
          metadata: {},
          payload: {
            threadId,
            session: {
              threadId,
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: turnId,
              lastError: null,
              updatedAt: startedAt,
            },
          },
        });
        yield* projectionPipeline.bootstrap;

        yield* eventStore.append({
          type: "thread.session-set",
          eventId: EventId.make("evt-unknown-recovered-interrupted"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: recoveredAt,
          commandId: CommandId.make("cmd-unknown-recovered-interrupted"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-unknown-recovered-interrupted"),
          metadata: {},
          payload: {
            threadId,
            session: {
              threadId,
              status: "interrupted",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: "recovered after restart",
              updatedAt: recoveredAt,
            },
            latestTurnCompletedAt: null,
          },
        });
        yield* projectionPipeline.bootstrap;

        const turnRows = yield* sql<{
          readonly state: string;
          readonly completedAt: string | null;
        }>`
          SELECT state, completed_at AS "completedAt"
          FROM projection_turns
          WHERE thread_id = ${threadId} AND turn_id = ${turnId}
        `;
        assert.deepEqual(turnRows, [{ state: "interrupted", completedAt: null }]);

        const threadRows = yield* sql<{ readonly updatedAt: string }>`
          SELECT updated_at AS "updatedAt"
          FROM projection_threads
          WHERE thread_id = ${threadId}
        `;
        assert.deepEqual(threadRows, [{ updatedAt: recoveredAt }]);

        // Synthetic message closure must not turn explicit unknown completion
        // into a known timestamp in durable state.
        const messageAt = "2026-01-02T08:05:00.000Z";
        yield* eventStore.append({
          type: "thread.message-sent",
          eventId: EventId.make("evt-unknown-recovered-message"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: messageAt,
          commandId: CommandId.make("cmd-unknown-recovered-message"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-unknown-recovered-message"),
          metadata: {},
          payload: {
            threadId,
            messageId: MessageId.make("message-unknown-recovered"),
            role: "assistant",
            text: "",
            turnId,
            streaming: false,
            createdAt: messageAt,
            updatedAt: messageAt,
          },
        });
        yield* projectionPipeline.bootstrap;

        const afterMessage = yield* sql<{
          readonly state: string;
          readonly completedAt: string | null;
        }>`
          SELECT state, completed_at AS "completedAt"
          FROM projection_turns
          WHERE thread_id = ${threadId} AND turn_id = ${turnId}
        `;
        assert.deepEqual(afterMessage, [{ state: "interrupted", completedAt: null }]);
      }),
  );

  it.effect("settles a superseded running turn when a new turn becomes active", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";
      const threadId = ThreadId.make("thread-turn-supersede");
      const oldTurnId = TurnId.make("turn-superseded");
      const newTurnId = TurnId.make("turn-steer");

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.make("evt-ts1"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-ts1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-ts1"),
        metadata: {},
        payload: {
          threadId,
          projectId: ProjectId.make("project-turn-supersede"),
          title: "Turn supersede",
          modelSelection: {
            instanceId: ProviderInstanceId.make("opencode"),
            model: "big-pickle",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      const appendRunningSessionSet = (eventId: string, turnId: TurnId, updatedAt: string) =>
        eventStore.append({
          type: "thread.session-set",
          eventId: EventId.make(eventId),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: updatedAt,
          commandId: CommandId.make(`cmd-${eventId}`),
          causationEventId: null,
          correlationId: CorrelationId.make(`cmd-${eventId}`),
          metadata: {},
          payload: {
            threadId,
            session: {
              threadId,
              status: "running",
              providerName: "opencode",
              runtimeMode: "full-access",
              activeTurnId: turnId,
              lastError: null,
              updatedAt,
            },
          },
        });

      yield* appendRunningSessionSet("evt-ts2", oldTurnId, "2026-01-01T00:00:01.000Z");
      // A steer: a new turn becomes active without the provider ever
      // completing the previous one.
      yield* appendRunningSessionSet("evt-ts3", newTurnId, "2026-01-01T00:00:30.000Z");

      yield* projectionPipeline.bootstrap;

      const rows = yield* sql<{
        readonly turnId: string;
        readonly state: string;
        readonly completedAt: string | null;
      }>`
        SELECT turn_id AS "turnId", state, completed_at AS "completedAt"
        FROM projection_turns
        WHERE thread_id = ${threadId}
        ORDER BY requested_at
      `;
      assert.deepEqual(rows, [
        { turnId: oldTurnId, state: "completed", completedAt: "2026-01-01T00:00:30.000Z" },
        { turnId: newTurnId, state: "running", completedAt: null },
      ]);
    }),
  );

  it.effect("settles only the turn named by an explicit session outcome", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));
      const now = "2026-03-01T13:00:00.000Z";
      const endedAt = "2026-03-01T13:01:00.000Z";
      const threadId = ThreadId.make("thread-explicit-outcome");
      const staleTurnId = TurnId.make("turn-explicit-stale");
      const newerTurnId = TurnId.make("turn-explicit-newer");

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.make("evt-explicit-outcome-1"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-explicit-outcome-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-explicit-outcome-1"),
        metadata: {},
        payload: {
          threadId,
          projectId: ProjectId.make("project-explicit-outcome"),
          title: "Explicit outcome",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.session-set",
        eventId: EventId.make("evt-explicit-outcome-2"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2026-03-01T13:00:01.000Z",
        commandId: CommandId.make("cmd-explicit-outcome-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-explicit-outcome-2"),
        metadata: {},
        payload: {
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: staleTurnId,
            lastError: null,
            updatedAt: "2026-03-01T13:00:01.000Z",
          },
        },
      });

      // Newer work is already running when the stale turn's outcome arrives.
      // A new active turn normally supersedes the previous row, so insert the
      // newer running row and session binding directly to isolate the
      // late-outcome guard.
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, state, requested_at, started_at, checkpoint_files_json
        ) VALUES (
          ${threadId}, ${newerTurnId}, 'running',
          '2026-03-01T13:00:30.000Z', '2026-03-01T13:00:30.000Z', '[]'
        )
      `;
      yield* sql`
        UPDATE projection_thread_sessions
        SET status = 'running',
            active_turn_id = ${newerTurnId},
            updated_at = '2026-03-01T13:00:30.000Z'
        WHERE thread_id = ${threadId}
      `;
      yield* sql`
        UPDATE projection_threads
        SET latest_turn_id = ${newerTurnId}
        WHERE thread_id = ${threadId}
      `;

      yield* appendAndProject({
        type: "thread.turn-start-requested",
        eventId: EventId.make("evt-explicit-outcome-pending-b"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2026-03-01T13:00:35.000Z",
        commandId: CommandId.make("cmd-explicit-outcome-pending-b"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-explicit-outcome-pending-b"),
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.make("message-pending-newer"),
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: "2026-03-01T13:00:35.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.session-set",
        eventId: EventId.make("evt-explicit-outcome-3"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: endedAt,
        commandId: CommandId.make("cmd-explicit-outcome-3"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-explicit-outcome-3"),
        metadata: {},
        payload: {
          threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: endedAt,
          },
          interruptedTurnId: staleTurnId,
          latestTurnOutcome: "interrupted",
        },
      });

      const rows = yield* sql<{
        readonly turnId: string;
        readonly state: string;
        readonly completedAt: string | null;
      }>`
        SELECT turn_id AS "turnId", state, completed_at AS "completedAt"
        FROM projection_turns
        WHERE thread_id = ${threadId} AND turn_id IS NOT NULL
        ORDER BY requested_at
      `;
      assert.deepEqual(rows, [
        { turnId: staleTurnId, state: "interrupted", completedAt: endedAt },
        { turnId: newerTurnId, state: "running", completedAt: null },
      ]);

      const settlements = yield* sql<{
        readonly turnId: string;
        readonly completedAt: string | null;
      }>`
        SELECT turn_id AS "turnId", completed_at AS "completedAt"
        FROM projection_turn_settlements
        WHERE thread_id = ${threadId}
        ORDER BY turn_id
      `;
      assert.deepEqual(settlements, [{ turnId: staleTurnId, completedAt: endedAt }]);

      const sessions = yield* sql<{
        readonly status: string;
        readonly activeTurnId: string | null;
      }>`
        SELECT status, active_turn_id AS "activeTurnId"
        FROM projection_thread_sessions
        WHERE thread_id = ${threadId}
      `;
      assert.deepEqual(sessions, [{ status: "running", activeTurnId: newerTurnId }]);

      const threadRows = yield* sql<{ readonly latestTurnId: string | null }>`
        SELECT latest_turn_id AS "latestTurnId"
        FROM projection_threads
        WHERE thread_id = ${threadId}
      `;
      assert.deepEqual(threadRows, [{ latestTurnId: newerTurnId }]);

      // A delayed legacy running update for the terminal old turn must not
      // supersede the running newer turn or consume its pending start.
      yield* appendAndProject({
        type: "thread.session-set",
        eventId: EventId.make("evt-explicit-outcome-delayed-running"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2026-03-01T13:01:30.000Z",
        commandId: CommandId.make("cmd-explicit-outcome-delayed-running"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-explicit-outcome-delayed-running"),
        metadata: {},
        payload: {
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: staleTurnId,
            lastError: null,
            updatedAt: "2026-03-01T13:01:30.000Z",
          },
        },
      });

      const afterDelayedRunningTurns = yield* sql<{
        readonly turnId: string;
        readonly state: string;
      }>`
        SELECT turn_id AS "turnId", state
        FROM projection_turns
        WHERE thread_id = ${threadId} AND turn_id IS NOT NULL
        ORDER BY requested_at
      `;
      assert.deepEqual(afterDelayedRunningTurns, [
        { turnId: staleTurnId, state: "interrupted" },
        { turnId: newerTurnId, state: "running" },
      ]);
      const afterDelayedRunningSession = yield* sql<{
        readonly status: string;
        readonly activeTurnId: string | null;
      }>`
        SELECT status, active_turn_id AS "activeTurnId"
        FROM projection_thread_sessions
        WHERE thread_id = ${threadId}
      `;
      assert.deepEqual(afterDelayedRunningSession, [
        { status: "running", activeTurnId: newerTurnId },
      ]);
      const afterDelayedRunningPointer = yield* sql<{ readonly latestTurnId: string | null }>`
        SELECT latest_turn_id AS "latestTurnId"
        FROM projection_threads
        WHERE thread_id = ${threadId}
      `;
      assert.deepEqual(afterDelayedRunningPointer, [{ latestTurnId: newerTurnId }]);
      const pendingStarts = yield* sql<{
        readonly messageId: string | null;
        readonly state: string;
      }>`
        SELECT pending_message_id AS "messageId", state
        FROM projection_turns
        WHERE thread_id = ${threadId} AND turn_id IS NULL
      `;
      assert.deepEqual(pendingStarts, [{ messageId: "message-pending-newer", state: "pending" }]);
      const falseSettlements = yield* sql<{ readonly turnId: string }>`
        SELECT turn_id AS "turnId"
        FROM projection_turn_settlements
        WHERE thread_id = ${threadId} AND turn_id = ${newerTurnId}
      `;
      assert.deepEqual(falseSettlements, []);

      const appendOldCheckpoint = (
        eventId: string,
        occurredAt: string,
        checkpointTurnCount: number,
      ) =>
        appendAndProject({
          type: "thread.turn-diff-completed",
          eventId: EventId.make(eventId),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt,
          commandId: CommandId.make(`cmd-${eventId}`),
          causationEventId: null,
          correlationId: CorrelationId.make(`cmd-${eventId}`),
          metadata: {},
          payload: {
            threadId,
            turnId: staleTurnId,
            checkpointTurnCount,
            checkpointRef: CheckpointRef.make(
              `refs/neokod/checkpoints/thread-explicit-outcome/turn/${checkpointTurnCount}`,
            ),
            status: "ready",
            files: [],
            assistantMessageId: null,
            completedAt: occurredAt,
          },
        });

      // A late checkpoint for the historical turn must not replace the newer
      // latest-turn pointer or its running session.
      yield* appendOldCheckpoint("evt-explicit-outcome-4", "2026-03-01T13:02:00.000Z", 1);
      const runningPointer = yield* sql<{ readonly latestTurnId: string | null }>`
        SELECT latest_turn_id AS "latestTurnId"
        FROM projection_threads
        WHERE thread_id = ${threadId}
      `;
      assert.deepEqual(runningPointer, [{ latestTurnId: newerTurnId }]);
      const runningSession = yield* sql<{
        readonly status: string;
        readonly activeTurnId: string | null;
      }>`
        SELECT status, active_turn_id AS "activeTurnId"
        FROM projection_thread_sessions
        WHERE thread_id = ${threadId}
      `;
      assert.deepEqual(runningSession, [{ status: "running", activeTurnId: newerTurnId }]);

      yield* appendAndProject({
        type: "thread.session-set",
        eventId: EventId.make("evt-explicit-outcome-5"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2026-03-01T13:03:00.000Z",
        commandId: CommandId.make("cmd-explicit-outcome-5"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-explicit-outcome-5"),
        metadata: {},
        payload: {
          threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-03-01T13:03:00.000Z",
          },
        },
      });

      // Repeat the late checkpoint after the newer turn settles. The pointer
      // must remain on the newer turn while the old turn keeps its metadata.
      yield* appendOldCheckpoint("evt-explicit-outcome-6", "2026-03-01T13:04:00.000Z", 2);
      const settledPointer = yield* sql<{ readonly latestTurnId: string | null }>`
        SELECT latest_turn_id AS "latestTurnId"
        FROM projection_threads
        WHERE thread_id = ${threadId}
      `;
      assert.deepEqual(settledPointer, [{ latestTurnId: newerTurnId }]);
      const settledSession = yield* sql<{ readonly status: string }>`
        SELECT status
        FROM projection_thread_sessions
        WHERE thread_id = ${threadId}
      `;
      assert.deepEqual(settledSession, [{ status: "ready" }]);
      const oldTurnRows = yield* sql<{
        readonly state: string;
        readonly checkpointTurnCount: number | null;
      }>`
        SELECT state, checkpoint_turn_count AS "checkpointTurnCount"
        FROM projection_turns
        WHERE thread_id = ${threadId} AND turn_id = ${staleTurnId}
      `;
      assert.deepEqual(oldTurnRows, [{ state: "interrupted", checkpointTurnCount: 2 }]);
      const newerTurnRows = yield* sql<{ readonly state: string }>`
        SELECT state
        FROM projection_turns
        WHERE thread_id = ${threadId} AND turn_id = ${newerTurnId}
      `;
      assert.deepEqual(newerTurnRows, [{ state: "completed" }]);
    }),
  );

  it.effect("replays a delayed old running update without mutating a newer turn", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("project-bootstrap-late-running");
      const threadId = ThreadId.make("thread-bootstrap-late-running");
      const oldTurnId = TurnId.make("turn-bootstrap-old");
      const newTurnId = TurnId.make("turn-bootstrap-new");
      const pendingMessageId = MessageId.make("message-bootstrap-pending");
      const laggingProjectId = ProjectId.make("project-bootstrap-lagging");
      const laggingThreadId = ThreadId.make("thread-bootstrap-lagging");
      const laggingTurnId = TurnId.make("turn-bootstrap-lagging");

      const events: ReadonlyArray<Parameters<typeof eventStore.append>[0]> = [
        {
          type: "project.created",
          eventId: EventId.make("evt-bootstrap-late-1"),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: "2026-03-03T13:00:00.000Z",
          commandId: CommandId.make("cmd-bootstrap-late-1"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-bootstrap-late-1"),
          metadata: {},
          payload: {
            projectId,
            title: "Bootstrap late running",
            workspaceRoot: "/tmp/bootstrap-late-running",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-03-03T13:00:00.000Z",
            updatedAt: "2026-03-03T13:00:00.000Z",
          },
        },
        {
          type: "thread.created",
          eventId: EventId.make("evt-bootstrap-late-2"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-03-03T13:00:01.000Z",
          commandId: CommandId.make("cmd-bootstrap-late-2"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-bootstrap-late-2"),
          metadata: {},
          payload: {
            threadId,
            projectId,
            title: "Bootstrap late running",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: "2026-03-03T13:00:01.000Z",
            updatedAt: "2026-03-03T13:00:01.000Z",
          },
        },
        {
          type: "thread.session-set",
          eventId: EventId.make("evt-bootstrap-late-3"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-03-03T13:00:02.000Z",
          commandId: CommandId.make("cmd-bootstrap-late-3"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-bootstrap-late-3"),
          metadata: {},
          payload: {
            threadId,
            session: {
              threadId,
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: oldTurnId,
              lastError: null,
              updatedAt: "2026-03-03T13:00:02.000Z",
            },
          },
        },
        {
          type: "thread.session-set",
          eventId: EventId.make("evt-bootstrap-late-4"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-03-03T13:00:03.000Z",
          commandId: CommandId.make("cmd-bootstrap-late-4"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-bootstrap-late-4"),
          metadata: {},
          payload: {
            threadId,
            session: {
              threadId,
              status: "ready",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: "2026-03-03T13:00:03.000Z",
            },
            interruptedTurnId: oldTurnId,
            latestTurnOutcome: "interrupted",
          },
        },
        {
          type: "thread.session-set",
          eventId: EventId.make("evt-bootstrap-late-5"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-03-03T13:00:04.000Z",
          commandId: CommandId.make("cmd-bootstrap-late-5"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-bootstrap-late-5"),
          metadata: {},
          payload: {
            threadId,
            session: {
              threadId,
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: newTurnId,
              lastError: null,
              updatedAt: "2026-03-03T13:00:04.000Z",
            },
          },
        },
        {
          type: "thread.turn-start-requested",
          eventId: EventId.make("evt-bootstrap-late-6"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-03-03T13:00:05.000Z",
          commandId: CommandId.make("cmd-bootstrap-late-6"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-bootstrap-late-6"),
          metadata: {},
          payload: {
            threadId,
            messageId: pendingMessageId,
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: "2026-03-03T13:00:05.000Z",
          },
        },
        {
          type: "thread.session-set",
          eventId: EventId.make("evt-bootstrap-late-7"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-03-03T13:00:06.000Z",
          commandId: CommandId.make("cmd-bootstrap-late-7"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-bootstrap-late-7"),
          metadata: {},
          payload: {
            threadId,
            session: {
              threadId,
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: oldTurnId,
              lastError: null,
              updatedAt: "2026-03-03T13:00:06.000Z",
            },
          },
        },
        {
          type: "project.created",
          eventId: EventId.make("evt-bootstrap-late-8"),
          aggregateKind: "project",
          aggregateId: laggingProjectId,
          occurredAt: "2026-03-03T13:10:00.000Z",
          commandId: CommandId.make("cmd-bootstrap-late-8"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-bootstrap-late-8"),
          metadata: {},
          payload: {
            projectId: laggingProjectId,
            title: "Bootstrap lagging projector",
            workspaceRoot: "/tmp/bootstrap-lagging",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-03-03T13:10:00.000Z",
            updatedAt: "2026-03-03T13:10:00.000Z",
          },
        },
        {
          type: "thread.created",
          eventId: EventId.make("evt-bootstrap-late-9"),
          aggregateKind: "thread",
          aggregateId: laggingThreadId,
          occurredAt: "2026-03-03T13:10:01.000Z",
          commandId: CommandId.make("cmd-bootstrap-late-9"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-bootstrap-late-9"),
          metadata: {},
          payload: {
            threadId: laggingThreadId,
            projectId: laggingProjectId,
            title: "Bootstrap lagging projector",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: "2026-03-03T13:10:01.000Z",
            updatedAt: "2026-03-03T13:10:01.000Z",
          },
        },
        {
          type: "thread.session-set",
          eventId: EventId.make("evt-bootstrap-late-10"),
          aggregateKind: "thread",
          aggregateId: laggingThreadId,
          occurredAt: "2026-03-03T13:10:02.000Z",
          commandId: CommandId.make("cmd-bootstrap-late-10"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-bootstrap-late-10"),
          metadata: {},
          payload: {
            threadId: laggingThreadId,
            session: {
              threadId: laggingThreadId,
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: laggingTurnId,
              lastError: null,
              updatedAt: "2026-03-03T13:10:02.000Z",
            },
          },
        },
        {
          type: "thread.session-set",
          eventId: EventId.make("evt-bootstrap-late-11"),
          aggregateKind: "thread",
          aggregateId: laggingThreadId,
          occurredAt: "2026-03-03T13:10:03.000Z",
          commandId: CommandId.make("cmd-bootstrap-late-11"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-bootstrap-late-11"),
          metadata: {},
          payload: {
            threadId: laggingThreadId,
            session: {
              threadId: laggingThreadId,
              status: "ready",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: "2026-03-03T13:10:03.000Z",
            },
            interruptedTurnId: laggingTurnId,
            latestTurnOutcome: "interrupted",
          },
        },
      ];

      const savedEvents = yield* Effect.forEach(events, (event) => eventStore.append(event), {
        concurrency: 1,
      });
      yield* projectionPipeline.bootstrap;

      const turns = yield* sql<{ readonly turnId: string; readonly state: string }>`
        SELECT turn_id AS "turnId", state
        FROM projection_turns
        WHERE thread_id = ${threadId} AND turn_id IS NOT NULL
        ORDER BY requested_at
      `;
      assert.deepEqual(turns, [
        { turnId: oldTurnId, state: "interrupted" },
        { turnId: newTurnId, state: "running" },
      ]);
      const sessions = yield* sql<{
        readonly status: string;
        readonly activeTurnId: string | null;
      }>`
        SELECT status, active_turn_id AS "activeTurnId"
        FROM projection_thread_sessions
        WHERE thread_id = ${threadId}
      `;
      assert.deepEqual(sessions, [{ status: "running", activeTurnId: newTurnId }]);
      const threads = yield* sql<{ readonly latestTurnId: string | null }>`
        SELECT latest_turn_id AS "latestTurnId"
        FROM projection_threads
        WHERE thread_id = ${threadId}
      `;
      assert.deepEqual(threads, [{ latestTurnId: newTurnId }]);
      const pending = yield* sql<{ readonly messageId: string | null; readonly state: string }>`
        SELECT pending_message_id AS "messageId", state
        FROM projection_turns
        WHERE thread_id = ${threadId} AND turn_id IS NULL
      `;
      assert.deepEqual(pending, [{ messageId: pendingMessageId, state: "pending" }]);
      const settlements = yield* sql<{ readonly turnId: string }>`
        SELECT turn_id AS "turnId"
        FROM projection_turn_settlements
        WHERE thread_id = ${threadId}
        ORDER BY turn_id
      `;
      assert.deepEqual(settlements, [{ turnId: oldTurnId }]);

      // Full replay parity for the independently advanced lagging case.
      const laggingPointerBefore = yield* sql<{ readonly latestTurnId: string | null }>`
        SELECT latest_turn_id AS "latestTurnId"
        FROM projection_threads
        WHERE thread_id = ${laggingThreadId}
      `;
      assert.deepEqual(laggingPointerBefore, [{ latestTurnId: laggingTurnId }]);

      // A supported partial interruption has sessions and turns at event 10
      // and threads at event 9. Replaying the final terminal event is allowed.
      yield* sql`
        UPDATE projection_state
        SET last_applied_sequence = ${savedEvents[9]!.sequence},
            updated_at = ${savedEvents[9]!.occurredAt}
        WHERE projector = ${ORCHESTRATION_PROJECTOR_NAMES.threads}
      `;
      yield* projectionPipeline.bootstrap;
      const supportedPointer = yield* sql<{ readonly latestTurnId: string | null }>`
        SELECT latest_turn_id AS "latestTurnId"
        FROM projection_threads
        WHERE thread_id = ${laggingThreadId}
      `;
      assert.deepEqual(supportedPointer, [{ latestTurnId: laggingTurnId }]);
      const supportedCursors = yield* sql<{
        readonly projector: string;
        readonly lastAppliedSequence: number;
      }>`
        SELECT projector, last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
        WHERE projector IN (
          ${ORCHESTRATION_PROJECTOR_NAMES.threadSessions},
          ${ORCHESTRATION_PROJECTOR_NAMES.threadTurns},
          ${ORCHESTRATION_PROJECTOR_NAMES.threads}
        )
        ORDER BY projector
      `;
      assert.deepEqual(supportedCursors, [
        {
          projector: ORCHESTRATION_PROJECTOR_NAMES.threadSessions,
          lastAppliedSequence: savedEvents[10]!.sequence,
        },
        {
          projector: ORCHESTRATION_PROJECTOR_NAMES.threadTurns,
          lastAppliedSequence: savedEvents[10]!.sequence,
        },
        {
          projector: ORCHESTRATION_PROJECTOR_NAMES.threads,
          lastAppliedSequence: savedEvents[10]!.sequence,
        },
      ]);

      // Unsupported skew: sessions/turns hold future terminal evidence while
      // threads is two or more events behind. Bootstrap must refuse before any
      // projection side effects and leave rows and cursors unchanged.
      yield* sql`
        UPDATE projection_state
        SET last_applied_sequence = ${savedEvents[8]!.sequence},
            updated_at = ${savedEvents[8]!.occurredAt}
        WHERE projector = ${ORCHESTRATION_PROJECTOR_NAMES.threads}
      `;
      yield* sql`
        UPDATE projection_threads
        SET latest_turn_id = NULL
        WHERE thread_id = ${laggingThreadId}
      `;
      const error = yield* Effect.flip(projectionPipeline.bootstrap);
      assert.strictEqual(error._tag, "PersistenceSqlError");
      assert.match(error.message, /coordinated recovery/);

      const refusedPointer = yield* sql<{ readonly latestTurnId: string | null }>`
        SELECT latest_turn_id AS "latestTurnId"
        FROM projection_threads
        WHERE thread_id = ${laggingThreadId}
      `;
      assert.deepEqual(refusedPointer, [{ latestTurnId: null }]);
      const refusedCursors = yield* sql<{
        readonly projector: string;
        readonly lastAppliedSequence: number;
      }>`
        SELECT projector, last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
        WHERE projector IN (
          ${ORCHESTRATION_PROJECTOR_NAMES.threadSessions},
          ${ORCHESTRATION_PROJECTOR_NAMES.threadTurns},
          ${ORCHESTRATION_PROJECTOR_NAMES.threads}
        )
        ORDER BY projector
      `;
      assert.deepEqual(refusedCursors, [
        {
          projector: ORCHESTRATION_PROJECTOR_NAMES.threadSessions,
          lastAppliedSequence: savedEvents[10]!.sequence,
        },
        {
          projector: ORCHESTRATION_PROJECTOR_NAMES.threadTurns,
          lastAppliedSequence: savedEvents[10]!.sequence,
        },
        {
          projector: ORCHESTRATION_PROJECTOR_NAMES.threads,
          lastAppliedSequence: savedEvents[8]!.sequence,
        },
      ]);
      const refusedSession = yield* sql<{
        readonly status: string;
        readonly activeTurnId: string | null;
      }>`
        SELECT status, active_turn_id AS "activeTurnId"
        FROM projection_thread_sessions
        WHERE thread_id = ${laggingThreadId}
      `;
      assert.deepEqual(refusedSession, [{ status: "ready", activeTurnId: null }]);
      const refusedTurn = yield* sql<{ readonly state: string }>`
        SELECT state
        FROM projection_turns
        WHERE thread_id = ${laggingThreadId} AND turn_id = ${laggingTurnId}
      `;
      assert.deepEqual(refusedTurn, [{ state: "interrupted" }]);
      // Restore a supported cursor shape for subsequent tests in this shared
      // layer without changing any projected rows.
      yield* sql`
        UPDATE projection_state
        SET last_applied_sequence = ${savedEvents[10]!.sequence},
            updated_at = ${savedEvents[10]!.occurredAt}
        WHERE projector = ${ORCHESTRATION_PROJECTOR_NAMES.threads}
      `;
    }),
  );

  it.effect(
    "replays legacy runtime items from cursor zero without disturbing coupled projections",
    () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const projectId = ProjectId.make("project-legacy-runtime-items");
        const threadId = ThreadId.make("thread-legacy-runtime-items");
        const sessionId = RuntimeSessionId.make("session-legacy-runtime-items");
        const firstTurnId = TurnId.make("turn-legacy-runtime-items-1");
        const secondTurnId = TurnId.make("turn-legacy-runtime-items-2");
        const firstItemId = RuntimeItemId.make("runtime-legacy-item-1");
        const secondItemId = RuntimeItemId.make("runtime-legacy-item-2");
        const pendingMessageId = MessageId.make("message-legacy-pending");

        const sessionSet = (
          eventId: string,
          occurredAt: string,
          status: "running" | "ready",
          activeTurnId: TurnId | null,
        ): Parameters<typeof eventStore.append>[0] => ({
          type: "thread.session-set",
          eventId: EventId.make(eventId),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt,
          commandId: CommandId.make(`cmd-${eventId}`),
          causationEventId: null,
          correlationId: CorrelationId.make(`cmd-${eventId}`),
          metadata: {},
          payload: {
            threadId,
            session: {
              threadId,
              status,
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId,
              lastError: null,
              updatedAt: occurredAt,
            },
          },
        });
        const checkpoint = (
          eventId: string,
          occurredAt: string,
          turnId: TurnId,
          checkpointTurnCount: number,
        ): Parameters<typeof eventStore.append>[0] => ({
          type: "thread.turn-diff-completed",
          eventId: EventId.make(eventId),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt,
          commandId: CommandId.make(`cmd-${eventId}`),
          causationEventId: null,
          correlationId: CorrelationId.make(`cmd-${eventId}`),
          metadata: {},
          payload: {
            threadId,
            turnId,
            checkpointTurnCount,
            checkpointRef: CheckpointRef.make(
              `refs/neokod/checkpoints/${threadId}/turn/${checkpointTurnCount}`,
            ),
            status: "ready",
            files: [],
            assistantMessageId: null,
            completedAt: occurredAt,
          },
        });
        const observation = (
          eventId: string,
          occurredAt: string,
          runtimeItemId: RuntimeItemId,
          turnId: TurnId,
        ): Parameters<typeof eventStore.append>[0] => ({
          type: "thread.runtime-item-observed",
          eventId: EventId.make(eventId),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt,
          commandId: CommandId.make(`cmd-${eventId}`),
          causationEventId: null,
          correlationId: CorrelationId.make(`cmd-${eventId}`),
          metadata: {},
          payload: {
            threadId,
            observation: {
              runtimeItemId,
              providerItemId: null,
              sessionId,
              kind: "tool",
              scope: "turn",
              turnId,
              providerState: "completed",
              label: "Legacy runtime item",
              providerEventId: EventId.make(`provider-${eventId}`),
              observedAt: occurredAt,
            },
          },
        });

        const events: ReadonlyArray<Parameters<typeof eventStore.append>[0]> = [
          {
            type: "project.created",
            eventId: EventId.make("evt-legacy-runtime-1"),
            aggregateKind: "project",
            aggregateId: projectId,
            occurredAt: "2026-03-04T13:00:00.000Z",
            commandId: CommandId.make("cmd-legacy-runtime-1"),
            causationEventId: null,
            correlationId: CorrelationId.make("cmd-legacy-runtime-1"),
            metadata: {},
            payload: {
              projectId,
              title: "Legacy runtime items",
              workspaceRoot: "/tmp/legacy-runtime-items",
              defaultModelSelection: null,
              scripts: [],
              createdAt: "2026-03-04T13:00:00.000Z",
              updatedAt: "2026-03-04T13:00:00.000Z",
            },
          },
          {
            type: "thread.created",
            eventId: EventId.make("evt-legacy-runtime-2"),
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: "2026-03-04T13:00:01.000Z",
            commandId: CommandId.make("cmd-legacy-runtime-2"),
            causationEventId: null,
            correlationId: CorrelationId.make("cmd-legacy-runtime-2"),
            metadata: {},
            payload: {
              threadId,
              projectId,
              title: "Legacy runtime items",
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-5-codex",
              },
              runtimeMode: "full-access",
              branch: null,
              worktreePath: null,
              createdAt: "2026-03-04T13:00:01.000Z",
              updatedAt: "2026-03-04T13:00:01.000Z",
            },
          },
          sessionSet("evt-legacy-runtime-3", "2026-03-04T13:00:02.000Z", "running", firstTurnId),
          checkpoint("evt-legacy-runtime-4", "2026-03-04T13:00:03.000Z", firstTurnId, 1),
          observation("evt-legacy-runtime-5", "2026-03-04T13:00:04.000Z", firstItemId, firstTurnId),
          sessionSet("evt-legacy-runtime-6", "2026-03-04T13:00:05.000Z", "ready", null),
          sessionSet("evt-legacy-runtime-7", "2026-03-04T13:00:06.000Z", "running", secondTurnId),
          checkpoint("evt-legacy-runtime-8", "2026-03-04T13:00:07.000Z", secondTurnId, 2),
          observation(
            "evt-legacy-runtime-9",
            "2026-03-04T13:00:08.000Z",
            secondItemId,
            secondTurnId,
          ),
          sessionSet("evt-legacy-runtime-10", "2026-03-04T13:00:09.000Z", "ready", null),
          {
            type: "thread.reverted",
            eventId: EventId.make("evt-legacy-runtime-11"),
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: "2026-03-04T13:00:10.000Z",
            commandId: CommandId.make("cmd-legacy-runtime-11"),
            causationEventId: null,
            correlationId: CorrelationId.make("cmd-legacy-runtime-11"),
            metadata: {},
            payload: { threadId, turnCount: 1 },
          },
          {
            type: "thread.turn-start-requested",
            eventId: EventId.make("evt-legacy-runtime-12"),
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: "2026-03-04T13:00:11.000Z",
            commandId: CommandId.make("cmd-legacy-runtime-12"),
            causationEventId: null,
            correlationId: CorrelationId.make("cmd-legacy-runtime-12"),
            metadata: {},
            payload: {
              threadId,
              messageId: pendingMessageId,
              runtimeMode: "full-access",
              interactionMode: "default",
              createdAt: "2026-03-04T13:00:11.000Z",
            },
          },
        ];

        const savedEvents = yield* Effect.forEach(events, (event) => eventStore.append(event), {
          concurrency: 1,
        });
        yield* projectionPipeline.bootstrap;

        const readState = Effect.gen(function* () {
          const runtimeItems = yield* sql<{
            readonly runtimeItemId: string;
            readonly turnId: string | null;
            readonly effectiveState: string;
          }>`
          SELECT
            runtime_item_id AS "runtimeItemId",
            turn_id AS "turnId",
            effective_state AS "effectiveState"
          FROM projection_runtime_items
          WHERE thread_id = ${threadId}
          ORDER BY runtime_item_id
        `;
          const session = yield* sql<{
            readonly status: string;
            readonly activeTurnId: string | null;
          }>`
          SELECT status, active_turn_id AS "activeTurnId"
          FROM projection_thread_sessions
          WHERE thread_id = ${threadId}
        `;
          const turns = yield* sql<{
            readonly turnId: string;
            readonly state: string;
            readonly checkpointTurnCount: number | null;
          }>`
          SELECT
            turn_id AS "turnId",
            state,
            checkpoint_turn_count AS "checkpointTurnCount"
          FROM projection_turns
          WHERE thread_id = ${threadId} AND turn_id IS NOT NULL
          ORDER BY requested_at
        `;
          const thread = yield* sql<{ readonly latestTurnId: string | null }>`
          SELECT latest_turn_id AS "latestTurnId"
          FROM projection_threads
          WHERE thread_id = ${threadId}
        `;
          const pending = yield* sql<{
            readonly messageId: string | null;
            readonly state: string;
          }>`
          SELECT pending_message_id AS "messageId", state
          FROM projection_turns
          WHERE thread_id = ${threadId} AND turn_id IS NULL
        `;
          const settlements = yield* sql<{
            readonly turnId: string;
            readonly completedAt: string | null;
          }>`
          SELECT turn_id AS "turnId", completed_at AS "completedAt"
          FROM projection_turn_settlements
          WHERE thread_id = ${threadId}
          ORDER BY turn_id
        `;
          return { runtimeItems, session, turns, thread, pending, settlements };
        });

        const fullReplay = yield* readState;
        assert.deepEqual(fullReplay.runtimeItems, [
          { runtimeItemId: firstItemId, turnId: firstTurnId, effectiveState: "completed" },
        ]);
        assert.deepEqual(fullReplay.session, [{ status: "ready", activeTurnId: null }]);
        assert.deepEqual(fullReplay.turns, [
          { turnId: firstTurnId, state: "completed", checkpointTurnCount: 1 },
        ]);
        assert.deepEqual(fullReplay.pending, [{ messageId: pendingMessageId, state: "pending" }]);
        assert.ok(fullReplay.settlements.length > 0);

        // Migration 040 created runtime_items without a cursor. Simulate that
        // upgrade shape: runtime items start at zero while every other projector
        // is current.
        yield* sql`
        UPDATE projection_state
        SET last_applied_sequence = 0,
            updated_at = ${savedEvents[0]!.occurredAt}
        WHERE projector = ${ORCHESTRATION_PROJECTOR_NAMES.runtimeItems}
      `;
        yield* projectionPipeline.bootstrap;

        assert.deepEqual(yield* readState, fullReplay);

        // Also simulate migration 040's empty table with the same zero cursor.
        // The fixture deletes only this thread's runtime-item rows; production
        // recovery never deletes rows.
        yield* sql`
        UPDATE projection_state
        SET last_applied_sequence = 0,
            updated_at = ${savedEvents[0]!.occurredAt}
        WHERE projector = ${ORCHESTRATION_PROJECTOR_NAMES.runtimeItems}
      `;
        yield* sql`
        DELETE FROM projection_runtime_items
        WHERE thread_id = ${threadId}
      `;
        const emptyRuntimeItems = yield* sql<{ readonly runtimeItemId: string }>`
        SELECT runtime_item_id AS "runtimeItemId"
        FROM projection_runtime_items
        WHERE thread_id = ${threadId}
      `;
        assert.deepEqual(emptyRuntimeItems, []);
        yield* projectionPipeline.bootstrap;
        assert.deepEqual(yield* readState, fullReplay);

        const runtimeItemCursor = yield* sql<{ readonly sequence: number }>`
        SELECT last_applied_sequence AS "sequence"
        FROM projection_state
        WHERE projector = ${ORCHESTRATION_PROJECTOR_NAMES.runtimeItems}
      `;
        assert.deepEqual(runtimeItemCursor, [
          { sequence: savedEvents[savedEvents.length - 1]!.sequence },
        ]);
      }),
  );

  it.effect(
    "corrects an inferred completion and keeps it through final message, checkpoint and late running session",
    () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
          eventStore
            .append(event)
            .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));
        const createdAt = "2026-03-02T13:00:00.000Z";
        const threadId = ThreadId.make("thread-terminal-precedence");
        const turnId = TurnId.make("turn-terminal-precedence");
        const inferredAt = "2026-03-02T13:00:30.000Z";
        const authoritativeAt = "2026-03-02T13:01:00.000Z";

        yield* appendAndProject({
          type: "thread.created",
          eventId: EventId.make("evt-terminal-precedence-1"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: createdAt,
          commandId: CommandId.make("cmd-terminal-precedence-1"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-terminal-precedence-1"),
          metadata: {},
          payload: {
            threadId,
            projectId: ProjectId.make("project-terminal-precedence"),
            title: "Terminal precedence",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        });

        const appendSessionSet = (
          eventId: string,
          occurredAt: string,
          session: {
            readonly status: "running" | "ready" | "starting";
            readonly activeTurnId: TurnId | null;
          },
          extras?: {
            readonly interruptedTurnId?: TurnId;
            readonly latestTurnOutcome?: "completed" | "interrupted" | "error";
          },
        ) =>
          appendAndProject({
            type: "thread.session-set",
            eventId: EventId.make(eventId),
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt,
            commandId: CommandId.make(`cmd-${eventId}`),
            causationEventId: null,
            correlationId: CorrelationId.make(`cmd-${eventId}`),
            metadata: {},
            payload: {
              threadId,
              session: {
                threadId,
                status: session.status,
                providerName: "codex",
                runtimeMode: "full-access",
                activeTurnId: session.activeTurnId,
                lastError: null,
                updatedAt: occurredAt,
              },
              ...(extras?.interruptedTurnId !== undefined
                ? { interruptedTurnId: extras.interruptedTurnId }
                : {}),
              ...(extras?.latestTurnOutcome !== undefined
                ? { latestTurnOutcome: extras.latestTurnOutcome }
                : {}),
            },
          });

        yield* appendSessionSet("evt-terminal-precedence-2", "2026-03-02T13:00:05.000Z", {
          status: "running",
          activeTurnId: turnId,
        });
        // The session leaves the running status without an authoritative turn
        // outcome, so the final assistant message settles the turn first.
        yield* appendSessionSet("evt-terminal-precedence-3", "2026-03-02T13:00:10.000Z", {
          status: "starting",
          activeTurnId: null,
        });
        yield* appendAndProject({
          type: "thread.message-sent",
          eventId: EventId.make("evt-terminal-precedence-inferred"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: inferredAt,
          commandId: CommandId.make("cmd-terminal-precedence-inferred"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-terminal-precedence-inferred"),
          metadata: {},
          payload: {
            threadId,
            messageId: MessageId.make("message-terminal-precedence-inferred"),
            role: "assistant",
            text: "done",
            turnId,
            streaming: false,
            createdAt: inferredAt,
            updatedAt: inferredAt,
          },
        });

        yield* appendSessionSet(
          "evt-terminal-precedence-4",
          authoritativeAt,
          { status: "ready", activeTurnId: null },
          { interruptedTurnId: turnId, latestTurnOutcome: "interrupted" },
        );
        // A repeated terminal outcome must not rewrite the first settlement
        // time.
        yield* appendSessionSet(
          "evt-terminal-precedence-repeat",
          "2026-03-02T13:01:15.000Z",
          { status: "ready", activeTurnId: null },
          { interruptedTurnId: turnId, latestTurnOutcome: "interrupted" },
        );

        yield* appendAndProject({
          type: "thread.message-sent",
          eventId: EventId.make("evt-terminal-precedence-5"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-03-02T13:02:00.000Z",
          commandId: CommandId.make("cmd-terminal-precedence-5"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-terminal-precedence-5"),
          metadata: {},
          payload: {
            threadId,
            messageId: MessageId.make("message-terminal-precedence-final"),
            role: "assistant",
            text: "final",
            turnId,
            streaming: false,
            createdAt: "2026-03-02T13:02:00.000Z",
            updatedAt: "2026-03-02T13:02:00.000Z",
          },
        });

        yield* appendAndProject({
          type: "thread.turn-diff-completed",
          eventId: EventId.make("evt-terminal-precedence-6"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-03-02T13:03:00.000Z",
          commandId: CommandId.make("cmd-terminal-precedence-6"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-terminal-precedence-6"),
          metadata: {},
          payload: {
            threadId,
            turnId,
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("refs/neokod/checkpoints/thread/1"),
            status: "ready",
            files: [],
            assistantMessageId: MessageId.make("message-terminal-precedence-final"),
            completedAt: "2026-03-02T13:03:00.000Z",
          },
        });

        yield* appendSessionSet("evt-terminal-precedence-7", "2026-03-02T13:04:00.000Z", {
          status: "running",
          activeTurnId: turnId,
        });

        // The late running update for the settled turn cannot reopen the
        // session that has left it.
        const lateRunningSession = yield* sql<{
          readonly status: string;
          readonly activeTurnId: string | null;
        }>`
          SELECT status, active_turn_id AS "activeTurnId"
          FROM projection_thread_sessions
          WHERE thread_id = ${threadId}
        `;
        assert.deepEqual(lateRunningSession, [{ status: "ready", activeTurnId: null }]);

        for (const streaming of [true, false]) {
          yield* appendAndProject({
            type: "thread.message-sent",
            eventId: EventId.make(`evt-terminal-precedence-late-${streaming ? "stream" : "final"}`),
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: streaming ? "2026-03-02T13:05:00.000Z" : "2026-03-02T13:06:00.000Z",
            commandId: CommandId.make(
              `cmd-terminal-precedence-late-${streaming ? "stream" : "final"}`,
            ),
            causationEventId: null,
            correlationId: CorrelationId.make(
              `cmd-terminal-precedence-late-${streaming ? "stream" : "final"}`,
            ),
            metadata: {},
            payload: {
              threadId,
              messageId: MessageId.make(
                `message-terminal-precedence-late-${streaming ? "stream" : "final"}`,
              ),
              role: "assistant",
              text: streaming ? "late stream" : "late final",
              turnId,
              streaming,
              createdAt: streaming ? "2026-03-02T13:05:00.000Z" : "2026-03-02T13:06:00.000Z",
              updatedAt: streaming ? "2026-03-02T13:05:00.000Z" : "2026-03-02T13:06:00.000Z",
            },
          });
        }

        const turnRows = yield* sql<{
          readonly state: string;
          readonly completedAt: string | null;
        }>`
          SELECT state, completed_at AS "completedAt"
          FROM projection_turns
          WHERE thread_id = ${threadId} AND turn_id = ${turnId}
        `;
        assert.deepEqual(turnRows, [{ state: "interrupted", completedAt: inferredAt }]);

        const settlements = yield* sql<{
          readonly completedAt: string | null;
        }>`
          SELECT completed_at AS "completedAt"
          FROM projection_turn_settlements
          WHERE thread_id = ${threadId} AND turn_id = ${turnId}
        `;
        assert.deepEqual(settlements, [{ completedAt: inferredAt }]);
        assert.strictEqual(settlements[0]?.completedAt, turnRows[0]?.completedAt);

        // Reload must project the same turn and settlement evidence.
        yield* projectionPipeline.bootstrap;
        const reloadedTurnRows = yield* sql<{
          readonly state: string;
          readonly completedAt: string | null;
        }>`
          SELECT state, completed_at AS "completedAt"
          FROM projection_turns
          WHERE thread_id = ${threadId} AND turn_id = ${turnId}
        `;
        assert.deepEqual(reloadedTurnRows, [{ state: "interrupted", completedAt: inferredAt }]);
        const reloadedSettlements = yield* sql<{ readonly completedAt: string | null }>`
          SELECT completed_at AS "completedAt"
          FROM projection_turn_settlements
          WHERE thread_id = ${threadId} AND turn_id = ${turnId}
        `;
        assert.deepEqual(reloadedSettlements, [{ completedAt: inferredAt }]);
      }),
  );

  it.effect("keeps accumulated assistant text when completion payload text is empty", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.make("evt-empty-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-empty"),
        occurredAt: now,
        commandId: CommandId.make("cmd-empty-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-empty-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-empty"),
          title: "Project Empty",
          workspaceRoot: "/tmp/project-empty",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.make("evt-empty-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-empty"),
        occurredAt: now,
        commandId: CommandId.make("cmd-empty-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-empty-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-empty"),
          projectId: ProjectId.make("project-empty"),
          title: "Thread Empty",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-empty-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-empty"),
        occurredAt: now,
        commandId: CommandId.make("cmd-empty-3"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-empty-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-empty"),
          messageId: MessageId.make("assistant-empty"),
          role: "assistant",
          text: "Hello",
          turnId: null,
          streaming: true,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-empty-4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-empty"),
        occurredAt: now,
        commandId: CommandId.make("cmd-empty-4"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-empty-4"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-empty"),
          messageId: MessageId.make("assistant-empty"),
          role: "assistant",
          text: " world",
          turnId: null,
          streaming: true,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-empty-5"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-empty"),
        occurredAt: now,
        commandId: CommandId.make("cmd-empty-5"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-empty-5"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-empty"),
          messageId: MessageId.make("assistant-empty"),
          role: "assistant",
          text: "",
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;

      const messageRows = yield* sql<{ readonly text: string; readonly isStreaming: unknown }>`
        SELECT
          text,
          is_streaming AS "isStreaming"
        FROM projection_thread_messages
        WHERE message_id = 'assistant-empty'
      `;
      assert.equal(messageRows.length, 1);
      assert.equal(messageRows[0]?.text, "Hello world");
      assert.isFalse(Boolean(messageRows[0]?.isStreaming));
    }),
  );

  it.effect(
    "resolves turn-count conflicts when checkpoint completion rewrites provisional turns",
    () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
          eventStore
            .append(event)
            .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

        yield* appendAndProject({
          type: "project.created",
          eventId: EventId.make("evt-conflict-1"),
          aggregateKind: "project",
          aggregateId: ProjectId.make("project-conflict"),
          occurredAt: "2026-02-26T13:00:00.000Z",
          commandId: CommandId.make("cmd-conflict-1"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-conflict-1"),
          metadata: {},
          payload: {
            projectId: ProjectId.make("project-conflict"),
            title: "Project Conflict",
            workspaceRoot: "/tmp/project-conflict",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-02-26T13:00:00.000Z",
            updatedAt: "2026-02-26T13:00:00.000Z",
          },
        });

        yield* appendAndProject({
          type: "thread.created",
          eventId: EventId.make("evt-conflict-2"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-conflict"),
          occurredAt: "2026-02-26T13:00:01.000Z",
          commandId: CommandId.make("cmd-conflict-2"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-conflict-2"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-conflict"),
            projectId: ProjectId.make("project-conflict"),
            title: "Thread Conflict",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: "2026-02-26T13:00:01.000Z",
            updatedAt: "2026-02-26T13:00:01.000Z",
          },
        });

        yield* appendAndProject({
          type: "thread.session-set",
          eventId: EventId.make("evt-conflict-3"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-conflict"),
          occurredAt: "2026-02-26T13:00:02.000Z",
          commandId: CommandId.make("cmd-conflict-3"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-conflict-3"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-conflict"),
            session: {
              threadId: ThreadId.make("thread-conflict"),
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: TurnId.make("turn-interrupted"),
              lastError: null,
              updatedAt: "2026-02-26T13:00:02.000Z",
            },
          },
        });

        yield* appendAndProject({
          type: "thread.message-sent",
          eventId: EventId.make("evt-conflict-4"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-conflict"),
          occurredAt: "2026-02-26T13:00:03.000Z",
          commandId: CommandId.make("cmd-conflict-4"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-conflict-4"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-conflict"),
            messageId: MessageId.make("assistant-conflict"),
            role: "assistant",
            text: "done",
            turnId: TurnId.make("turn-completed"),
            streaming: false,
            createdAt: "2026-02-26T13:00:03.000Z",
            updatedAt: "2026-02-26T13:00:03.000Z",
          },
        });

        yield* appendAndProject({
          type: "thread.turn-diff-completed",
          eventId: EventId.make("evt-conflict-5"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-conflict"),
          occurredAt: "2026-02-26T13:00:04.000Z",
          commandId: CommandId.make("cmd-conflict-5"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-conflict-5"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-conflict"),
            turnId: TurnId.make("turn-completed"),
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("refs/neokod/checkpoints/thread-conflict/turn/1"),
            status: "ready",
            files: [],
            assistantMessageId: MessageId.make("assistant-conflict"),
            completedAt: "2026-02-26T13:00:04.000Z",
          },
        });

        const turnRows = yield* sql<{
          readonly turnId: string;
          readonly checkpointTurnCount: number | null;
          readonly status: string;
        }>`
        SELECT
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          state AS "status"
        FROM projection_turns
        WHERE thread_id = 'thread-conflict'
        ORDER BY
          CASE
            WHEN checkpoint_turn_count IS NULL THEN 1
            ELSE 0
          END ASC,
          checkpoint_turn_count ASC,
          requested_at ASC
      `;
        assert.deepEqual(turnRows, [
          { turnId: "turn-completed", checkpointTurnCount: 1, status: "completed" },
          { turnId: "turn-interrupted", checkpointTurnCount: null, status: "running" },
        ]);
      }),
  );

  it.effect("does not project an interrupt request as authoritative turn settlement", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.make("evt-interrupt-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-interrupt"),
        occurredAt: "2026-03-01T13:00:00.000Z",
        commandId: CommandId.make("cmd-interrupt-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-interrupt-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-interrupt"),
          title: "Project Interrupt",
          workspaceRoot: "/tmp/project-interrupt",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-03-01T13:00:00.000Z",
          updatedAt: "2026-03-01T13:00:00.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.make("evt-interrupt-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-interrupt"),
        occurredAt: "2026-03-01T13:00:01.000Z",
        commandId: CommandId.make("cmd-interrupt-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-interrupt-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-interrupt"),
          projectId: ProjectId.make("project-interrupt"),
          title: "Thread Interrupt",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: "2026-03-01T13:00:01.000Z",
          updatedAt: "2026-03-01T13:00:01.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.session-set",
        eventId: EventId.make("evt-interrupt-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-interrupt"),
        occurredAt: "2026-03-01T13:00:02.000Z",
        commandId: CommandId.make("cmd-interrupt-3"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-interrupt-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-interrupt"),
          session: {
            threadId: ThreadId.make("thread-interrupt"),
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: TurnId.make("turn-interrupt"),
            lastError: null,
            updatedAt: "2026-03-01T13:00:02.000Z",
          },
        },
      });

      yield* appendAndProject({
        type: "thread.turn-interrupt-requested",
        eventId: EventId.make("evt-interrupt-4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-interrupt"),
        occurredAt: "2026-03-01T13:00:10.000Z",
        commandId: CommandId.make("cmd-interrupt-4"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-interrupt-4"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-interrupt"),
          turnId: TurnId.make("turn-interrupt"),
          createdAt: "2026-03-01T13:00:10.000Z",
        },
      });

      const readTurnRows = () =>
        sql<{ readonly state: string; readonly completedAt: string | null }>`
          SELECT
            state,
            completed_at AS "completedAt"
          FROM projection_turns
          WHERE thread_id = 'thread-interrupt'
            AND turn_id = 'turn-interrupt'
        `;
      // The request is intent: the turn stays running and carries no completion.
      assert.deepEqual(yield* readTurnRows(), [{ state: "running", completedAt: null }]);

      // The provider observes the stop later; that session event settles the
      // turn at its own timestamp.
      yield* appendAndProject({
        type: "thread.session-set",
        eventId: EventId.make("evt-interrupt-5"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-interrupt"),
        occurredAt: "2026-03-01T13:00:30.000Z",
        commandId: CommandId.make("cmd-interrupt-5"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-interrupt-5"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-interrupt"),
          session: {
            threadId: ThreadId.make("thread-interrupt"),
            status: "interrupted",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-03-01T13:00:30.000Z",
          },
        },
      });

      assert.deepEqual(yield* readTurnRows(), [
        { state: "interrupted", completedAt: "2026-03-01T13:00:30.000Z" },
      ]);
    }),
  );

  it.effect("clears stale pending approvals from projected shell summaries", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.make("evt-stale-approval-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-stale-approval"),
        occurredAt: "2026-02-26T12:30:00.000Z",
        commandId: CommandId.make("cmd-stale-approval-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-stale-approval-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-stale-approval"),
          title: "Project Stale Approval",
          workspaceRoot: "/tmp/project-stale-approval",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-02-26T12:30:00.000Z",
          updatedAt: "2026-02-26T12:30:00.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.make("evt-stale-approval-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-stale-approval"),
        occurredAt: "2026-02-26T12:30:01.000Z",
        commandId: CommandId.make("cmd-stale-approval-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-stale-approval-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-stale-approval"),
          projectId: ProjectId.make("project-stale-approval"),
          title: "Thread Stale Approval",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: "2026-02-26T12:30:01.000Z",
          updatedAt: "2026-02-26T12:30:01.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.activity-appended",
        eventId: EventId.make("evt-stale-approval-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-stale-approval"),
        occurredAt: "2026-02-26T12:30:02.000Z",
        commandId: CommandId.make("cmd-stale-approval-3"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-stale-approval-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-stale-approval"),
          activity: {
            id: EventId.make("activity-stale-approval-requested"),
            tone: "approval",
            kind: "approval.requested",
            summary: "Command approval requested",
            payload: {
              requestId: "approval-request-stale-1",
              requestKind: "command",
            },
            turnId: null,
            createdAt: "2026-02-26T12:30:02.000Z",
          },
        },
      });

      yield* appendAndProject({
        type: "thread.activity-appended",
        eventId: EventId.make("evt-stale-approval-4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-stale-approval"),
        occurredAt: "2026-02-26T12:30:03.000Z",
        commandId: CommandId.make("cmd-stale-approval-4"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-stale-approval-4"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-stale-approval"),
          activity: {
            id: EventId.make("activity-stale-approval-failed"),
            tone: "error",
            kind: "provider.approval.respond.failed",
            summary: "Provider approval response failed",
            payload: {
              requestId: "approval-request-stale-1",
              detail: "Unknown pending permission request: approval-request-stale-1",
            },
            turnId: null,
            createdAt: "2026-02-26T12:30:03.000Z",
          },
        },
      });

      const approvalRows = yield* sql<{
        readonly requestId: string;
        readonly status: string;
        readonly resolvedAt: string | null;
      }>`
        SELECT
          request_id AS "requestId",
          status,
          resolved_at AS "resolvedAt"
        FROM projection_pending_approvals
        WHERE request_id = 'approval-request-stale-1'
      `;
      assert.deepEqual(approvalRows, [
        {
          requestId: "approval-request-stale-1",
          status: "resolved",
          resolvedAt: "2026-02-26T12:30:03.000Z",
        },
      ]);

      const threadRows = yield* sql<{
        readonly pendingApprovalCount: number;
      }>`
        SELECT pending_approval_count AS "pendingApprovalCount"
        FROM projection_threads
        WHERE thread_id = 'thread-stale-approval'
      `;
      assert.deepEqual(threadRows, [{ pendingApprovalCount: 0 }]);
    }),
  );

  it.effect("clears stale pending user input from projected shell summaries", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.make("evt-stale-user-input-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-stale-user-input"),
        occurredAt: "2026-02-26T12:35:00.000Z",
        commandId: CommandId.make("cmd-stale-user-input-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-stale-user-input-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-stale-user-input"),
          title: "Project Stale User Input",
          workspaceRoot: "/tmp/project-stale-user-input",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-02-26T12:35:00.000Z",
          updatedAt: "2026-02-26T12:35:00.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.make("evt-stale-user-input-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-stale-user-input"),
        occurredAt: "2026-02-26T12:35:01.000Z",
        commandId: CommandId.make("cmd-stale-user-input-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-stale-user-input-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-stale-user-input"),
          projectId: ProjectId.make("project-stale-user-input"),
          title: "Thread Stale User Input",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: "2026-02-26T12:35:01.000Z",
          updatedAt: "2026-02-26T12:35:01.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.activity-appended",
        eventId: EventId.make("evt-stale-user-input-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-stale-user-input"),
        occurredAt: "2026-02-26T12:35:02.000Z",
        commandId: CommandId.make("cmd-stale-user-input-3"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-stale-user-input-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-stale-user-input"),
          activity: {
            id: EventId.make("activity-stale-user-input-requested"),
            tone: "info",
            kind: "user-input.requested",
            summary: "User input requested",
            payload: {
              requestId: "user-input-request-stale-1",
              questions: [
                {
                  id: "sandbox_mode",
                  header: "Sandbox",
                  question: "Which mode should be used?",
                  options: [
                    {
                      label: "workspace-write",
                      description: "Allow workspace writes only",
                    },
                  ],
                },
              ],
            },
            turnId: null,
            createdAt: "2026-02-26T12:35:02.000Z",
          },
        },
      });

      yield* appendAndProject({
        type: "thread.activity-appended",
        eventId: EventId.make("evt-stale-user-input-4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-stale-user-input"),
        occurredAt: "2026-02-26T12:35:03.000Z",
        commandId: CommandId.make("cmd-stale-user-input-4"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-stale-user-input-4"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-stale-user-input"),
          activity: {
            id: EventId.make("activity-stale-user-input-failed"),
            tone: "error",
            kind: "provider.user-input.respond.failed",
            summary: "Provider user input response failed",
            payload: {
              requestId: "user-input-request-stale-1",
              detail:
                "Provider adapter request failed (codex) for item/tool/requestUserInput: Unknown pending Codex user input request: user-input-request-stale-1",
            },
            turnId: null,
            createdAt: "2026-02-26T12:35:03.000Z",
          },
        },
      });

      const threadRows = yield* sql<{
        readonly pendingUserInputCount: number;
      }>`
        SELECT pending_user_input_count AS "pendingUserInputCount"
        FROM projection_threads
        WHERE thread_id = 'thread-stale-user-input'
      `;
      assert.deepEqual(threadRows, [{ pendingUserInputCount: 0 }]);
    }),
  );

  it.effect("ignores non-stale provider approval response failures", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.make("evt-nonstale-approval-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-nonstale-approval"),
        occurredAt: "2026-02-26T12:45:00.000Z",
        commandId: CommandId.make("cmd-nonstale-approval-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-nonstale-approval-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-nonstale-approval"),
          title: "Project Non-Stale Approval",
          workspaceRoot: "/tmp/project-nonstale-approval",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-02-26T12:45:00.000Z",
          updatedAt: "2026-02-26T12:45:00.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.make("evt-nonstale-approval-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-nonstale-approval"),
        occurredAt: "2026-02-26T12:45:01.000Z",
        commandId: CommandId.make("cmd-nonstale-approval-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-nonstale-approval-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-nonstale-approval"),
          projectId: ProjectId.make("project-nonstale-approval"),
          title: "Thread Non-Stale Approval",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: "2026-02-26T12:45:01.000Z",
          updatedAt: "2026-02-26T12:45:01.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.activity-appended",
        eventId: EventId.make("evt-nonstale-approval-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-nonstale-approval"),
        occurredAt: "2026-02-26T12:45:02.000Z",
        commandId: CommandId.make("cmd-nonstale-approval-3"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-nonstale-approval-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-nonstale-approval"),
          activity: {
            id: EventId.make("activity-nonstale-approval-requested"),
            tone: "approval",
            kind: "approval.requested",
            summary: "Command approval requested",
            payload: {
              requestId: "approval-request-nonstale-existing",
              requestKind: "command",
            },
            turnId: null,
            createdAt: "2026-02-26T12:45:02.000Z",
          },
        },
      });

      yield* appendAndProject({
        type: "thread.activity-appended",
        eventId: EventId.make("evt-nonstale-approval-4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-nonstale-approval"),
        occurredAt: "2026-02-26T12:45:03.000Z",
        commandId: CommandId.make("cmd-nonstale-approval-4"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-nonstale-approval-4"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-nonstale-approval"),
          activity: {
            id: EventId.make("activity-nonstale-approval-failed-existing"),
            tone: "error",
            kind: "provider.approval.respond.failed",
            summary: "Provider approval response failed",
            payload: {
              requestId: "approval-request-nonstale-existing",
              detail: "Provider timed out while responding to approval request",
            },
            turnId: TurnId.make("turn-nonstale-failure"),
            createdAt: "2026-02-26T12:45:03.000Z",
          },
        },
      });

      yield* appendAndProject({
        type: "thread.activity-appended",
        eventId: EventId.make("evt-nonstale-approval-5"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-nonstale-approval"),
        occurredAt: "2026-02-26T12:45:04.000Z",
        commandId: CommandId.make("cmd-nonstale-approval-5"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-nonstale-approval-5"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-nonstale-approval"),
          activity: {
            id: EventId.make("activity-nonstale-approval-failed-missing"),
            tone: "error",
            kind: "provider.approval.respond.failed",
            summary: "Provider approval response failed",
            payload: {
              requestId: "approval-request-nonstale-missing",
              detail: "Provider timed out while responding to approval request",
            },
            turnId: null,
            createdAt: "2026-02-26T12:45:04.000Z",
          },
        },
      });

      const approvalRows = yield* sql<{
        readonly requestId: string;
        readonly status: string;
        readonly turnId: string | null;
        readonly createdAt: string;
        readonly resolvedAt: string | null;
      }>`
        SELECT
          request_id AS "requestId",
          status,
          turn_id AS "turnId",
          created_at AS "createdAt",
          resolved_at AS "resolvedAt"
        FROM projection_pending_approvals
        WHERE request_id IN (
          'approval-request-nonstale-existing',
          'approval-request-nonstale-missing'
        )
        ORDER BY request_id
      `;
      assert.deepEqual(approvalRows, [
        {
          requestId: "approval-request-nonstale-existing",
          status: "pending",
          turnId: null,
          createdAt: "2026-02-26T12:45:02.000Z",
          resolvedAt: null,
        },
      ]);

      const threadRows = yield* sql<{
        readonly pendingApprovalCount: number;
      }>`
        SELECT pending_approval_count AS "pendingApprovalCount"
        FROM projection_threads
        WHERE thread_id = 'thread-nonstale-approval'
      `;
      assert.deepEqual(threadRows, [{ pendingApprovalCount: 1 }]);
    }),
  );

  it.effect("does not fallback-retain messages whose turnId is removed by revert", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.make("evt-revert-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-revert"),
        occurredAt: "2026-02-26T12:00:00.000Z",
        commandId: CommandId.make("cmd-revert-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-revert"),
          title: "Project Revert",
          workspaceRoot: "/tmp/project-revert",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-02-26T12:00:00.000Z",
          updatedAt: "2026-02-26T12:00:00.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.make("evt-revert-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-revert"),
        occurredAt: "2026-02-26T12:00:01.000Z",
        commandId: CommandId.make("cmd-revert-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-revert"),
          projectId: ProjectId.make("project-revert"),
          title: "Thread Revert",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: "2026-02-26T12:00:01.000Z",
          updatedAt: "2026-02-26T12:00:01.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.turn-diff-completed",
        eventId: EventId.make("evt-revert-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-revert"),
        occurredAt: "2026-02-26T12:00:02.000Z",
        commandId: CommandId.make("cmd-revert-3"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-revert"),
          turnId: TurnId.make("turn-1"),
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.make("refs/neokod/checkpoints/thread-revert/turn/1"),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.make("assistant-keep"),
          completedAt: "2026-02-26T12:00:02.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.make("evt-revert-4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-revert"),
        occurredAt: "2026-02-26T12:00:02.100Z",
        commandId: CommandId.make("cmd-revert-4"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-4"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-revert"),
          messageId: MessageId.make("assistant-keep"),
          role: "assistant",
          text: "kept",
          turnId: TurnId.make("turn-1"),
          streaming: false,
          createdAt: "2026-02-26T12:00:02.100Z",
          updatedAt: "2026-02-26T12:00:02.100Z",
        },
      });

      yield* appendAndProject({
        type: "thread.turn-diff-completed",
        eventId: EventId.make("evt-revert-5"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-revert"),
        occurredAt: "2026-02-26T12:00:03.000Z",
        commandId: CommandId.make("cmd-revert-5"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-5"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-revert"),
          turnId: TurnId.make("turn-2"),
          checkpointTurnCount: 2,
          checkpointRef: CheckpointRef.make("refs/neokod/checkpoints/thread-revert/turn/2"),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.make("assistant-remove"),
          completedAt: "2026-02-26T12:00:03.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.make("evt-revert-6"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-revert"),
        occurredAt: "2026-02-26T12:00:03.050Z",
        commandId: CommandId.make("cmd-revert-6"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-6"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-revert"),
          messageId: MessageId.make("user-remove"),
          role: "user",
          text: "removed",
          turnId: TurnId.make("turn-2"),
          streaming: false,
          createdAt: "2026-02-26T12:00:03.050Z",
          updatedAt: "2026-02-26T12:00:03.050Z",
        },
      });

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.make("evt-revert-7"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-revert"),
        occurredAt: "2026-02-26T12:00:03.100Z",
        commandId: CommandId.make("cmd-revert-7"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-7"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-revert"),
          messageId: MessageId.make("assistant-remove"),
          role: "assistant",
          text: "removed",
          turnId: TurnId.make("turn-2"),
          streaming: false,
          createdAt: "2026-02-26T12:00:03.100Z",
          updatedAt: "2026-02-26T12:00:03.100Z",
        },
      });

      yield* appendAndProject({
        type: "thread.reverted",
        eventId: EventId.make("evt-revert-8"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-revert"),
        occurredAt: "2026-02-26T12:00:04.000Z",
        commandId: CommandId.make("cmd-revert-8"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-8"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-revert"),
          turnCount: 1,
        },
      });

      const messageRows = yield* sql<{
        readonly messageId: string;
        readonly turnId: string | null;
        readonly role: string;
      }>`
        SELECT
          message_id AS "messageId",
          turn_id AS "turnId",
          role
        FROM projection_thread_messages
        WHERE thread_id = 'thread-revert'
        ORDER BY created_at ASC, message_id ASC
      `;
      assert.deepEqual(messageRows, [
        {
          messageId: "assistant-keep",
          turnId: "turn-1",
          role: "assistant",
        },
      ]);
    }),
  );
});

it.effect("restores pending turn-start metadata across projection pipeline restart", () =>
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig;
    const persistenceLayer = makeSqlitePersistenceLive(dbPath);
    const firstProjectionLayer = OrchestrationProjectionPipelineLive.pipe(
      Layer.provideMerge(OrchestrationEventStoreLive),
      Layer.provideMerge(persistenceLayer),
    );
    const secondProjectionLayer = OrchestrationProjectionPipelineLive.pipe(
      Layer.provideMerge(OrchestrationEventStoreLive),
      Layer.provideMerge(persistenceLayer),
    );

    const threadId = ThreadId.make("thread-restart");
    const turnId = TurnId.make("turn-restart");
    const messageId = MessageId.make("message-restart");
    const sourcePlanThreadId = ThreadId.make("thread-plan-source");
    const sourcePlanId = "plan-source";
    const turnStartedAt = "2026-02-26T14:00:00.000Z";
    const sessionSetAt = "2026-02-26T14:00:05.000Z";

    yield* Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;

      yield* eventStore.append({
        type: "thread.turn-start-requested",
        eventId: EventId.make("evt-restart-1"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: turnStartedAt,
        commandId: CommandId.make("cmd-restart-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-restart-1"),
        metadata: {},
        payload: {
          threadId,
          messageId,
          sourceProposedPlan: {
            threadId: sourcePlanThreadId,
            planId: sourcePlanId,
          },
          runtimeMode: "approval-required",
          createdAt: turnStartedAt,
        },
      });

      yield* projectionPipeline.bootstrap;
    }).pipe(Effect.provide(firstProjectionLayer));

    const turnRows = yield* Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;

      yield* eventStore.append({
        type: "thread.session-set",
        eventId: EventId.make("evt-restart-2"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: sessionSetAt,
        commandId: CommandId.make("cmd-restart-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-restart-2"),
        metadata: {},
        payload: {
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: sessionSetAt,
          },
        },
      });

      yield* projectionPipeline.bootstrap;

      const pendingRows = yield* sql<{ readonly threadId: string }>`
        SELECT thread_id AS "threadId"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND turn_id IS NULL
          AND state = 'pending'
      `;
      assert.deepEqual(pendingRows, []);

      return yield* sql<{
        readonly turnId: string;
        readonly userMessageId: string | null;
        readonly sourceProposedPlanThreadId: string | null;
        readonly sourceProposedPlanId: string | null;
        readonly startedAt: string;
      }>`
        SELECT
          turn_id AS "turnId",
          pending_message_id AS "userMessageId",
          source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          source_proposed_plan_id AS "sourceProposedPlanId",
          started_at AS "startedAt"
        FROM projection_turns
        WHERE turn_id = ${turnId}
      `;
    }).pipe(Effect.provide(secondProjectionLayer));

    assert.deepEqual(turnRows, [
      {
        turnId: "turn-restart",
        userMessageId: "message-restart",
        sourceProposedPlanThreadId: "thread-plan-source",
        sourceProposedPlanId: "plan-source",
        startedAt: turnStartedAt,
      },
    ]);
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "neokod-projection-pipeline-restart-",
        }),
        NodeServices.layer,
      ),
    ),
  ),
);

it.effect("does not resurrect a rejected pending admission after repeated bootstrap", () =>
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig;
    const persistenceLayer = makeSqlitePersistenceLive(dbPath);
    const projectionLayer = OrchestrationProjectionPipelineLive.pipe(
      Layer.provideMerge(OrchestrationEventStoreLive),
      Layer.provideMerge(persistenceLayer),
    );

    const threadId = ThreadId.make("thread-rejected-restart");
    const messageId = MessageId.make("message-rejected-restart");
    const createdAt = "2026-03-01T00:00:00.000Z";

    yield* Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;

      yield* eventStore.append({
        type: "thread.turn-start-requested",
        eventId: EventId.make("evt-rejected-restart-start"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: createdAt,
        commandId: CommandId.make("cmd-rejected-restart-start"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-rejected-restart-start"),
        metadata: {},
        payload: {
          threadId,
          messageId,
          runtimeMode: "approval-required",
          createdAt,
        },
      });
      yield* eventStore.append({
        type: "thread.activity-appended",
        eventId: EventId.make("evt-rejected-restart-failed"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2026-03-01T00:00:01.000Z",
        commandId: CommandId.make("cmd-rejected-restart-failed"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-rejected-restart-failed"),
        metadata: {},
        payload: {
          threadId,
          activity: {
            id: EventId.make("evt-rejected-restart-failed-activity"),
            tone: "error",
            kind: "provider.turn.start.failed",
            summary: "Provider turn start failed",
            payload: { messageId, detail: "provider unavailable" },
            turnId: null,
            createdAt: "2026-03-01T00:00:01.000Z",
          },
        },
      });

      yield* projectionPipeline.bootstrap;

      const sql = yield* SqlClient.SqlClient;
      const pendingRows = yield* sql<{ readonly threadId: string }>`
        SELECT thread_id AS "threadId"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND turn_id IS NULL
          AND state = 'pending'
      `;
      assert.deepEqual(pendingRows, []);
    }).pipe(Effect.provide(projectionLayer));

    yield* Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      yield* projectionPipeline.bootstrap;

      const sql = yield* SqlClient.SqlClient;
      const pendingRows = yield* sql<{ readonly threadId: string }>`
        SELECT thread_id AS "threadId"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND turn_id IS NULL
          AND state = 'pending'
      `;
      assert.deepEqual(pendingRows, []);
    }).pipe(Effect.provide(projectionLayer));
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "neokod-projection-pipeline-rejected-replay-",
        }),
        NodeServices.layer,
      ),
    ),
  ),
);

it.effect("clears only the pending admission named by the failure activity", () =>
  Effect.gen(function* () {
    const eventStore = yield* OrchestrationEventStore;
    const projectionPipeline = yield* OrchestrationProjectionPipeline;
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("thread-message-fence");
    const olderMessageId = MessageId.make("message-older-admission");
    const newerMessageId = MessageId.make("message-newer-admission");
    const createdAt = "2026-03-02T00:00:00.000Z";

    yield* sql`
      INSERT INTO projection_turns (
        thread_id, turn_id, pending_message_id, state, requested_at,
        checkpoint_files_json
      ) VALUES
        (
          ${threadId}, NULL, ${olderMessageId}, 'pending',
          ${createdAt}, '[]'
        ),
        (
          ${threadId}, NULL, ${newerMessageId}, 'pending',
          ${createdAt}, '[]'
        )
    `;

    yield* eventStore.append({
      type: "thread.activity-appended",
      eventId: EventId.make("evt-message-fence-failed"),
      aggregateKind: "thread",
      aggregateId: threadId,
      occurredAt: createdAt,
      commandId: CommandId.make("cmd-message-fence-failed"),
      causationEventId: null,
      correlationId: CorrelationId.make("cmd-message-fence-failed"),
      metadata: {},
      payload: {
        threadId,
        activity: {
          id: EventId.make("activity-message-fence-failed"),
          tone: "error",
          kind: "provider.turn.start.failed",
          summary: "Provider turn start failed",
          payload: { messageId: olderMessageId, detail: "provider unavailable" },
          turnId: null,
          createdAt,
        },
      },
    });

    yield* projectionPipeline.bootstrap;

    const pendingRows = yield* sql<{ readonly messageId: string }>`
      SELECT pending_message_id AS "messageId"
      FROM projection_turns
      WHERE thread_id = ${threadId}
        AND turn_id IS NULL
        AND state = 'pending'
      ORDER BY pending_message_id ASC
    `;
    assert.deepEqual(pendingRows, [{ messageId: newerMessageId }]);
  }).pipe(Effect.provide(BaseTestLayer)),
);

const engineLayer = it.layer(
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(WorktreeRemovalLeaseLive),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "neokod-projection-pipeline-engine-dispatch-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

engineLayer("OrchestrationProjectionPipeline via engine dispatch", (it) => {
  it.effect("projects dispatched engine events immediately", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const sql = yield* SqlClient.SqlClient;
      const createdAt = "2026-01-01T00:00:00.000Z";

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-live-project"),
        projectId: ProjectId.make("project-live"),
        title: "Live Project",
        workspaceRoot: "/tmp/project-live",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      });

      const projectRows = yield* sql<{ readonly title: string; readonly scriptsJson: string }>`
        SELECT
          title,
          scripts_json AS "scriptsJson"
        FROM projection_projects
        WHERE project_id = 'project-live'
      `;
      assert.deepEqual(projectRows, [{ title: "Live Project", scriptsJson: "[]" }]);

      const projectorRows = yield* sql<{ readonly lastAppliedSequence: number }>`
        SELECT
          last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
        WHERE projector = 'projection.projects'
      `;
      assert.deepEqual(projectorRows, [{ lastAppliedSequence: 1 }]);
    }),
  );

  it.effect("projects persist updated scripts from project.meta.update", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const sql = yield* SqlClient.SqlClient;
      const createdAt = "2026-01-01T00:00:00.000Z";

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-scripts-project-create"),
        projectId: ProjectId.make("project-scripts"),
        title: "Scripts Project",
        workspaceRoot: "/tmp/project-scripts",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      });

      yield* engine.dispatch({
        type: "project.meta.update",
        commandId: CommandId.make("cmd-scripts-project-update"),
        projectId: ProjectId.make("project-scripts"),
        scripts: [
          {
            id: "script-1",
            name: "Build",
            command: "bun run build",
            icon: "build",
            runOnWorktreeCreate: false,
          },
        ],
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5",
        },
      });

      const projectRows = yield* sql<{
        readonly scriptsJson: string;
        readonly defaultModelSelection: string;
      }>`
        SELECT
          scripts_json AS "scriptsJson",
          default_model_selection_json AS "defaultModelSelection"
        FROM projection_projects
        WHERE project_id = 'project-scripts'
      `;
      assert.deepEqual(projectRows, [
        {
          scriptsJson:
            '[{"id":"script-1","name":"Build","command":"bun run build","icon":"build","runOnWorktreeCreate":false}]',
          defaultModelSelection: '{"instanceId":"codex","model":"gpt-5"}',
        },
      ]);
    }),
  );
});

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("neokod-projection-runtime-item-catchup-")),
)("OrchestrationProjectionPipeline runtime-item catch-up", (it) => {
  it.effect("replays legacy runtime items past the default event page cap", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("project-runtime-item-cap");
      const threadId = ThreadId.make("thread-runtime-item-cap");
      const sessionId = RuntimeSessionId.make("session-runtime-item-cap");
      const turnId = TurnId.make("turn-runtime-item-cap");
      const runtimeItemId = RuntimeItemId.make("runtime-item-cap");
      const pendingMessageId = MessageId.make("message-runtime-item-cap-pending");
      const createdAt = "2026-03-05T13:00:00.000Z";

      const events: Parameters<typeof eventStore.append>[0][] = [
        {
          type: "project.created",
          eventId: EventId.make("evt-runtime-item-cap-1"),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: createdAt,
          commandId: CommandId.make("cmd-runtime-item-cap-1"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-runtime-item-cap-1"),
          metadata: {},
          payload: {
            projectId,
            title: "Runtime item cap",
            workspaceRoot: "/tmp/runtime-item-cap",
            defaultModelSelection: null,
            scripts: [],
            createdAt,
            updatedAt: createdAt,
          },
        },
        {
          type: "thread.created",
          eventId: EventId.make("evt-runtime-item-cap-2"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: createdAt,
          commandId: CommandId.make("cmd-runtime-item-cap-2"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-runtime-item-cap-2"),
          metadata: {},
          payload: {
            threadId,
            projectId,
            title: "Runtime item cap",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        },
        {
          type: "thread.session-set",
          eventId: EventId.make("evt-runtime-item-cap-3"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: createdAt,
          commandId: CommandId.make("cmd-runtime-item-cap-3"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-runtime-item-cap-3"),
          metadata: {},
          payload: {
            threadId,
            session: {
              threadId,
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: turnId,
              lastError: null,
              updatedAt: createdAt,
            },
          },
        },
      ];

      // Keep this above the event-store default page cap so a cached or
      // truncated replay cannot reach the runtime-item evidence below.
      for (let index = 0; index < 1_500; index += 1) {
        events.push({
          type: "thread.runtime-mode-set",
          eventId: EventId.make(`evt-runtime-item-cap-filler-${index}`),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: createdAt,
          commandId: CommandId.make(`cmd-runtime-item-cap-filler-${index}`),
          causationEventId: null,
          correlationId: CorrelationId.make(`cmd-runtime-item-cap-filler-${index}`),
          metadata: {},
          payload: {
            threadId,
            runtimeMode: "full-access",
            updatedAt: createdAt,
          },
        });
      }

      events.push({
        type: "thread.runtime-item-observed",
        eventId: EventId.make("evt-runtime-item-cap-observed"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: createdAt,
        commandId: CommandId.make("cmd-runtime-item-cap-observed"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-runtime-item-cap-observed"),
        metadata: {},
        payload: {
          threadId,
          observation: {
            runtimeItemId,
            providerItemId: null,
            sessionId,
            kind: "tool",
            scope: "turn",
            turnId,
            providerState: "completed",
            label: "Runtime item after cap",
            providerEventId: EventId.make("provider-runtime-item-cap"),
            observedAt: createdAt,
          },
        },
      });
      events.push({
        type: "thread.session-set",
        eventId: EventId.make("evt-runtime-item-cap-ready"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: createdAt,
        commandId: CommandId.make("cmd-runtime-item-cap-ready"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-runtime-item-cap-ready"),
        metadata: {},
        payload: {
          threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: createdAt,
          },
        },
      });
      events.push({
        type: "thread.turn-start-requested",
        eventId: EventId.make("evt-runtime-item-cap-pending"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: createdAt,
        commandId: CommandId.make("cmd-runtime-item-cap-pending"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-runtime-item-cap-pending"),
        metadata: {},
        payload: {
          threadId,
          messageId: pendingMessageId,
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt,
        },
      });

      const savedEvents = yield* Effect.forEach(events, (event) => eventStore.append(event), {
        concurrency: 1,
      });
      yield* projectionPipeline.bootstrap;

      const readState = Effect.gen(function* () {
        const runtimeItems = yield* sql<{
          readonly runtimeItemId: string;
          readonly effectiveState: string;
        }>`
          SELECT
            runtime_item_id AS "runtimeItemId",
            effective_state AS "effectiveState"
          FROM projection_runtime_items
          WHERE thread_id = ${threadId}
        `;
        const session = yield* sql<{
          readonly status: string;
          readonly activeTurnId: string | null;
        }>`
          SELECT status, active_turn_id AS "activeTurnId"
          FROM projection_thread_sessions
          WHERE thread_id = ${threadId}
        `;
        const turns = yield* sql<{ readonly state: string }>`
          SELECT state
          FROM projection_turns
          WHERE thread_id = ${threadId} AND turn_id = ${turnId}
        `;
        const thread = yield* sql<{ readonly latestTurnId: string | null }>`
          SELECT latest_turn_id AS "latestTurnId"
          FROM projection_threads
          WHERE thread_id = ${threadId}
        `;
        const pending = yield* sql<{
          readonly messageId: string | null;
          readonly state: string;
        }>`
          SELECT pending_message_id AS "messageId", state
          FROM projection_turns
          WHERE thread_id = ${threadId} AND turn_id IS NULL
        `;
        const settlements = yield* sql<{
          readonly turnId: string;
          readonly completedAt: string | null;
        }>`
          SELECT turn_id AS "turnId", completed_at AS "completedAt"
          FROM projection_turn_settlements
          WHERE thread_id = ${threadId}
        `;
        return { runtimeItems, session, turns, thread, pending, settlements };
      });

      const fullReplay = yield* readState;
      assert.ok(savedEvents.length > 1_000);
      assert.deepEqual(fullReplay.runtimeItems, [{ runtimeItemId, effectiveState: "completed" }]);
      assert.deepEqual(fullReplay.session, [{ status: "ready", activeTurnId: null }]);
      assert.deepEqual(fullReplay.turns, [{ state: "completed" }]);
      assert.deepEqual(fullReplay.pending, [{ messageId: pendingMessageId, state: "pending" }]);
      assert.deepEqual(fullReplay.settlements, [
        { turnId, completedAt: savedEvents[savedEvents.length - 2]!.occurredAt },
      ]);

      // Simulate migration 040's empty runtime-item table at cursor zero, with
      // a supported partial tail in the coupled group: sessions/turns are at
      // the final event and threads is one event behind.
      yield* sql`
        UPDATE projection_state
        SET last_applied_sequence = 0,
            updated_at = ${savedEvents[0]!.occurredAt}
        WHERE projector = ${ORCHESTRATION_PROJECTOR_NAMES.runtimeItems}
      `;
      yield* sql`
        DELETE FROM projection_runtime_items
        WHERE thread_id = ${threadId}
      `;
      yield* sql`
        UPDATE projection_state
        SET last_applied_sequence = ${savedEvents[savedEvents.length - 2]!.sequence},
            updated_at = ${savedEvents[savedEvents.length - 2]!.occurredAt}
        WHERE projector = ${ORCHESTRATION_PROJECTOR_NAMES.threads}
      `;
      yield* projectionPipeline.bootstrap;

      assert.deepEqual(yield* readState, fullReplay);
      const cursors = yield* sql<{
        readonly projector: string;
        readonly sequence: number;
      }>`
        SELECT projector, last_applied_sequence AS "sequence"
        FROM projection_state
        WHERE projector IN (
          ${ORCHESTRATION_PROJECTOR_NAMES.runtimeItems},
          ${ORCHESTRATION_PROJECTOR_NAMES.threads}
        )
        ORDER BY projector
      `;
      assert.deepEqual(cursors, [
        {
          projector: ORCHESTRATION_PROJECTOR_NAMES.runtimeItems,
          sequence: savedEvents[savedEvents.length - 1]!.sequence,
        },
        {
          projector: ORCHESTRATION_PROJECTOR_NAMES.threads,
          sequence: savedEvents[savedEvents.length - 1]!.sequence,
        },
      ]);
    }),
  );
});
