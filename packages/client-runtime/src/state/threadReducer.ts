import { pipe } from "effect/Function";
import * as Arr from "effect/Array";
import * as O from "effect/Order";
import type {
  MessageId,
  OrchestrationCheckpointSummary,
  OrchestrationEvent,
  OrchestrationLatestTurn,
  OrchestrationMessage,
  OrchestrationSession,
  OrchestrationThread,
  OrchestrationThreadActivity,
  TurnId,
} from "@neokod/contracts";

export type ThreadDetailReducerResult =
  | { readonly kind: "updated"; readonly thread: OrchestrationThread }
  | { readonly kind: "deleted" }
  | { readonly kind: "unchanged" };

const proposedPlanOrder = O.combine<OrchestrationThread["proposedPlans"][number]>(
  O.mapInput(O.String, (p) => p.createdAt),
  O.mapInput(O.String, (p) => p.id),
);

const checkpointOrder = O.mapInput(
  O.Number,
  (cp: OrchestrationThread["checkpoints"][number]) =>
    cp.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER,
);

const activityOrder = O.combineAll<OrchestrationThreadActivity>([
  O.mapInput(O.Number, (a) => a.sequence ?? Number.MAX_SAFE_INTEGER),
  O.mapInput(O.String, (a) => a.createdAt),
  O.mapInput(O.String, (a) => a.id),
]);

/**
 * Apply a single orchestration event to an `OrchestrationThread`, returning
 * the updated thread, a deletion signal, or an "unchanged" marker when the
 * event doesn't affect this thread.
 *
 * This is a pure reducer operating on contract types. UI-specific mapping
 * (e.g. resolving attachment preview URLs, normalising model slugs, adding
 * scoped fields like `environmentId`) is the caller's responsibility.
 */
