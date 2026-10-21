import {
  EventId,
  RuntimeItemId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
  type OrchestrationRuntimeItem,
  type RuntimeItemObservation,
} from "@neokod/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  planRuntimeItemClosures,
  projectRuntimeItemClosure,
  projectRuntimeItemObservation,
} from "./RuntimeItemProjection.ts";

const threadId = ThreadId.make("thread-runtime-items");
const turnId = TurnId.make("turn-runtime-items");
const sessionId = RuntimeSessionId.make("session-runtime-items");
const startedAt = "2026-04-01T00:00:00.000Z";

function observation(
  providerState: RuntimeItemObservation["providerState"] = "active",
  scope: RuntimeItemObservation["scope"] = "turn",
): RuntimeItemObservation {
  return {
    runtimeItemId: RuntimeItemId.make("runtime-item-tool-1"),
    providerItemId: null,
    sessionId,
    kind: scope === "detached" ? "delegated-task" : "tool",
    scope,
    turnId: scope === "session" ? null : turnId,
    providerState,
    label: scope === "detached" ? "Delegated task" : "Tool call",
    providerEventId: EventId.make(`provider-${providerState}`),
    observedAt: startedAt,
  };
}

function activeItem(scope: RuntimeItemObservation["scope"] = "turn"): OrchestrationRuntimeItem {
  return projectRuntimeItemObservation({
    existing: null,
    threadId,
    observation: observation("active", scope),
    sequence: 1,
  });
}

function close(
  item: OrchestrationRuntimeItem,
  outcome: "completed" | "failed" | "stopped",
  terminationGuaranteed = true,
  boundary: "turn" | "session" = "turn",
): OrchestrationRuntimeItem {
  const [closure] = planRuntimeItemClosures({
    items: [item],
    boundary,
    sessionId,
    turnId: boundary === "turn" ? turnId : null,
    outcome,
    terminationGuaranteed,
    boundaryEventId: EventId.make(`boundary-${outcome}-${terminationGuaranteed}`),
    closedAt: "2026-04-01T00:01:00.000Z",
  });
  if (!closure) return item;
  return projectRuntimeItemClosure({
    item,
    closure,
    syntheticEventId: EventId.make(`closure-${outcome}-${terminationGuaranteed}`),
    closedAt: "2026-04-01T00:01:00.000Z",
    sequence: 2,
  });
}

