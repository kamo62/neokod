import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Database-backed Symphony projects and project-scoped work-item identity.
 *
 * Legacy workflow ids are retained as project ids so existing work items,
 * runs, evidence, and attention rows keep their identity without repository
 * file writes. Every migrated project starts paused.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS symphony_projects (
      id TEXT PRIMARY KEY,
      code_project_id TEXT UNIQUE,
      title TEXT NOT NULL,
      repository_path TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      setup_state TEXT NOT NULL,
      configuration_json TEXT,
      legacy_config_json TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      legacy_workflow_id TEXT UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    INSERT INTO symphony_projects (
      id, code_project_id, title, repository_path, status, setup_state,
      configuration_json, legacy_config_json, revision, legacy_workflow_id,
      created_at, updated_at
    )
    SELECT
      workflow.id,
      project.project_id,
      COALESCE(project.title, workflow.repository_path),
      workflow.repository_path,
      'paused',
      CASE
        WHEN project.project_id IS NOT NULL AND workflow.effective_config_json IS NOT NULL
          THEN 'ready'
        ELSE 'needs_setup'
      END,
      NULL,
      workflow.effective_config_json,
      0,
      workflow.id,
      workflow.created_at,
      workflow.updated_at
    FROM symphony_workflows AS workflow
    LEFT JOIN projection_projects AS project
      ON project.workspace_root = workflow.repository_path
      AND project.deleted_at IS NULL
    ON CONFLICT(id) DO NOTHING
  `;

  // Keep dependent rows while replacing the table-level global uniqueness
  // constraint. Renaming first lets SQLite preserve the old FK graph until
  // the new graph has been populated.
  yield* sql`ALTER TABLE symphony_run_events RENAME TO symphony_run_events_legacy`;
  yield* sql`ALTER TABLE symphony_evidence RENAME TO symphony_evidence_legacy`;
  yield* sql`ALTER TABLE symphony_attention_items RENAME TO symphony_attention_items_legacy`;
  yield* sql`ALTER TABLE symphony_approvals RENAME TO symphony_approvals_legacy`;
  yield* sql`ALTER TABLE symphony_retry_queue RENAME TO symphony_retry_queue_legacy`;
  yield* sql`ALTER TABLE symphony_run_attempts RENAME TO symphony_run_attempts_legacy`;
  yield* sql`ALTER TABLE symphony_work_items RENAME TO symphony_work_items_legacy`;

  yield* sql`
    CREATE TABLE symphony_work_items (
      id TEXT PRIMARY KEY,
      project_id TEXT,
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
      UNIQUE(project_id, tracker_kind, tracker_issue_id)
    )
  `;

  yield* sql`
    INSERT INTO symphony_work_items (
      id, project_id, workflow_id, tracker_kind, tracker_issue_id,
      tracker_identifier, repository_path, objective, description, priority,
      state, labels_json, assignee_id, blockers_json, branch_name, issue_url,
      lifecycle, workspace_key, workspace_path, base_branch, source_json,
      acceptance_criteria_json, owner_token, generation, owner_pid,
      owner_started_at, lease_expires_at, excluded, local_priority,
      eligibility_reasons_json, created_at, updated_at, last_seen_at,
      claimed_at, dispatch_seq
    )
    SELECT
      item.id,
      COALESCE(item.workflow_id, project.id),
      item.workflow_id,
      item.tracker_kind,
      item.tracker_issue_id,
      item.tracker_identifier,
      item.repository_path,
      item.objective,
      item.description,
      item.priority,
      item.state,
      item.labels_json,
      item.assignee_id,
      item.blockers_json,
      item.branch_name,
      item.issue_url,
      item.lifecycle,
      item.workspace_key,
      item.workspace_path,
      item.base_branch,
      item.source_json,
      item.acceptance_criteria_json,
      item.owner_token,
      item.generation,
      item.owner_pid,
      item.owner_started_at,
      item.lease_expires_at,
      item.excluded,
      item.local_priority,
      item.eligibility_reasons_json,
      item.created_at,
      item.updated_at,
      item.last_seen_at,
      item.claimed_at,
      item.dispatch_seq
    FROM symphony_work_items_legacy AS item
    LEFT JOIN symphony_projects AS project
      ON project.repository_path = item.repository_path
  `;

  yield* sql`
    CREATE TABLE symphony_run_attempts (
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
  yield* sql`INSERT INTO symphony_run_attempts SELECT * FROM symphony_run_attempts_legacy`;

  yield* sql`
    CREATE TABLE symphony_run_events (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_attempt_id TEXT NOT NULL REFERENCES symphony_run_attempts(id),
      sequence INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      payload_json TEXT
    )
  `;
  yield* sql`INSERT INTO symphony_run_events SELECT * FROM symphony_run_events_legacy`;

  yield* sql`
    CREATE TABLE symphony_evidence (
      work_item_id TEXT PRIMARY KEY REFERENCES symphony_work_items(id),
      bundle_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`INSERT INTO symphony_evidence SELECT * FROM symphony_evidence_legacy`;

  yield* sql`
    CREATE TABLE symphony_attention_items (
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
  yield* sql`INSERT INTO symphony_attention_items SELECT * FROM symphony_attention_items_legacy`;

  yield* sql`
    CREATE TABLE symphony_approvals (
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
  yield* sql`INSERT INTO symphony_approvals SELECT * FROM symphony_approvals_legacy`;

  yield* sql`
    CREATE TABLE symphony_retry_queue (
      work_item_id TEXT PRIMARY KEY REFERENCES symphony_work_items(id),
      attempt INTEGER NOT NULL,
      due_at_ms INTEGER NOT NULL,
      error_json TEXT,
      scheduled TEXT NOT NULL
    )
  `;
  yield* sql`INSERT INTO symphony_retry_queue SELECT * FROM symphony_retry_queue_legacy`;

  yield* sql`DROP TABLE symphony_run_events_legacy`;
  yield* sql`DROP TABLE symphony_evidence_legacy`;
  yield* sql`DROP TABLE symphony_attention_items_legacy`;
  yield* sql`DROP TABLE symphony_approvals_legacy`;
  yield* sql`DROP TABLE symphony_retry_queue_legacy`;
  yield* sql`DROP TABLE symphony_run_attempts_legacy`;
  yield* sql`DROP TABLE symphony_work_items_legacy`;

  yield* sql`
    CREATE INDEX idx_symphony_work_items_project_lifecycle
    ON symphony_work_items(project_id, lifecycle)
  `;
  yield* sql`
    CREATE INDEX idx_symphony_work_items_workflow_lifecycle
    ON symphony_work_items(workflow_id, lifecycle)
  `;
  yield* sql`
    CREATE INDEX idx_symphony_work_items_repository_lifecycle
    ON symphony_work_items(repository_path, lifecycle)
  `;
  yield* sql`
    CREATE INDEX idx_symphony_work_items_tracker_state
    ON symphony_work_items(tracker_kind, state)
  `;
  yield* sql`
    CREATE INDEX idx_symphony_work_items_last_seen
    ON symphony_work_items(last_seen_at)
  `;
  yield* sql`
    CREATE INDEX idx_symphony_run_attempts_work_item
    ON symphony_run_attempts(work_item_id)
  `;
  yield* sql`
    CREATE INDEX idx_symphony_run_events_attempt_sequence
    ON symphony_run_events(run_attempt_id, sequence)
  `;
  yield* sql`
    CREATE INDEX idx_symphony_attention_state_created
    ON symphony_attention_items(state, created_at)
  `;
});
