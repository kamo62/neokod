import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Frozen accepted guidance for a Symphony attempt.
 *
 * The snapshot is written at admission and never replaced, so later edits to
 * WORKFLOW.md, tracker text, operator guidance or workflow policy affect future
 * attempts only. `NULL` means the attempt predates accepted snapshots; consumers
 * must not invent one.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE symphony_run_attempts
    ADD COLUMN accepted_guidance_json TEXT
  `;
});