describe("RuntimeItemProjection", () => {
  it("uses provider-confirmed terminal state directly", () => {
    const item = projectRuntimeItemObservation({
      existing: activeItem(),
      threadId,
      observation: {
        ...observation("completed"),
        observedAt: "2026-04-01T00:00:30.000Z",
      },
      sequence: 2,
    });

    expect(item).toMatchObject({
      providerState: "completed",
      syntheticState: null,
      effectiveState: "completed",
      terminalSource: "provider",
      mayStillBeRunning: false,
      completedAt: "2026-04-01T00:00:30.000Z",
    });
  });

  it.each(["completed", "failed", "stopped"] as const)(
    "closes a missing provider completion as %s at the authoritative boundary",
    (outcome) => {
      const item = close(activeItem(), outcome);
      expect(item).toMatchObject({
        providerState: "active",
        syntheticState: outcome,
        effectiveState: outcome,
        terminalSource: "synthetic",
        mayStillBeRunning: false,
      });
    },
  );

  it("marks a potentially surviving detached task orphaned", () => {
    const item = close(activeItem("detached"), "stopped");
    expect(item).toMatchObject({
      providerState: "active",
      syntheticState: "orphaned",
      effectiveState: "orphaned",
      terminalSource: "synthetic",
      mayStillBeRunning: true,
    });
  });

  it("lets late provider terminal evidence override synthetic orphan uncertainty", () => {
    const orphaned = close(activeItem("detached"), "stopped");
    const completed = projectRuntimeItemObservation({
      existing: orphaned,
      threadId,
      observation: {
        ...observation("completed", "detached"),
        observedAt: "2026-04-01T00:02:00.000Z",
      },
      sequence: 3,
    });

    expect(completed).toMatchObject({
      providerState: "completed",
      syntheticState: "orphaned",
      effectiveState: "completed",
      terminalSource: "provider",
      mayStillBeRunning: false,
      completedAt: "2026-04-01T00:02:00.000Z",
    });
  });

  it("keeps detached work orphaned until provider terminal evidence arrives", () => {
    const orphaned = close(activeItem("detached"), "stopped");
    expect(close(orphaned, "stopped", true, "session")).toBe(orphaned);
  });

  it("upgrades a session-scoped uncertain orphan after confirmed termination", () => {
    const orphaned = close(activeItem("session"), "stopped", false, "session");
    expect(orphaned.syntheticState).toBe("orphaned");
    expect(close(orphaned, "stopped", true, "session")).toMatchObject({
      syntheticState: "stopped",
      effectiveState: "stopped",
      mayStillBeRunning: false,
    });
  });

  it.each([
    ["approval", "cancelled", "approval.resolved"],
    ["user-input", "cancelled", "user-input.resolved"],
    ["assistant-message", "interrupted", "assistant.interrupted"],
  ] as const)("closes %s items with their semantic terminal", (kind, state, activityKind) => {
    const item = { ...activeItem(), kind, label: kind };
    const [closure] = planRuntimeItemClosures({
      items: [item],
      boundary: "turn",
      sessionId,
      turnId,
      outcome: "stopped",
      terminationGuaranteed: true,
      boundaryEventId: EventId.make(`boundary-${kind}`),
      closedAt: "2026-04-01T00:01:00.000Z",
    });
    expect(closure).toMatchObject({ syntheticState: state, activity: { kind: activityKind } });
  });

  it("leaves items opened after the session update active in the same session", () => {
    const older = activeItem();
    const newer = projectRuntimeItemObservation({
      existing: null,
      threadId,
      observation: {
        ...observation(),
        runtimeItemId: RuntimeItemId.make("approval-newer"),
        kind: "approval",
        label: "Approve command",
        observedAt: "2026-04-01T00:02:00.000Z",
      },
      sequence: 2,
    });

    const closures = planRuntimeItemClosures({
      items: [older, newer],
      boundary: "session",
      sessionId,
      turnId: null,
      outcome: "stopped",
      terminationGuaranteed: false,
      boundaryEventId: EventId.make("bounded-session-closure"),
      closedAt: "2026-04-01T00:03:00.000Z",
      observedNoLaterThan: "2026-04-01T00:01:00.000Z",
    });

    expect(closures.map((closure) => closure.runtimeItemId)).toEqual([older.runtimeItemId]);
  });

  it("freezes an orphaned item at its last observation, not the recovery time", () => {
    const item = activeItem("session");
    const closedAt = "2026-04-01T00:30:00.000Z";
    const [closure] = planRuntimeItemClosures({
      items: [item],
      boundary: "session",
      sessionId,
      turnId: null,
      outcome: "stopped",
      terminationGuaranteed: false,
      boundaryEventId: EventId.make("orphaned-session-closure"),
      closedAt,
    });
    if (!closure) throw new Error("expected an orphaned closure");

    const projected = projectRuntimeItemClosure({
      item,
      closure,
      syntheticEventId: EventId.make("orphaned-session-event"),
      closedAt,
      sequence: 9,
    });

    expect(projected.syntheticState).toBe("orphaned");
    // Last observed evidence ends the orphaned interval; the recovery event
    // still owns ordering through `lastSequence` and `updatedAt`.
    expect(projected.completedAt).toBe(item.updatedAt);
    expect(projected.updatedAt).toBe(closedAt);
    expect(projected.lastSequence).toBe(9);
  });

  it("does not close an item from an older session generation", () => {
    const item = activeItem();
    expect(
      planRuntimeItemClosures({
        items: [item],
        boundary: "session",
        sessionId: RuntimeSessionId.make("new-session"),
        turnId: null,
        outcome: "stopped",
        terminationGuaranteed: true,
        boundaryEventId: EventId.make("new-session-stopped"),
        closedAt: "2026-04-01T00:01:00.000Z",
      }),
    ).toEqual([]);
  });

  it("is idempotent for replayed provider observations and closure events", () => {
    const observed = activeItem();
    const replayedObservation = projectRuntimeItemObservation({
      existing: observed,
      threadId,
      observation: observation(),
      sequence: 1,
    });
    const closed = close(replayedObservation, "completed");
    const replayedClosure = close(closed, "completed");

    expect(replayedObservation).toEqual(observed);
    expect(replayedClosure).toBe(closed);
  });

  it("preserves an existing provider terminal fact against later active observations", () => {
    const terminal = projectRuntimeItemObservation({
      existing: activeItem(),
      threadId,
      observation: observation("failed"),
      sequence: 2,
    });
    const staleActive = projectRuntimeItemObservation({
      existing: terminal,
      threadId,
      observation: {
        ...observation("active"),
        observedAt: "2026-04-01T00:04:00.000Z",
      },
      sequence: 3,
    });

    expect(staleActive.providerState).toBe("failed");
    expect(staleActive.effectiveState).toBe("failed");
    expect(staleActive.terminalSource).toBe("provider");
  });
});
