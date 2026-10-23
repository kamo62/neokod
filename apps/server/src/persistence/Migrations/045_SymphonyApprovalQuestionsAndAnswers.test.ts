import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("045_SymphonyApprovalQuestionsAndAnswers", (it) => {
  it.effect("adds nullable question, answer and note columns without rewriting legacy rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 44 });

      yield* sql`
        INSERT INTO symphony_work_items (
          id, project_id, tracker_kind, tracker_issue_id, objective, lifecycle,
          source_json, created_at, updated_at
        ) VALUES (
          'item-legacy', 'project-1', 'github', '1', 'Legacy request', 'running',
          '{"kind":"manual"}', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO symphony_approvals (
          id, request_id, work_item_id, run_attempt_id, action, scope,
          state, policy_source, payload_json, created_at
        ) VALUES (
          'sym-legacy-question', '7', 'item-legacy', 'run-legacy-1',
          'user_input', 'once', 'pending', 'once', '{"reason":"Which branch?"}',
          '2026-10-01T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 45 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(symphony_approvals)
      `;
      assert.deepStrictEqual(
        columns.map((column) => column.name).filter((name) => name.endsWith("_json")),
        ["payload_json", "question_payload_json", "answer_json", "decision_note_json"],
      );

      const rows = yield* sql<{
        readonly questionPayloadJson: string | null;
        readonly answerJson: string | null;
        readonly decisionNoteJson: string | null;
      }>`
        SELECT
          question_payload_json AS "questionPayloadJson",
          answer_json AS "answerJson",
          decision_note_json AS "decisionNoteJson"
        FROM symphony_approvals
        WHERE id = 'sym-legacy-question'
      `;
      // The migration does not invent a question shape or an answer.
      assert.deepStrictEqual(rows, [
        { questionPayloadJson: null, answerJson: null, decisionNoteJson: null },
      ]);
    }),
  );
});
