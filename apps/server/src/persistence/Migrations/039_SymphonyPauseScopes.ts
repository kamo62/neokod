import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Per-workflow and per-repository pause state (plan 9.6, FR-130-134 safety
 * controls). The orchestrator state table is a single row; paused scopes are
 * stored as JSON arrays so the global row stays one row.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE symphony_orchestrator_state
    ADD COLUMN paused_workflows TEXT NOT NULL DEFAULT '[]'
  `;

  yield* sql`
    ALTER TABLE symphony_orchestrator_state
    ADD COLUMN paused_repositories TEXT NOT NULL DEFAULT '[]'
  `;
});
