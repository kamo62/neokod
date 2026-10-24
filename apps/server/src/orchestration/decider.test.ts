import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@neokod/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-04-01T00:00:00.000Z";
const projectId = ProjectId.make("project-turn-outcome-decider");
const threadId = ThreadId.make("thread-turn-outcome-decider");

const seededReadModel = Effect.gen(function* () {
  const withProject = yield* projectEvent(createEmptyReadModel(now), {
    sequence: 1,
    eventId: EventId.make("event-project-created"),
    aggregateKind: "project",
    aggregateId: projectId,
    type: "project.created",
    occurredAt: now,
    commandId: CommandId.make("command-project-created"),
    causationEventId: null,
    correlationId: CommandId.make("command-project-created"),
    metadata: {},
    payload: {
      projectId,
      title: "Turn outcome decider",
      workspaceRoot: "/tmp/turn-outcome-decider",
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
      projectId,
      title: "Turn outcome thread",
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

it.layer(NodeServices.layer)("turn outcome decider", (it) => {
  it.effect("requires a target turn for an explicit outcome and forwards both", () =>
    Effect.gen(function* () {
      const readModel = yield* seededReadModel;
      const session = {
        threadId,
        status: "ready" as const,
        providerName: "codex",
        runtimeMode: "full-access" as const,
        activeTurnId: null,
        lastError: null,
        updatedAt: now,
      };

      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.session.set",
            commandId: CommandId.make("command-outcome-without-target"),
            threadId,
            session,
            latestTurnOutcome: "interrupted",
            createdAt: now,
          },
          readModel,
        }),
      );
      expect(error.message).toContain("latestTurnOutcome requires interruptedTurnId");

      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.session.set",
          commandId: CommandId.make("command-outcome-with-target"),
          threadId,
          session,
          interruptedTurnId: TurnId.make("turn-outcome"),
          latestTurnOutcome: "interrupted",
          createdAt: now,
        },
        readModel,
      });
      const event = Array.isArray(decided) ? decided[0] : decided;
      expect(event?.type).toBe("thread.session-set");
      if (event?.type === "thread.session-set") {
        expect(event.payload.interruptedTurnId).toBe("turn-outcome");
        expect(event.payload.latestTurnOutcome).toBe("interrupted");
      }
    }),
  );
});
