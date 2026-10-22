import * as Effect from "effect/Effect";

import type { ApprovalService } from "./ApprovalService.ts";
import type { AgentRuntimeDeps } from "./AgentRuntime.ts";

/**
 * Wires the runtime's request callbacks to the durable ApprovalService.
 *
 * Both the live factory and the fake-Codex harness use this so they exercise
 * the same recording and timeout behaviour: a recorded request is normalised
 * once by the repository, and a request the agent stopped waiting for is
 * expired rather than left answerable.
 */
export const approvalServiceRequestCallbacks = (
  approvals: ApprovalService["Service"],
): {
  readonly recordRequest: NonNullable<AgentRuntimeDeps["recordRequest"]>;
  readonly requestTimedOut: NonNullable<AgentRuntimeDeps["requestTimedOut"]>;
} => ({
  recordRequest: (input) =>
    approvals
      .recordPending({
        id: input.requestId,
        requestId: input.requestId,
        workItemId: input.workItemId,
        runAttemptId: input.runAttemptId,
        action: input.action,
        scope: "once",
        ...(input.command !== undefined ? { command: input.command } : {}),
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      })
      .pipe(
        Effect.asVoid,
        Effect.catch(() => Effect.void),
      ),
  requestTimedOut: (input) =>
    approvals
      .expireRequest(input.runAttemptId, input.requestId)
      .pipe(Effect.catch(() => Effect.void)),
});
