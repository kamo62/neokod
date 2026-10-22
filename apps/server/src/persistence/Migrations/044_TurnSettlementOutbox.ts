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
 * The same migration repairs turn projections written before settlement became
 * server-owned. The previous projector stored an interrupt *request* time as a
 * turn's completion, so a legacy `interrupted` completion that matches an
 * interrupt-request event is replaced with the server-observed closure when the
 * event log has one, and with explicit unknown (`NULL`) otherwise.
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

  // Recover the completion the current projector would have written: the first
  // session update after the request that leaves the running status settles the
  // turn, using `latestTurnCompletedAt` when present (including an explicit
  // null) or the session update time otherwise. With no such evidence the
  // request time is dropped and the completion stays explicitly unknown.
  yield* sql`
    UPDATE projection_turns AS turn
    SET completed_at = (
      SELECT CASE
        WHEN json_type(closure.payload_json, '$.latestTurnCompletedAt') IS NOT NULL
          THEN json_extract(closure.payload_json, '$.latestTurnCompletedAt')
        ELSE json_extract(closure.payload_json, '$.session.updatedAt')
      END
      FROM orchestration_events AS request
      INNER JOIN orchestration_events AS closure
        ON closure.sequence > request.sequence
       AND closure.event_type = 'thread.session-set'
       AND json_extract(closure.payload_json, '$.threadId') = turn.thread_id
      WHERE request.event_type = 'thread.turn-interrupt-requested'
        AND json_extract(request.payload_json, '$.threadId') = turn.thread_id
        AND json_extract(request.payload_json, '$.turnId') = turn.turn_id
        AND json_extract(request.payload_json, '$.createdAt') = turn.completed_at
        AND json_extract(closure.payload_json, '$.session.status') NOT IN (
          'running',
          'starting'
        )
      ORDER BY closure.sequence ASC
      LIMIT 1
    )
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
