import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Proven process identity for a claimed Symphony work item.
 *
 * `owner_pid` already existed. Recovery additionally needs the process-group id
 * captured at a detached spawn and a recycle-resistant birth token; neither can
 * be reconstructed from a bare pid, so a legacy row keeps `NULL` and recovery
 * must fail closed rather than infer identity.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE symphony_work_items ADD COLUMN owner_pgid INTEGER`;
  yield* sql`ALTER TABLE symphony_work_items ADD COLUMN owner_birth_token TEXT`;
});