export function applyThreadDetailEvent(
  thread: OrchestrationThread,
  event: OrchestrationEvent,
): ThreadDetailReducerResult {
  switch (event.type) {
    // ── Project events (irrelevant to thread detail) ────────────────
    case "project.created":
    case "project.meta-updated":
    case "project.deleted":
      return { kind: "unchanged" };

    // ── Thread lifecycle ────────────────────────────────────────────
    case "thread.created":
      return {
        kind: "updated",
        thread: {
          id: event.payload.threadId,
          projectId: event.payload.projectId,
          title: event.payload.title,
          modelSelection: event.payload.modelSelection,
          runtimeMode: event.payload.runtimeMode,
          interactionMode: event.payload.interactionMode,
          branch: event.payload.branch,
          worktreePath: event.payload.worktreePath,
          latestTurn: null,
          settledTurnCompletions: {},
          createdAt: event.payload.createdAt,
          updatedAt: event.payload.updatedAt,
          archivedAt: null,
          deletedAt: null,
          messages: [],
          proposedPlans: [],
          activities: [],
          checkpoints: [],
          session: null,
        },
      };

    case "thread.deleted":
      return { kind: "deleted" };

    case "thread.archived":
      return {
        kind: "updated",
        thread: {
          ...thread,
          archivedAt: event.payload.archivedAt,
          updatedAt: event.payload.updatedAt,
        },
      };

    case "thread.unarchived":
      return {
        kind: "updated",
        thread: { ...thread, archivedAt: null, updatedAt: event.payload.updatedAt },
      };

    // ── Thread metadata ─────────────────────────────────────────────
    case "thread.meta-updated":
      return {
        kind: "updated",
        thread: {
          ...thread,
          ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
          ...(event.payload.modelSelection !== undefined
            ? { modelSelection: event.payload.modelSelection }
            : {}),
          ...(event.payload.branch !== undefined ? { branch: event.payload.branch } : {}),
          ...(event.payload.worktreePath !== undefined
            ? { worktreePath: event.payload.worktreePath }
            : {}),
          ...(event.payload.goal !== undefined ? { goal: event.payload.goal } : {}),
          ...(event.payload.goalStatus !== undefined
            ? { goalStatus: event.payload.goalStatus }
            : {}),
          updatedAt: event.payload.updatedAt,
        },
      };

    case "thread.runtime-mode-set":
      return {
        kind: "updated",
        thread: {
          ...thread,
          runtimeMode: event.payload.runtimeMode,
          updatedAt: event.payload.updatedAt,
        },
      };

    case "thread.interaction-mode-set":
      return {
        kind: "updated",
        thread: {
          ...thread,
          interactionMode: event.payload.interactionMode,
          updatedAt: event.payload.updatedAt,
        },
      };

    // ── Turn lifecycle ──────────────────────────────────────────────
    case "thread.turn-start-requested":
      return {
        kind: "updated",
        thread: {
          ...thread,
          ...(event.payload.modelSelection !== undefined
            ? { modelSelection: event.payload.modelSelection }
            : {}),
          runtimeMode: event.payload.runtimeMode,
          interactionMode: event.payload.interactionMode,
          updatedAt: event.occurredAt,
        },
      };

    case "thread.turn-interrupt-requested": {
      if (event.payload.turnId === undefined) {
        return { kind: "unchanged" };
      }
      const latestTurn = thread.latestTurn;
      if (latestTurn === null || latestTurn.turnId !== event.payload.turnId) {
        return { kind: "unchanged" };
      }
      // A request is intent, not evidence. It may present the turn as stopped
      // immediately, but only server-observed settlement writes the per-turn
      // completion record; a failed interrupt must not freeze the turn here.
      return {
        kind: "updated",
        thread: {
          ...thread,
          latestTurn: {
            ...latestTurn,
            state: "interrupted",
            startedAt: latestTurn.startedAt ?? event.payload.createdAt,
            completedAt: latestTurn.completedAt ?? event.payload.createdAt,
          },
          updatedAt: event.occurredAt,
        },
      };
    }

    // ── Messages ────────────────────────────────────────────────────
    case "thread.message-sent": {
      const message: OrchestrationMessage = {
        id: event.payload.messageId,
        role: event.payload.role,
        text: event.payload.text,
        ...(event.payload.attachments !== undefined
          ? { attachments: event.payload.attachments }
          : {}),
        turnId: event.payload.turnId,
        streaming: event.payload.streaming,
        createdAt: event.payload.createdAt,
        updatedAt: event.payload.updatedAt,
      };

      const existingMessage = thread.messages.find((entry) => entry.id === message.id);
      const messages = existingMessage
        ? Arr.map(thread.messages, (entry) =>
            entry.id !== message.id
              ? entry
              : {
                  ...entry,
                  text: message.streaming
                    ? `${entry.text}${message.text}`
                    : message.text.length > 0
                      ? message.text
                      : entry.text,
                  streaming: message.streaming,
                  ...(message.turnId !== undefined ? { turnId: message.turnId } : {}),
                  ...(message.streaming ? {} : { updatedAt: message.updatedAt }),
                  ...(message.attachments !== undefined
                    ? { attachments: message.attachments }
                    : {}),
                },
          )
        : Arr.append(thread.messages, message);
      // Update latestTurn for assistant messages bound to a turn. A completed
      // assistant message only settles the turn once the session is no longer
      // running it — providers may emit several assistant messages per turn
      // (commentary between tool calls), and the turn must stay unsettled
      // until the provider reports turn end.
      const turnStillRunning = sessionRunsTurn(thread.session, event.payload.turnId);
      const settlesTurn = !event.payload.streaming && !turnStillRunning;
      const existingLatestTurn = thread.latestTurn;
      const sameTurn = existingLatestTurn?.turnId === event.payload.turnId;
      // A recovered turn may already be terminal with known or explicitly
      // unknown completion. Synthetic message closure must not replace that
      // authoritative turn timing with the message's own last update.
      const existingSettled =
        sameTurn && existingLatestTurn !== null && existingLatestTurn.state !== "running";
      const latestTurn: OrchestrationThread["latestTurn"] =
        event.payload.role === "assistant" &&
        event.payload.turnId !== null &&
        (existingLatestTurn === null || sameTurn)
          ? {
              turnId: event.payload.turnId,
              state: settlesTurn
                ? existingLatestTurn?.state === "interrupted"
                  ? "interrupted"
                  : existingLatestTurn?.state === "error"
                    ? "error"
                    : "completed"
                : "running",
              requestedAt: sameTurn ? existingLatestTurn.requestedAt : event.payload.createdAt,
              startedAt: sameTurn
                ? (existingLatestTurn.startedAt ?? event.payload.createdAt)
                : event.payload.createdAt,
              completedAt: settlesTurn
                ? existingSettled
                  ? (existingLatestTurn.completedAt ?? null)
                  : event.payload.updatedAt
                : sameTurn
                  ? (existingLatestTurn.completedAt ?? null)
                  : null,
              assistantMessageId: event.payload.messageId,
            }
          : existingLatestTurn;

      // Rebind checkpoint assistant message IDs for assistant messages.
      const checkpoints =
        event.payload.role === "assistant" && event.payload.turnId !== null
          ? rebindCheckpointAssistantMessage(
              thread.checkpoints,
              event.payload.turnId,
              event.payload.messageId,
            )
          : thread.checkpoints;

      return {
        kind: "updated",
        thread: {
          ...thread,
          messages,
          checkpoints,
          latestTurn,
          updatedAt: event.occurredAt,
        },
      };
    }

    // ── Session ─────────────────────────────────────────────────────
    case "thread.session-set": {
      // The latest-turn projection is presentation only: it keeps the active
      // turn and its terminal state visible. Settlement timing comes from the
      // server's per-turn record, never from this transition.
      const settledTurnState = settledTurnStateForSessionStatus(event.payload.session.status);
      const latestTurn: OrchestrationLatestTurn | null =
        event.payload.session.status === "running" && event.payload.session.activeTurnId !== null
          ? {
              turnId: event.payload.session.activeTurnId,
              state: "running",
              requestedAt:
                thread.latestTurn?.turnId === event.payload.session.activeTurnId
                  ? thread.latestTurn.requestedAt
                  : event.payload.session.updatedAt,
              startedAt:
                thread.latestTurn?.turnId === event.payload.session.activeTurnId
                  ? (thread.latestTurn.startedAt ?? event.payload.session.updatedAt)
                  : event.payload.session.updatedAt,
              completedAt: null,
              assistantMessageId:
                thread.latestTurn?.turnId === event.payload.session.activeTurnId
                  ? thread.latestTurn.assistantMessageId
                  : null,
            }
          : thread.latestTurn !== null &&
              (thread.latestTurn.state === "running" ||
                sessionRunsTurn(thread.session, thread.latestTurn.turnId)) &&
              settledTurnState !== null
            ? {
                ...thread.latestTurn,
                state: settledTurnState,
                // A running turn's completedAt can only hold a mid-turn
                // placeholder checkpoint timestamp. Recovery can freeze it at
                // the last observation instead of the event time. An explicit
                // null means no observation exists; only an omitted field
                // keeps the legacy session-time default.
                completedAt:
                  event.payload.latestTurnCompletedAt === undefined
                    ? event.payload.session.updatedAt
                    : event.payload.latestTurnCompletedAt,
              }
            : thread.latestTurn;

      return {
        kind: "updated",
        thread: {
          ...thread,
          session: event.payload.session,
          latestTurn,
          updatedAt: event.occurredAt,
        },
      };
    }

    // The durable turn projection owns settlement. This event republishes the
    // per-turn completion it persisted, so the client stores it verbatim and
    // never derives timing from session transitions or request events.
    case "thread.turn-settled": {
      const { turnId, completedAt } = event.payload;
      const settledTurnCompletions = mergeServerSettlements(thread.settledTurnCompletions, {
        [turnId]: completedAt,
      });
      const latestTurn =
        thread.latestTurn !== null && thread.latestTurn.turnId === turnId
          ? { ...thread.latestTurn, completedAt }
          : thread.latestTurn;
      return {
        kind: "updated",
        thread: {
          ...thread,
          latestTurn,
          settledTurnCompletions,
          updatedAt: event.occurredAt,
        },
      };
    }

    // A stop request is intent, not evidence. Mutating the session here would
    // erase the running binding that distinguishes a provisional interrupt
    // boundary from an observed settlement, so the session and turn state stay
    // untouched until the server confirms the stop.
    case "thread.session-stop-requested":
      return { kind: "unchanged" };

    // ── Proposed plans ──────────────────────────────────────────────
    case "thread.proposed-plan-upserted": {
      const proposedPlan = event.payload.proposedPlan;

      const proposedPlans = pipe(
        thread.proposedPlans,
        Arr.filter((entry) => entry.id !== proposedPlan.id),
        Arr.append(proposedPlan),
        Arr.sort(proposedPlanOrder),
      );

      return {
        kind: "updated",
        thread: { ...thread, proposedPlans, updatedAt: event.occurredAt },
      };
    }

    // ── Checkpoints / turn diffs ────────────────────────────────────
    case "thread.turn-diff-completed": {
      const checkpoint: OrchestrationCheckpointSummary = {
        turnId: event.payload.turnId,
        checkpointTurnCount: event.payload.checkpointTurnCount,
        checkpointRef: event.payload.checkpointRef,
        status: event.payload.status,
        files: event.payload.files,
        assistantMessageId: event.payload.assistantMessageId,
        completedAt: event.payload.completedAt,
      };

      const existing = thread.checkpoints.find((entry) => entry.turnId === checkpoint.turnId);
      // Don't overwrite a non-missing checkpoint with a missing one.
      if (existing && existing.status !== "missing" && checkpoint.status === "missing") {
        return { kind: "unchanged" };
      }

      const checkpoints = pipe(
        thread.checkpoints,
        Arr.filter((entry) => entry.turnId !== checkpoint.turnId),
        Arr.append(checkpoint),
        Arr.sort(checkpointOrder),
      );

      // Mid-turn diff updates produce placeholder checkpoints; record the
      // checkpoint, but don't settle a turn its session is still running.
      const diffTurnStillRunning = sessionRunsTurn(thread.session, event.payload.turnId);
      const existingLatestTurn = thread.latestTurn;
      // A turn that already settled keeps its lifecycle and completion. A late
      // checkpoint only contributes checkpoint metadata.
      const latestTurnAlreadySettled =
        existingLatestTurn !== null && existingLatestTurn.state !== "running";
      const settlesTurn =
        !diffTurnStillRunning &&
        (existingLatestTurn === null || existingLatestTurn.turnId === event.payload.turnId);
      const latestTurn = settlesTurn
        ? {
            turnId: event.payload.turnId,
            state: latestTurnAlreadySettled
              ? existingLatestTurn.state
              : checkpointStatusToTurnState(event.payload.status),
            requestedAt: existingLatestTurn?.requestedAt ?? event.payload.completedAt,
            startedAt: existingLatestTurn?.startedAt ?? event.payload.completedAt,
            completedAt: latestTurnAlreadySettled
              ? existingLatestTurn.completedAt
              : event.payload.completedAt,
            assistantMessageId: event.payload.assistantMessageId,
          }
        : existingLatestTurn;

      return {
        kind: "updated",
        thread: {
          ...thread,
          checkpoints,
          latestTurn,
          updatedAt: event.occurredAt,
        },
      };
    }

    // ── Revert ──────────────────────────────────────────────────────
    case "thread.reverted": {
      const checkpoints = pipe(
        thread.checkpoints,
        Arr.filter(
          (entry) =>
            entry.checkpointTurnCount !== undefined &&
            entry.checkpointTurnCount <= event.payload.turnCount,
        ),
        Arr.sort(checkpointOrder),
      );

      const retainedTurnIds = new Set(Arr.map(checkpoints, (entry) => entry.turnId));
      const messages = retainMessagesAfterRevert(thread.messages, retainedTurnIds);
      const proposedPlans = pipe(
        thread.proposedPlans,
        Arr.filter((plan) => plan.turnId === null || retainedTurnIds.has(plan.turnId)),
      );
      const activities = pipe(
        thread.activities,
        Arr.filter((activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId)),
      );
      const latestCheckpoint = checkpoints.at(-1) ?? null;

      return {
        kind: "updated",
        thread: {
          ...thread,
          checkpoints,
          messages,
          proposedPlans,
          activities,
          latestTurn:
            latestCheckpoint === null
              ? null
              : {
                  turnId: latestCheckpoint.turnId,
                  state: checkpointStatusToTurnState(
                    latestCheckpoint.status as "ready" | "missing" | "error",
                  ),
                  requestedAt: latestCheckpoint.completedAt,
                  startedAt: latestCheckpoint.completedAt,
                  completedAt: latestCheckpoint.completedAt,
                  assistantMessageId: latestCheckpoint.assistantMessageId ?? null,
                },
          updatedAt: event.occurredAt,
        },
      };
    }

    // ── Activities ──────────────────────────────────────────────────
    case "thread.activity-appended": {
      const activities = pipe(
        thread.activities,
        Arr.filter((activity) => activity.id !== event.payload.activity.id),
        Arr.append(event.payload.activity),
        Arr.sort(activityOrder),
      );

      return {
        kind: "updated",
        thread: { ...thread, activities, updatedAt: event.occurredAt },
      };
    }

    // ── Events that don't mutate thread state directly ──────────────
    case "thread.approval-response-requested":
    case "thread.user-input-response-requested":
    case "thread.checkpoint-revert-requested":
      return { kind: "unchanged" };
  }

  // Forward-compatible: ignore unrecognized event types.
  return { kind: "unchanged" };
}

