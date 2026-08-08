import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Symphony workspace ownership.
 *
 * Cross-mode handoff prerequisite (plan section 16.0): a persisted record of
 * which mode owns a workspace, so Work-mode and Symphony-mode cleanup paths
 * cannot delete a worktree the other is using. Acquire, transfer, renew and
 * release are conditional transactions carrying the fencing `generation`.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS symphony_workspace_ownership (
      workspace_path TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      work_item_id TEXT,
      thread_id TEXT,
      generation INTEGER NOT NULL,
      lease_expires_at TEXT,
      updated_at TEXT NOT NULL
    )
  `;
});
