import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Symphony work items and workflow activation.
 *
 * `symphony_work_items` is the dispatch authority. Claiming an issue is a
 * conditional `UPDATE ... WHERE lifecycle IN ('eligible','queued','retry_scheduled')`
 * that moves it to `preparing`; at most one concurrent claimant can succeed,
 * and every subsequent state transition asserts `owner_token = ? AND generation = ?`
 * so a resurrected zombie worker cannot write. The `UNIQUE(tracker_kind,
 * tracker_issue_id)` constraint makes re-discovery idempotent.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS symphony_workflows (
      id TEXT PRIMARY KEY,
      repository_path TEXT NOT NULL UNIQUE,
      workflow_path TEXT NOT NULL,
      status TEXT NOT NULL,
      autonomy_level TEXT NOT NULL,
      definition_json TEXT NOT NULL,
      effective_config_json TEXT,
      validation_error TEXT,
      enabled_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_symphony_workflows_repository
    ON symphony_workflows(repository_path, status)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS symphony_work_items (
      id TEXT PRIMARY KEY,
      workflow_id TEXT,
      tracker_kind TEXT NOT NULL,
      tracker_issue_id TEXT NOT NULL,
      tracker_identifier TEXT,
      repository_path TEXT,
      objective TEXT NOT NULL,
      description TEXT,
      priority INTEGER,
      state TEXT,
      labels_json TEXT NOT NULL DEFAULT '[]',
      assignee_id TEXT,
      blockers_json TEXT NOT NULL DEFAULT '[]',
      branch_name TEXT,
      issue_url TEXT,
      lifecycle TEXT NOT NULL,
      workspace_key TEXT,
      workspace_path TEXT,
      base_branch TEXT,
      source_json TEXT NOT NULL,
      acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
      owner_token TEXT,
      generation INTEGER NOT NULL DEFAULT 0,
      owner_pid INTEGER,
      owner_started_at TEXT,
      lease_expires_at TEXT,
      excluded INTEGER NOT NULL DEFAULT 0,
      local_priority INTEGER,
      eligibility_reasons_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_seen_at TEXT,
      claimed_at TEXT,
      dispatch_seq INTEGER,
      UNIQUE(tracker_kind, tracker_issue_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_symphony_work_items_workflow_lifecycle
    ON symphony_work_items(workflow_id, lifecycle)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_symphony_work_items_repository_lifecycle
    ON symphony_work_items(repository_path, lifecycle)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_symphony_work_items_tracker_state
    ON symphony_work_items(tracker_kind, state)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_symphony_work_items_last_seen
    ON symphony_work_items(last_seen_at)
  `;
});