// ── Helpers ──────────────────────────────────────────────────────────

type SettledTurnCompletions = NonNullable<OrchestrationThread["settledTurnCompletions"]>;

/**
 * Whether a session still reports `turnId` as running. Used only for the
 * latest-turn presentation; settlement timing is server-owned.
 */
function sessionRunsTurn(session: OrchestrationSession | null, turnId: TurnId | null): boolean {
  return (
    session !== null &&
    session.status === "running" &&
    turnId !== null &&
    session.activeTurnId === turnId
  );
}

/**
 * Merge server-recorded settlement into the client record.
 *
 * Closure and timestamps are server-owned, so the values are stored verbatim:
 * a timestamp is the server's completion observation and `null` is an explicit
 * unknown. The client never derives a completion from requests, session status
 * transitions or supersession.
 */
function mergeServerSettlements(
  current: OrchestrationThread["settledTurnCompletions"],
  settlements: Readonly<Record<TurnId, string | null>> | undefined,
): OrchestrationThread["settledTurnCompletions"] {
  if (settlements === undefined) {
    return current;
  }
  const turnIds = Object.keys(settlements) as TurnId[];
  if (turnIds.length === 0) {
    return current;
  }
  const base: SettledTurnCompletions = current ?? {};
  let next: Record<TurnId, string | null> | null = null;
  for (const turnId of turnIds) {
    const completedAt = settlements[turnId] ?? null;
    if (Object.hasOwn(base, turnId) && base[turnId] === completedAt) {
      continue;
    }
    next ??= { ...base };
    next[turnId] = completedAt;
  }
  return next ?? current;
}

