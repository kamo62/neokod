import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@neokod/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-04-01T00:00:00.000Z";
const threadId = ThreadId.make("thread-session-settlement");
const turnA = TurnId.make("turn-a");
const turnB = TurnId.make("turn-b");

const threadCreated = Effect.gen(function* () {
  const withProject = yield* projectEvent(createEmptyReadModel(now), {
    sequence: 1,
    eventId: EventId.make("event-project-created"),
    aggregateKind: "project",
    aggregateId: ProjectId.make("project-session-settlement"),
    type: "project.created",
    occurredAt: now,
    commandId: CommandId.make("command-project-created"),
    causationEventId: null,
    correlationId: CommandId.make("command-project-created"),
    metadata: {},
    payload: {
      projectId: ProjectId.make("project-session-settlement"),
      title: "Session settlement decider",
      workspaceRoot: "/tmp/session-settlement-decider",
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  });
  return yield* projectEvent(withProject, {
    sequence: 2,
    eventId: EventId.make("event-thread-created"),
    aggregateKind: "thread",
    aggregateId: threadId,
    type: "thread.created",
    occurredAt: now,
    commandId: CommandId.make("command-thread-created"),
    causationEventId: null,
    correlationId: CommandId.make("command-thread-created"),
    metadata: {},
    payload: {
      threadId,
      projectId: ProjectId.make("project-session-settlement"),
      title: "Session settlement thread",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
    },
  });
});

const sessionSetEvent = (
  sequence: number,
  session: {
    readonly status: "running" | "ready";
    readonly activeTurnId: TurnId | null;
    readonly updatedAt: string;
  },
) => ({
  sequence,
  eventId: EventId.make(`event-session-${sequence}`),
  aggregateKind: "thread" as const,
  aggregateId: threadId,
  type: "thread.session-set" as const,
  occurredAt: session.updatedAt,
  commandId: CommandId.make(`command-session-${sequence}`),
  causationEventId: null,
  correlationId: null,
  metadata: {},
  payload: {
    threadId,
    session: {
      threadId,
      status: session.status,
      providerName: "codex",
      runtimeMode: "full-access" as const,
      activeTurnId: session.activeTurnId,
      lastError: null,
      updatedAt: session.updatedAt,
    },
  },
});

const runningTurnReadModel = Effect.gen(function* () {
  const created = yield* threadCreated;
  return yield* projectEvent(
    created,
    sessionSetEvent(3, {
      status: "running",
      activeTurnId: turnA,
      updatedAt: "2026-04-01T00:00:10.000Z",
    }),
  );
});

const decideSessionSet = (
  readModel: OrchestrationReadModel,
  session: {
    readonly status: "running" | "ready" | "stopped";
    readonly activeTurnId: TurnId | null;
    readonly updatedAt: string;
  },
  extra?: { readonly interruptedTurnId?: TurnId; readonly latestTurnCompletedAt?: string | null },
) =>
  Effect.gen(function* () {
    const decided = yield* decideOrchestrationCommand({
      command: {
        type: "thread.session.set",
        commandId: CommandId.make("command-session-decided"),
        threadId,
        session: {
          threadId,
          status: session.status,
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: session.activeTurnId,
          lastError: null,
          updatedAt: session.updatedAt,
        },
        ...(extra?.interruptedTurnId === undefined
          ? {}
          : { interruptedTurnId: extra.interruptedTurnId }),
        ...(extra === undefined || !("latestTurnCompletedAt" in extra)
          ? {}
          : { latestTurnCompletedAt: extra.latestTurnCompletedAt }),
        createdAt: session.updatedAt,
      },
      readModel,
    });
    if ("eventId" in decided) {
      return decided as Omit<
        Extract<OrchestrationEvent, { type: "thread.session-set" }>,
        "sequence"
      >;
    }
    throw new Error("expected a single planned event");
  });

it.layer(NodeServices.layer)("session settlement decider", (it) => {
  it.effect("records the session time as the completion of a settled running turn", () =>
    Effect.gen(function* () {
      const readModel = yield* runningTurnReadModel;
      const event = yield* decideSessionSet(readModel, {
        status: "ready",
        activeTurnId: null,
        updatedAt: "2026-04-01T00:00:30.000Z",
      });

      expect(event.type).toBe("thread.session-set");
      expect(event.payload.settledTurnCompletions).toEqual({
        [turnA]: "2026-04-01T00:00:30.000Z",
      });
    }),
  );

  it.effect("carries an explicit unknown completion verbatim", () =>
    Effect.gen(function* () {
      const readModel = yield* runningTurnReadModel;
      const event = yield* decideSessionSet(
        readModel,
        {
          status: "ready",
          activeTurnId: null,
          updatedAt: "2026-04-01T00:00:30.000Z",
        },
        { latestTurnCompletedAt: null },
      );

      expect(event.payload.settledTurnCompletions).toEqual({ [turnA]: null });
    }),
  );

  it.effect("records the superseded turn when a new turn starts", () =>
    Effect.gen(function* () {
      const readModel = yield* runningTurnReadModel;
      const event = yield* decideSessionSet(readModel, {
        status: "running",
        activeTurnId: turnB,
        updatedAt: "2026-04-01T00:00:40.000Z",
      });

      expect(event.payload.settledTurnCompletions).toEqual({
        [turnA]: "2026-04-01T00:00:40.000Z",
      });
    }),
  );

  it.effect("does not resettle a turn that already settled", () =>
    Effect.gen(function* () {
      const created = yield* threadCreated;
      const running = yield* projectEvent(
        created,
        sessionSetEvent(3, {
          status: "running",
          activeTurnId: turnA,
          updatedAt: "2026-04-01T00:00:10.000Z",
        }),
      );
      const settled = yield* projectEvent(
        running,
        sessionSetEvent(4, {
          status: "ready",
          activeTurnId: null,
          updatedAt: "2026-04-01T00:00:30.000Z",
        }),
      );

      // A later idle stop pins the settled turn id but must not record a new
      // completion for it.
      const event = yield* decideSessionSet(
        settled,
        {
          status: "stopped",
          activeTurnId: null,
          updatedAt: "2026-04-02T00:00:00.000Z",
        },
        { interruptedTurnId: turnA },
      );

      expect(event.payload.settledTurnCompletions).toBeUndefined();
    }),
  );
});
