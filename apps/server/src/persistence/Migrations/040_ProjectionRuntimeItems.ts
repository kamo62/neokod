import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_runtime_items (
      runtime_item_id TEXT NOT NULL,
      provider_item_id TEXT,
      thread_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      turn_id TEXT,
      kind TEXT NOT NULL,
      scope TEXT NOT NULL,
      label TEXT NOT NULL,
      provider_state TEXT,
      synthetic_state TEXT,
      effective_state TEXT NOT NULL,
      terminal_source TEXT,
      may_still_be_running INTEGER NOT NULL DEFAULT 0,
      provider_event_id TEXT,
      synthetic_event_id TEXT,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      last_sequence INTEGER NOT NULL,
      PRIMARY KEY (thread_id, session_id, kind, runtime_item_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_runtime_items_thread_state
    ON projection_runtime_items(thread_id, session_id, effective_state, last_sequence)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_runtime_items_thread_turn
    ON projection_runtime_items(thread_id, turn_id, last_sequence)
  `;
});