function sameSettledTurnCompletions(
  left: SettledTurnCompletions,
  right: SettledTurnCompletions,
): boolean {
  const leftKeys = Object.keys(left) as TurnId[];
  return (
    leftKeys.length === Object.keys(right).length &&
    leftKeys.every((key) => Object.hasOwn(right, key) && left[key] === right[key])
  );
}

/**
 * A turn the previous client state showed as latest, that a newer snapshot no
 * longer names and that holds no settlement evidence, was superseded while the
 * client was disconnected. The snapshot cannot supply its completion, so the
 * turn becomes an explicit unknown rather than falling back to incidental
 * entries.
 */
function supersededUnsettledTurnId(
  previous: OrchestrationThread | null,
  thread: OrchestrationThread,
  record: SettledTurnCompletions,
): TurnId | null {
  if (previous === null || previous.id !== thread.id) {
    return null;
  }
  const previousTurnId = previous.latestTurn?.turnId ?? null;
  if (previousTurnId === null || thread.latestTurn?.turnId === previousTurnId) {
    return null;
  }
  if (Object.hasOwn(record, previousTurnId)) {
    return null;
  }
  if (Object.hasOwn(previous.settledTurnCompletions ?? {}, previousTurnId)) {
    return null;
  }
  return previousTurnId;
}

