import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Durable structured questions, operator answers and approval notes.
 *
 * Questions used to be stored only as flattened prompt text, answers shared the
 * `approved` state with permission approvals, and approval/rejection notes were
 * dropped. These columns keep the original versioned question payload, the
 * submitted answer content (with redactions for provider-secret questions) and
 * history-only decision notes without reinterpretation.
 *
 * Every column is nullable: rows written before this migration stay readable as
 * legacy free text, and no choice is invented for them.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE symphony_approvals ADD COLUMN question_payload_json TEXT`;
  yield* sql`ALTER TABLE symphony_approvals ADD COLUMN answer_json TEXT`;
  yield* sql`ALTER TABLE symphony_approvals ADD COLUMN decision_note_json TEXT`;
});
