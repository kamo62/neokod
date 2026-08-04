import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Symphony attention queue, approvals, retry queue, tracker checkpoints,
 * audit log, and orchestrator state.
 *
 * `symphony_orchestrator_state` is a single-row table holding the global
 * pause flag plus the advisory orchestrator lock (one server process holds it
 * at a time; the lease is reclaimable when it expires).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS symphony_attention_items (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL REFERENCES symphony_work_items(id),
      run_attempt_id TEXT,
      kind TEXT NOT NULL,
      severity TEXT NOT NULL,
      state TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      recommended_action TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      resolution TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_symphony_attention_state_created
    ON symphony_attention_items(state, created_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS symphony_approvals (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      work_item_id TEXT NOT NULL REFERENCES symphony_work_items(id),
      run_attempt_id TEXT,
      action TEXT NOT NULL,
      scope TEXT NOT NULL,
      state TEXT NOT NULL,
      decision TEXT,
      policy_source TEXT,
      payload_json TEXT,
      created_at TEXT NOT NULL,
      decided_at TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS symphony_retry_queue (
      work_item_id TEXT PRIMARY KEY REFERENCES symphony_work_items(id),
      attempt INTEGER NOT NULL,
      due_at_ms INTEGER NOT NULL,
      error_json TEXT,
      scheduled TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS symphony_tracker_checkpoints (
      tracker_kind TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      last_poll_at TEXT NOT NULL,
      cursor_json TEXT,
      PRIMARY KEY(tracker_kind, scope_key)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS symphony_audit_events (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      occurred_at TEXT NOT NULL,
      actor TEXT NOT NULL,
      event_type TEXT NOT NULL,
      work_item_id TEXT,
      run_attempt_id TEXT,
      payload_json TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_symphony_audit_events_occurred
    ON symphony_audit_events(occurred_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS symphony_orchestrator_state (
      id TEXT PRIMARY KEY,
      global_paused INTEGER NOT NULL DEFAULT 0,
      lock_token TEXT,
      lock_acquired_at TEXT,
      lock_expires_at TEXT,
      updated_at TEXT NOT NULL
    )
  `;
});