/**
 * Attach the snapshot's server-recorded settlement to a freshly loaded thread.
 *
 * Snapshots carry the durable per-turn record; a client that observed live
 * settlements keeps them only when the server snapshot does not report the
 * field at all. A previously unsettled turn that the snapshot supersedes is
 * recorded as an explicit unknown.
 */
export function withSnapshotSettlementEvidence(
  thread: OrchestrationThread,
  previous: OrchestrationThread | null,
): OrchestrationThread {
  const sameThread = previous !== null && previous.id === thread.id;
  const record: SettledTurnCompletions =
    thread.settledTurnCompletions ?? (sameThread ? (previous.settledTurnCompletions ?? {}) : {});
  const supersededTurnId = supersededUnsettledTurnId(previous, thread, record);
  const nextRecord: SettledTurnCompletions =
    supersededTurnId === null ? record : { ...record, [supersededTurnId]: null };
  const current: SettledTurnCompletions = thread.settledTurnCompletions ?? {};
  return sameSettledTurnCompletions(nextRecord, current)
    ? thread
    : { ...thread, settledTurnCompletions: nextRecord };
}

/**
 * Turn state to settle a still-running latest turn with when its session
 * leaves the "running" status, or null while the session is (re)starting or
 * running and the turn must stay unsettled.
 */
