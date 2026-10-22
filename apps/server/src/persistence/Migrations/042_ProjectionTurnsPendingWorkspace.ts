import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Record the effective workspace captured by a pending turn start.
 *
 * The revert guard must associate an admitted start with the folder it will
 * write to, even if the thread or its project workspace moves before the start
 * settles. Existing pending rows keep a null path and are treated
 * conservatively by the guard.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_turns
    ADD COLUMN pending_workspace_path TEXT
  `;

  yield* sql`
    UPDATE projection_turns
    SET pending_workspace_path = (
      SELECT COALESCE(threads.worktree_path, projects.workspace_root)
      FROM projection_threads AS threads
      JOIN projection_projects AS projects
        ON projects.project_id = threads.project_id
      WHERE threads.thread_id = projection_turns.thread_id
    )
    WHERE turn_id IS NULL
      AND state = 'pending'
      AND checkpoint_turn_count IS NULL
      AND pending_workspace_path IS NULL
  `;
});
