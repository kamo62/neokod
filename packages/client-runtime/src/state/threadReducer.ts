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

      // Only a completed assistant message that closes its own turn supplies
      // settlement evidence; provisional interrupt boundaries stay provisional.
      const settlementEvidence = withSettlementEvidence(
        thread,
        authoritativeSettlement(latestTurn, thread.session),
      );
      // Rebind checkpoint assistant message IDs for assistant messages.
      const checkpoints =
        event.payload.role === "assistant" && event.payload.turnId !== null
          ? rebindCheckpointAssistantMessage(
              settlementEvidence.checkpoints,
              event.payload.turnId,
              event.payload.messageId,
            )
          : settlementEvidence.checkpoints;

      return {
        kind: "updated",
        thread: {
          ...thread,
          messages,
          checkpoints,
          settledTurnCompletions: settlementEvidence.settledTurnCompletions,
          latestTurn,
          updatedAt: event.occurredAt,
        },
      };
    }

    // ── Session ─────────────────────────────────────────────────────
    case "thread.session-set": {
      // Leaving the "running" session status is the turn-end signal: settle a
      // still-running latest turn so its duration reflects the whole turn. A
      // turn the session was still running is settled here too, even when an
      // interrupt request already presented it as terminal: that boundary was
      // provisional, so the session event supplies the authoritative timing.
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

      // Starting a turn supersedes whatever turn the client was showing. An
      // authoritative new turn is the end of the previous one: a turn that
      // already settled contributes its own completion, while a running or
      // provisionally interrupted turn ends at this session's observation.
      const isRunningSession =
        event.payload.session.status === "running" && event.payload.session.activeTurnId !== null;
      const previousSettlement = authoritativeSettlement(thread.latestTurn, thread.session);
      const supersededTurn =
        isRunningSession &&
        thread.latestTurn !== null &&
        thread.latestTurn.turnId !== event.payload.session.activeTurnId
          ? thread.latestTurn
          : null;
      const supersededSettlement: TurnSettlement | null =
        supersededTurn === null
          ? null
          : previousSettlement !== null && previousSettlement.turnId === supersededTurn.turnId
            ? previousSettlement
            : {
                turnId: supersededTurn.turnId,
                completedAt:
                  event.payload.latestTurnCompletedAt === undefined
                    ? event.payload.session.updatedAt
                    : event.payload.latestTurnCompletedAt,
              };
      // The event itself is closure evidence for the turn the session was
      // running, unless the thread already holds that turn's settlement.
      const closedTurnId =
        settledTurnState === null
          ? null
          : (event.payload.interruptedTurnId ??
            (thread.latestTurn !== null &&
            (thread.latestTurn.state === "running" ||
              sessionRunsTurn(thread.session, thread.latestTurn.turnId))
              ? thread.latestTurn.turnId
              : null));
      const heldSettlement =
        closedTurnId !== null &&
        thread.latestTurn !== null &&
        thread.latestTurn.turnId === closedTurnId
          ? previousSettlement
          : null;
      const closedSettlement: TurnSettlement | null =
        closedTurnId === null
          ? null
          : (heldSettlement ?? {
              turnId: closedTurnId,
              completedAt:
                event.payload.latestTurnCompletedAt === undefined
                  ? event.payload.session.updatedAt
                  : event.payload.latestTurnCompletedAt,
            });
      // First authoritative settlement wins. A later session stop or turn
      // start must not rewrite a turn that is already settled, and checkpoint
      // summaries keep the timing its settlement froze.
      const { settledTurnCompletions, checkpoints } = withSettlementEvidence(
        thread,
        supersededSettlement ?? closedSettlement,
      );

      return {
        kind: "updated",
        thread: {
          ...thread,
          session: event.payload.session,
          latestTurn,
          settledTurnCompletions,
          checkpoints,
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
      // Only a checkpoint that actually closes the turn supplies settlement
      // evidence. A placeholder checkpoint for a running turn must not freeze
      // a provisional interrupt boundary as if it were a completion.
      const settlesTurn =
        !diffTurnStillRunning &&
        (thread.latestTurn === null || thread.latestTurn.turnId === event.payload.turnId);
      const latestTurn = settlesTurn
        ? {
            turnId: event.payload.turnId,
            state: checkpointStatusToTurnState(event.payload.status),
            requestedAt: thread.latestTurn?.requestedAt ?? event.payload.completedAt,
            startedAt: thread.latestTurn?.startedAt ?? event.payload.completedAt,
            completedAt: event.payload.completedAt,
            assistantMessageId: event.payload.assistantMessageId,
          }
        : thread.latestTurn;

      const settlementEvidence = withSettlementEvidence(
        { ...thread, checkpoints },
        settlesTurn ? authoritativeSettlement(latestTurn, thread.session) : null,
      );

      return {
        kind: "updated",
        thread: {
          ...thread,
          ...settlementEvidence,
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

interface TurnSettlement {
  readonly turnId: TurnId;
  readonly completedAt: string | null;
}

/**
 * Whether a session still reports `turnId` as running.
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
 * Resolve a turn's authoritative settlement.
 *
 * A terminal turn is settlement evidence only when no session still reports it
 * as running. An interrupt request marks the turn terminal immediately, but
 * until the session observes the closure that state is intent, not evidence.
 * Snapshots and live events share this decision so they cannot diverge.
 */
function authoritativeSettlement(
  turn: OrchestrationLatestTurn | null,
  session: OrchestrationSession | null,
): TurnSettlement | null {
  if (turn === null || turn.state === "running" || sessionRunsTurn(session, turn.turnId)) {
    return null;
  }
  return { turnId: turn.turnId, completedAt: turn.completedAt };
}

/**
 * Record one turn's authoritative settlement completion, including an explicit
 * `null` for an unknown completion. Settlement evidence is write-once: the
 * first authoritative settlement of a turn is never replaced by a later
 * observation, matching `docs/architecture/state-and-evidence.md`.
 */
function recordSettledTurnCompletion(
  record: SettledTurnCompletions,
  turnId: TurnId,
  completedAt: string | null,
): SettledTurnCompletions {
  return Object.hasOwn(record, turnId) ? record : { ...record, [turnId]: completedAt };
}

/**
 * Freeze a turn's authoritative settlement on the thread.
 *
 * The settlement record is the single projection of turn completion, so every
 * reducer path that observes a turn closing feeds it here. Interaction requests
 * such as `thread.turn-interrupt-requested` are intent, not evidence, and never
 * write it. A later session stop, turn start or checkpoint can therefore never
 * rewrite a completion that is already frozen, including an explicit unknown.
 * A known settlement also aligns the turn's checkpoint summary with the frozen
 * timing.
 */
function withSettlementEvidence(
  thread: OrchestrationThread,
  settlement: { readonly turnId: TurnId; readonly completedAt: string | null } | null,
): Pick<OrchestrationThread, "settledTurnCompletions" | "checkpoints"> {
  const unchanged = {
    settledTurnCompletions: thread.settledTurnCompletions,
    checkpoints: thread.checkpoints,
  };
  if (settlement === null) {
    return unchanged;
  }
  const { turnId, completedAt } = settlement;
  const settledTurnCompletions = recordSettledTurnCompletion(
    thread.settledTurnCompletions ?? {},
    turnId,
    completedAt,
  );
  if (settledTurnCompletions === thread.settledTurnCompletions) {
    return unchanged;
  }
  return {
    settledTurnCompletions,
    checkpoints:
      completedAt === null
        ? thread.checkpoints
        : thread.checkpoints.map((checkpoint) =>
            checkpoint.turnId === turnId && checkpoint.completedAt !== completedAt
              ? { ...checkpoint, completedAt }
              : checkpoint,
          ),
  };
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
 * Carry per-turn settlement evidence onto a freshly loaded thread snapshot.
 *
 * A server snapshot names at most the latest turn's authoritative completion
 * (possibly an explicit unknown), so it is the only settlement evidence a
 * snapshot supplies. Earlier settlements survive only in the client record and
 * must outlive snapshot replacement. Existing evidence wins: a snapshot or a
 * later observation never rewrites a turn that already settled.
 */
export function withSnapshotSettlementEvidence(
  thread: OrchestrationThread,
  previous: OrchestrationThread | null,
): OrchestrationThread {
  const previousRecord =
    previous !== null && previous.id === thread.id ? (previous.settledTurnCompletions ?? {}) : {};
  const incomingRecord = thread.settledTurnCompletions ?? {};
  let record: SettledTurnCompletions = { ...previousRecord, ...incomingRecord };
  const settlement = authoritativeSettlement(thread.latestTurn, thread.session);
  if (settlement !== null) {
    record = recordSettledTurnCompletion(record, settlement.turnId, settlement.completedAt);
  }
  return sameSettledTurnCompletions(record, incomingRecord)
    ? thread
    : { ...thread, settledTurnCompletions: record };
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