function settledTurnStateForSessionStatus(
  status: OrchestrationSession["status"],
): "completed" | "interrupted" | "error" | null {
  switch (status) {
    case "idle":
    case "ready":
      return "completed";
    case "error":
      return "error";
    case "interrupted":
    case "stopped":
      return "interrupted";
    case "starting":
    case "running":
      return null;
  }
}

function checkpointStatusToTurnState(
  status: "ready" | "missing" | "error",
): OrchestrationLatestTurn["state"] {
  switch (status) {
    case "ready":
      return "completed";
    case "error":
      return "error";
    case "missing":
      return "completed";
  }
}

function rebindCheckpointAssistantMessage(
  checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>,
  turnId: TurnId,
  messageId: MessageId,
): OrchestrationCheckpointSummary[] {
  return Arr.map(checkpoints, (entry) =>
    entry.turnId === turnId ? { ...entry, assistantMessageId: messageId } : entry,
  );
}

function retainMessagesAfterRevert(
  messages: ReadonlyArray<OrchestrationMessage>,
  retainedTurnIds: ReadonlySet<string>,
): OrchestrationMessage[] {
  // Keep messages that belong to a retained turn, plus system messages and
  // messages without a turn binding (pre-turn-0 user messages).
  return Arr.filter(messages, (message) => {
    if (message.role === "system") {
      return true;
    }
    if (message.turnId === null) {
      return true;
    }
    return retainedTurnIds.has(message.turnId);
  });
}
