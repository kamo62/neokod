import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Outbox for per-turn settlement publication.
 *
 * The durable turn projection writes one row per settled turn in the same
 * transaction that records the completion. The settlement reactor drains rows
 * with `published_at IS NULL`, so a crash between durable closure and
 * publication is repaired on the next boot without rescanning turn history.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_turn_settlements (
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      completed_at TEXT,
      published_at TEXT,
      PRIMARY KEY (thread_id, turn_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_turn_settlements_unpublished
    ON projection_turn_settlements(thread_id, turn_id)
    WHERE published_at IS NULL
  `;
});
