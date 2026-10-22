import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Rename the `eligible` lifecycle to `ineligible`. The old value carried two
 * meanings: it held issues that failed the eligibility rules and work items
 * that were dispatchable. Items with recorded reasons stay `ineligible`; items
 * without reasons become `queued`, which is what `eligible` originally meant.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE symphony_work_items
    SET lifecycle = CASE
      WHEN eligibility_reasons_json IN ('[]', '') THEN 'queued'
      ELSE 'ineligible'
    END
    WHERE lifecycle = 'eligible'
  `;
});
