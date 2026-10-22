import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Outbox for per-turn settlement publication.
 *
 * The durable turn projection writes one row per settled turn in the same
 * transaction that records the completion. The settlement reactor drains rows
 * with `published_at IS NULL`, so a crash between durable closure and
 * publication is repaired on the next boot without rescanning turn history.
 *
 * The same migration clears turn completions written before settlement became
 * server-owned. The previous projector stored an interrupt *request* time as a
 * turn's completion; that value is not closure evidence, so it is replaced with
 * explicit unknown (`NULL`). Startup reconciliation then recovers an
 * inconsistent running session through the existing host-loss path.
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

  // Drop every completion that was copied from an interrupt request. The
  // request is intent, not closure evidence, and a later session event cannot
  // be attributed to this turn without risking another turn's closure.
  yield* sql`
    UPDATE projection_turns AS turn
    SET completed_at = NULL
    WHERE turn.state = 'interrupted'
      AND turn.completed_at IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM orchestration_events AS request
        WHERE request.event_type = 'thread.turn-interrupt-requested'
          AND json_extract(request.payload_json, '$.threadId') = turn.thread_id
          AND json_extract(request.payload_json, '$.turnId') = turn.turn_id
          AND json_extract(request.payload_json, '$.createdAt') = turn.completed_at
      )
  `;
});
