import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ProviderInstanceId,
  RuntimeItemId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
} from "@neokod/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-04-01T00:00:00.000Z";
const threadId = ThreadId.make("thread-runtime-decider");
const turnId = TurnId.make("turn-runtime-decider");
const sessionId = RuntimeSessionId.make("session-runtime-decider");

const seededReadModel = Effect.gen(function* () {
  const withProject = yield* projectEvent(createEmptyReadModel(now), {
    sequence: 1,
    eventId: EventId.make("event-project-created"),
    aggregateKind: "project",
    aggregateId: ProjectId.make("project-runtime-decider"),
    type: "project.created",
    occurredAt: now,
    commandId: CommandId.make("command-project-created"),
    causationEventId: null,
    correlationId: CommandId.make("command-project-created"),
    metadata: {},
    payload: {
      projectId: ProjectId.make("project-runtime-decider"),
      title: "Runtime item decider",
      workspaceRoot: "/tmp/runtime-item-decider",
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
      projectId: ProjectId.make("project-runtime-decider"),
      title: "Runtime item thread",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
    },
  });
});

it.layer(NodeServices.layer)("runtime-item decider", (it) => {
  it.effect("derives deterministic observation and closure event identities", () =>
    Effect.gen(function* () {
      const readModel = yield* seededReadModel;
      const observeCommand = {
        type: "thread.runtime-item.observe" as const,
        commandId: CommandId.make("provider:event-tool-started:runtime-item-observe"),
        threadId,
        observation: {
          runtimeItemId: RuntimeItemId.make("runtime-tool-1"),
          providerItemId: null,
          sessionId,
          kind: "tool" as const,
          scope: "turn" as const,
          turnId,
          providerState: "active" as const,
          label: "Tool call",
          providerEventId: EventId.make("provider-event-tool-started"),
          observedAt: now,
        },
        createdAt: now,
      };

      const firstObservation = yield* decideOrchestrationCommand({
        command: observeCommand,
        readModel,
      });
      const replayedObservation = yield* decideOrchestrationCommand({
        command: observeCommand,
        readModel,
      });
      expect(firstObservation).toEqual(replayedObservation);
      expect(
        "eventId" in firstObservation ? firstObservation.eventId : firstObservation[0]?.eventId,
      ).toBe("runtime-item:provider-event-tool-started");

      const closeCommand = {
        type: "thread.runtime-items.close" as const,
        commandId: CommandId.make("provider:event-turn-completed:runtime-items-close"),
        threadId,
        boundary: "turn" as const,
        turnId,
        terminationGuaranteed: true,
        closures: [
          {
            runtimeItemId: observeCommand.observation.runtimeItemId,
            sessionId,
            kind: "tool" as const,
            syntheticState: "completed" as const,
            activity: {
              id: EventId.make("runtime-tool-1-synthetic-terminal"),
              tone: "tool" as const,
              kind: "tool.completed",
              summary: "Tool completed",
              payload: { itemId: "runtime-tool-1", status: "completed", synthetic: true },
              turnId,
              createdAt: "2026-04-01T00:01:00.000Z",
            },
          },
        ],
        createdAt: "2026-04-01T00:01:00.000Z",
      };
      const closure = yield* decideOrchestrationCommand({ command: closeCommand, readModel });
      const closureEvent = Array.isArray(closure) ? closure[0] : closure;

      expect(closureEvent.eventId).toBe(
        "runtime-close:provider:event-turn-completed:runtime-items-close",
      );
      expect(closureEvent.type).toBe("thread.runtime-items-closed");
      if (closureEvent.type === "thread.runtime-items-closed") {
        expect(closureEvent.payload.terminationGuaranteed).toBe(true);
        expect(closureEvent.payload.closures).toHaveLength(1);
      }
      expect(Array.isArray(closure) ? closure[1]?.eventId : undefined).toBe(
        "runtime-tool-1-synthetic-terminal",
      );
    }),
  );
});
