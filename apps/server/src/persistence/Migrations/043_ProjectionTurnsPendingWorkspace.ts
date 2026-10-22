import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Record the workspace admitted for a turn start and carry it from the pending
 * placeholder onto the concrete running turn.
 *
 * The revert guard must associate every unsettled turn with the folder it will
 * write to, even if the thread or its project workspace moves later. Legacy
 * rows keep a null path: their original workspace is unknown, and the guard
 * must refuse conservatively rather than treat mutable current locations as
 * admission evidence.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_turns
    ADD COLUMN admitted_workspace_path TEXT
  `;
});
