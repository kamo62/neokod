import {
  RunAttemptId,
  SymphonyApprovalRequestId,
  SymphonyProjectId,
  WorkItemId,
} from "@neokod/contracts";
import { expect, it } from "@effect/vitest";
import { Schema } from "effect";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { nowIso } from "../../Domain/Time.ts";
import { SymphonyPersistenceDecodeError } from "../Errors.ts";
import { encodeJson } from "../Json.ts";
import { ApprovalRepository } from "../Services/ApprovalRepository.ts";
import { WorkItemRepository } from "../Services/WorkItemRepository.ts";
import { WorkItemRepositoryLive } from "./WorkItemRepository.ts";
import { ApprovalRepositoryLive } from "./ApprovalRepository.ts";

const layer = it.layer(
  ApprovalRepositoryLive.pipe(
    Layer.provideMerge(WorkItemRepositoryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

const runAttemptId = RunAttemptId.make("run-approvals-1");

const seedWorkItem = (id: string) =>
  Effect.gen(function* () {
    const workItems = yield* WorkItemRepository;
    const now = yield* nowIso;
    yield* workItems.upsert({
      id: WorkItemId.make(id),
      mode: "symphony",
      projectId: SymphonyProjectId.make("approval-repository-project"),
      objective: `Seed ${id}`,
      acceptanceCriteria: [],
      source: { kind: "manual" },
      trackerIssueId: id,
      lifecycle: "running",
      priority: 1,
      eligibilityReasons: [],
      evidence: null,
      createdAt: now,
      updatedAt: now,
    });
  });

const record = (overrides: {
  readonly id: string;
  readonly requestId: string;
  readonly action: string;
  readonly workItemId: string;
}) =>
  Effect.gen(function* () {
    const repository = yield* ApprovalRepository;
    return yield* repository.create({
      id: SymphonyApprovalRequestId.make(overrides.id),
      requestId: overrides.requestId,
      workItemId: WorkItemId.make(overrides.workItemId),
      runAttemptId,
      action: overrides.action,
      scope: "once",
    });
  });

layer("ApprovalRepository request vocabulary", (it) => {
  it.effect("normalises provider actions and records the request kind", () =>
    Effect.gen(function* () {
      yield* seedWorkItem("wi-command-1");
      yield* seedWorkItem("wi-file-1");
      yield* seedWorkItem("wi-question-1");
      yield* seedWorkItem("wi-unknown-1");
      const command = yield* record({
        id: "sym-command-1",
        requestId: "1",
        action: "commandExecution",
        workItemId: "wi-command-1",
      });
      expect(command.kind).toBe("approval");
      expect(command.action).toBe("command_execution");
      expect(command.providerAction).toBe("commandExecution");

      const fileChange = yield* record({
        id: "sym-file-1",
        requestId: "2",
        action: "fileChange",
        workItemId: "wi-file-1",
      });
      expect(fileChange.kind).toBe("approval");
      expect(fileChange.action).toBe("file_change");
      expect(fileChange.providerAction).toBe("fileChange");

      const question = yield* record({
        id: "sym-question-1",
        requestId: "3",
        action: "user_input",
        workItemId: "wi-question-1",
      });
      expect(question.kind).toBe("user_input");
      expect(question.action).toBe("user_input");
      expect(question.providerAction).toBeUndefined();

      const unknown = yield* record({
        id: "sym-unknown-1",
        requestId: "4",
        action: "somethingNew",
        workItemId: "wi-unknown-1",
      });
      // Drift is recorded as unknown, never guessed into a policy class.
      expect(unknown.kind).toBe("approval");
      expect(unknown.action).toBe("unknown");
      expect(unknown.providerAction).toBe("somethingNew");
    }),
  );

  it.effect("decodes legacy rows that stored the raw provider action and no kind", () =>
    Effect.gen(function* () {
      yield* seedWorkItem("wi-legacy-1");
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* ApprovalRepository;
      yield* sql`
        INSERT INTO symphony_approvals (
          id, request_id, work_item_id, run_attempt_id, action, scope,
          state, policy_source, payload_json, created_at
        )
        VALUES (
          'sym-legacy-1', '7', 'wi-legacy-1', ${RunAttemptId.make("run-legacy-1")},
          'fileChange', 'once', 'pending', 'once', ${encodeJson({ reason: "old row" })},
          '2026-08-05T00:00:00.000Z'
        )
      `;

      const decoded = yield* repository.getById("sym-legacy-1");
      expect(decoded?.kind).toBe("approval");
      expect(decoded?.action).toBe("file_change");
      expect(decoded?.providerAction).toBe("fileChange");
      expect(decoded?.reason).toBe("old row");
    }),
  );

  it.effect("fails a malformed row as a named decode error", () =>
    Effect.gen(function* () {
      yield* seedWorkItem("wi-malformed-1");
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* ApprovalRepository;
      yield* sql`
        INSERT INTO symphony_approvals (
          id, request_id, work_item_id, run_attempt_id, action, scope,
          state, policy_source, payload_json, created_at
        )
        VALUES (
          'sym-malformed-1', '8', 'wi-malformed-1', NULL,
          'commandExecution', 'once', 'not-a-state', 'once', NULL,
          '2026-08-05T00:00:00.000Z'
        )
      `;

      const failure = yield* Effect.flip(repository.getById("sym-malformed-1"));
      if (!Schema.is(SymphonyPersistenceDecodeError)(failure)) {
        throw new Error(`expected a named decode error, got ${String(failure)}`);
      }
      expect(failure.operation).toBe("ApprovalRepository.rowToApproval");
      expect(failure.issue).toContain("sym-malformed-1");
    }),
  );

  it.effect("keeps decided history on the per-run list", () =>
    Effect.gen(function* () {
      yield* seedWorkItem("wi-history-1");
      const repository = yield* ApprovalRepository;
      const pending = yield* record({
        id: "sym-history-1",
        requestId: "11",
        action: "command_execution",
        workItemId: "wi-history-1",
      });
      const answered = yield* record({
        id: "sym-history-2",
        requestId: "12",
        action: "user_input",
        workItemId: "wi-history-1",
      });
      const expired = yield* record({
        id: "sym-history-3",
        requestId: "13",
        action: "user_input",
        workItemId: "wi-history-1",
      });
      const interrupted = yield* record({
        id: "sym-history-4",
        requestId: "14",
        action: "commandExecution",
        workItemId: "wi-history-1",
      });
      yield* repository.decide(answered.id, "approved");
      yield* repository.decide(expired.id, "expired");
      yield* repository.decide(interrupted.id, "interrupted");

      const rows = yield* repository.listForRun(runAttemptId);
      const ids = rows.map((row) => String(row.id));
      expect(ids).toContain(String(pending.id));
      expect(ids).toContain(String(answered.id));
      expect(ids).toContain(String(expired.id));
      expect(ids).toContain(String(interrupted.id));
      // Questions survive as questions after they are answered or timed out,
      // with their state and decision timestamp intact.
      const answeredRow = rows.find((row) => row.id === answered.id);
      expect(answeredRow?.kind).toBe("user_input");
      expect(answeredRow?.state).toBe("approved");
      expect(answeredRow?.decidedAt).not.toBeNull();
      expect(rows.find((row) => row.id === expired.id)?.state).toBe("expired");
      expect(rows.find((row) => row.id === interrupted.id)?.state).toBe("interrupted");
      // The row's decision mirrors its state on every close; an interruption is
      // recorded too, so the contract must decode it.
      expect(rows.find((row) => row.id === interrupted.id)?.decision).toBe("interrupted");
      expect(rows.find((row) => row.id === interrupted.id)?.action).toBe("command_execution");
    }),
  );
});
