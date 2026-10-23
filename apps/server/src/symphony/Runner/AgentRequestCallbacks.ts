import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ApprovalQuestionPayloadSchema } from "@neokod/contracts";

import type { ApprovalService } from "./ApprovalService.ts";
import type { AgentRuntimeDeps } from "./AgentRuntime.ts";

const decodeQuestionPayload = Schema.decodeUnknownOption(ApprovalQuestionPayloadSchema);

const canonicalQuestionPayload = (payload: unknown): string => {
  const decoded = decodeQuestionPayload(payload);
  return JSON.stringify(Option.isSome(decoded) ? decoded.value : payload);
};

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
  readonly requestSettled: NonNullable<AgentRuntimeDeps["requestSettled"]>;
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
        ...(input.questionPayload !== undefined ? { questionPayload: input.questionPayload } : {}),
      })
      .pipe(
        Effect.map((request) => {
          if (request.state !== "pending") {
            return { status: "duplicate_decided" as const };
          }
          const samePayload =
            request.reason === input.reason &&
            request.command === input.command &&
            (request.action === input.action || request.providerAction === input.action) &&
            canonicalQuestionPayload(request.questionPayload) ===
              canonicalQuestionPayload(input.questionPayload);
          return samePayload
            ? { status: "recorded" as const }
            : { status: "duplicate_mismatched" as const };
        }),
        Effect.tapError((cause) =>
          Effect.logWarning("symphony.agent.request_record_failed", {
            requestId: input.requestId,
            cause,
          }),
        ),
        Effect.catch(() => Effect.succeed({ status: "record_failed" as const })),
      ),
  // True only when the timeout won the live claim; a human answer that won
  // first makes the runtime send that answer instead of its fallback.
  requestTimedOut: (input) => approvals.expireRequest(input.runAttemptId, input.requestId),
  requestSettled: (input) =>
    approvals.listForRun(input.runAttemptId).pipe(
      Effect.flatMap((rows) => {
        const row = rows.find(
          (candidate) => candidate.requestId === input.requestId && candidate.state === "pending",
        );
        return row === undefined ? Effect.void : approvals.interrupt(row.id);
      }),
      Effect.catch(() => Effect.void),
    ),
});
