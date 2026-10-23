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
      // with their state and decision timestamp intact. A legacy row that used
      // the permission `approved` vocabulary for a question is projected as
      // `answered`, because a user-input request cannot be permission-approved.
      const answeredRow = rows.find((row) => row.id === answered.id);
      expect(answeredRow?.kind).toBe("user_input");
      expect(answeredRow?.state).toBe("answered");
      expect(answeredRow?.decision).toBe("answered");
      expect(answeredRow?.decidedAt).not.toBeNull();
      expect(rows.find((row) => row.id === expired.id)?.state).toBe("expired");
      expect(rows.find((row) => row.id === interrupted.id)?.state).toBe("interrupted");
      // The row's decision mirrors its state on every close; an interruption is
      // recorded too, so the contract must decode it.
      expect(rows.find((row) => row.id === interrupted.id)?.decision).toBe("interrupted");
      expect(rows.find((row) => row.id === interrupted.id)?.action).toBe("command_execution");
    }),
  );

  it.effect("round-trips the versioned question payload and the answer record", () =>
    Effect.gen(function* () {
      yield* seedWorkItem("wi-structured-1");
      const repository = yield* ApprovalRepository;
      const created = yield* repository.create({
        id: SymphonyApprovalRequestId.make("sym-structured-1"),
        requestId: "20",
        workItemId: WorkItemId.make("wi-structured-1"),
        runAttemptId,
        action: "user_input",
        scope: "once",
        reason: "Which branch? / Which checks?",
        questionPayload: {
          kind: "structured",
          version: 1,
          questions: [
            {
              id: "q1",
              header: "Branch",
              question: "Which branch?",
              options: [{ label: "main", description: "default" }],
            },
            {
              id: "q2",
              header: "Checks",
              question: "Which checks?",
              options: [
                { label: "unit", description: "unit tests" },
                { label: "lint", description: "lint" },
              ],
              multiSelect: true,
            },
          ],
        },
      });
      expect(created.questionPayload).toMatchObject({ kind: "structured", version: 1 });

      yield* repository.decide(created.id, "answered", {
        answer: {
          answers: [
            { questionId: "q1", answer: "main" },
            { questionId: "q2", answer: ["unit", "lint"] },
          ],
          delivery: "unknown",
          actor: "local_operator",
          recordedAt: "2026-08-05T00:00:01.000Z",
        },
        decisionNote: {
          text: "checked locally",
          delivery: "history_only",
          actor: "local_operator",
          recordedAt: "2026-08-05T00:00:02.000Z",
        },
      });

      const reloaded = yield* repository.getById(created.id);
      expect(reloaded?.state).toBe("answered");
      expect(reloaded?.questionPayload).toMatchObject({ kind: "structured" });
      if (reloaded?.questionPayload?.kind !== "structured") {
        throw new Error("expected a structured payload after reload");
      }
      expect(reloaded.questionPayload.questions[1]?.multiSelect).toBe(true);
      expect(reloaded.answer?.answers).toEqual([
        { questionId: "q1", answer: "main" },
        { questionId: "q2", answer: ["unit", "lint"] },
      ]);
      expect(reloaded.answer?.delivery).toBe("unknown");
      expect(reloaded.decisionNote?.delivery).toBe("history_only");
    }),
  );

  it.effect("decodes a pre-question row as legacy free text without invented choices", () =>
    Effect.gen(function* () {
      yield* seedWorkItem("wi-legacy-question-1");
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* ApprovalRepository;
      yield* sql`
        INSERT INTO symphony_approvals (
          id, request_id, work_item_id, run_attempt_id, action, scope,
          state, decision, policy_source, payload_json, created_at, decided_at
        )
        VALUES (
          'sym-legacy-question-1', '21', 'wi-legacy-question-1', ${runAttemptId},
          'user_input', 'once', 'approved', 'approved', 'once',
          ${encodeJson({ reason: "Which branch?" })},
          '2026-08-05T00:00:00.000Z', '2026-08-05T00:00:05.000Z'
        )
      `;

      const decoded = yield* repository.getById("sym-legacy-question-1");
      expect(decoded?.questionPayload).toEqual({ kind: "legacy_text", text: "Which branch?" });
      expect(decoded?.state).toBe("answered");
      expect(decoded?.decision).toBe("answered");
      // No answer content is invented for a row that never stored one.
      expect(decoded?.answer).toBeUndefined();
    }),
  );

  it.effect(
    "keeps empty option descriptions decodable and degrades malformed payload JSON honestly",
    () =>
      Effect.gen(function* () {
        yield* seedWorkItem("wi-question-robust");
        const sql = yield* SqlClient.SqlClient;
        const repository = yield* ApprovalRepository;
        const created = yield* repository.create({
          id: SymphonyApprovalRequestId.make("sym-question-robust"),
          requestId: "30",
          workItemId: WorkItemId.make("wi-question-robust"),
          runAttemptId,
          action: "user_input",
          scope: "once",
          questionPayload: {
            kind: "structured",
            version: 1,
            questions: [
              {
                id: "q1",
                header: "Branch",
                question: "Which branch?",
                options: [{ label: "main", description: "" }],
              },
            ],
          },
        });
        expect(created.questionPayload).toMatchObject({ kind: "structured" });

        // A row written by a partial/bad payload must not fail the whole list.
        yield* sql`
        INSERT INTO symphony_approvals (
          id, request_id, work_item_id, run_attempt_id, action, scope,
          state, policy_source, payload_json, question_payload_json, created_at
        )
        VALUES (
          'sym-question-malformed', '31', 'wi-question-robust', ${runAttemptId},
          'user_input', 'once', 'pending', 'once',
          ${encodeJson({ reason: "broken question" })},
          '{"kind":"structured","version":1,"questions":[{"id":""}]}',
          '2026-08-05T00:00:00.000Z'
        )
      `;

        const rows = yield* repository.listForRun(runAttemptId);
        expect(rows.map((row) => String(row.id))).toContain("sym-question-robust");
        const malformed = rows.find((row) => String(row.id) === "sym-question-malformed");
        expect(malformed?.questionPayload).toMatchObject({
          kind: "unsupported",
          providerMethod: "item/tool/requestUserInput",
        });
        // The valid question survives unchanged, so one bad row cannot hide it.
        expect(
          rows.find((row) => String(row.id) === "sym-question-robust")?.questionPayload,
        ).toMatchObject({ kind: "structured" });
        expect((yield* repository.listPending()).map((row) => String(row.id))).toEqual(
          expect.arrayContaining(["sym-question-robust", "sym-question-malformed"]),
        );
      }),
  );

  it.effect("degrades one malformed answer/note row without hiding the valid row", () =>
    Effect.gen(function* () {
      yield* seedWorkItem("wi-history-robust");
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* ApprovalRepository;
      const valid = yield* record({
        id: "sym-history-valid",
        requestId: "40",
        action: "user_input",
        workItemId: "wi-history-robust",
      });
      yield* sql`
        INSERT INTO symphony_approvals (
          id, request_id, work_item_id, run_attempt_id, action, scope,
          state, policy_source, payload_json, answer_json, decision_note_json, created_at
        )
        VALUES (
          'sym-history-bad-answer', '41', 'wi-history-robust', ${runAttemptId},
          'user_input', 'once', 'pending', 'once',
          ${encodeJson({ reason: "Which branch?" })},
          'not-json', '{bad}', '2026-08-05T00:00:00.000Z'
        )
      `;
      const rows = yield* repository.listForRun(runAttemptId);
      expect(rows.map((row) => String(row.id))).toContain(String(valid.id));
      const bad = rows.find((row) => String(row.id) === "sym-history-bad-answer");
      expect(bad?.historyUnavailable).toContain("answer");
      expect(bad?.historyUnavailable).toContain("decision note");
      expect(bad?.answer).toBeUndefined();
      expect(bad?.decisionNote).toBeUndefined();
      expect(rows.find((row) => row.id === valid.id)?.questionPayload).toBeDefined();
    }),
  );

  it.effect("keeps a redelivered provider request as one durable row", () =>
    Effect.gen(function* () {
      yield* seedWorkItem("wi-duplicate-1");
      const repository = yield* ApprovalRepository;
      const input = {
        id: SymphonyApprovalRequestId.make("sym-duplicate-1"),
        requestId: "22",
        workItemId: WorkItemId.make("wi-duplicate-1"),
        runAttemptId,
        action: "command_execution",
        scope: "once",
        reason: "first delivery",
      } as const;
      const first = yield* repository.create(input);
      const second = yield* repository.create({ ...input, reason: "redelivered" });
      expect(second.createdAt).toBe(first.createdAt);
      expect(second.reason).toBe("first delivery");
      const rows = yield* repository.listForRun(runAttemptId);
      expect(rows.filter((row) => row.id === first.id)).toHaveLength(1);
    }),
  );
});
