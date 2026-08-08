import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Symphony run attempts, run timeline events, and evidence bundles.
 *
 * `symphony_run_events` is append-only; its rows drive both the UI timeline
 * and the privileged-operation audit trail. `symphony_evidence` stores the
 * assembled evidence bundle keyed by work item.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS symphony_run_attempts (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL REFERENCES symphony_work_items(id),
      attempt_number INTEGER NOT NULL,
      provider TEXT NOT NULL,
      model TEXT,
      status TEXT NOT NULL,
      current_stage TEXT,
      workspace_path TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      error_json TEXT,
      token_usage_json TEXT,
      session_id TEXT,
      thread_id TEXT,
      UNIQUE(work_item_id, attempt_number)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_symphony_run_attempts_work_item
    ON symphony_run_attempts(work_item_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS symphony_run_events (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_attempt_id TEXT NOT NULL REFERENCES symphony_run_attempts(id),
      sequence INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      payload_json TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_symphony_run_events_attempt_sequence
    ON symphony_run_events(run_attempt_id, sequence)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS symphony_evidence (
      work_item_id TEXT PRIMARY KEY REFERENCES symphony_work_items(id),
      bundle_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
});
