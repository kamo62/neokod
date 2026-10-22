import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Record the effective workspace captured by a pending turn start.
 *
 * The revert guard must associate an admitted start with the folder it will
 * write to, even if the thread or its project workspace moves before the start
 * settles. Legacy pending rows keep a null path: their original workspace is
 * unknown, and the guard must refuse conservatively rather than treat the
 * current thread or project location as admission evidence.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_turns
    ADD COLUMN pending_workspace_path TEXT
  `;
});
