import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  GetProjectionRuntimeItemInput,
  ListProjectionRuntimeItemsInput,
  ProjectionRuntimeItemRepository,
  type ProjectionRuntimeItemRepositoryShape,
} from "../Services/ProjectionRuntimeItems.ts";
import { OrchestrationRuntimeItem } from "@neokod/contracts";

const ProjectionRuntimeItemDbRow = OrchestrationRuntimeItem.mapFields(
  Struct.assign({ mayStillBeRunning: Schema.Number }),
);
type ProjectionRuntimeItemDbRow = typeof ProjectionRuntimeItemDbRow.Type;

function toRuntimeItem(row: ProjectionRuntimeItemDbRow): OrchestrationRuntimeItem {
  return {
    ...row,
    mayStillBeRunning: row.mayStillBeRunning === 1,
  };
}

const makeProjectionRuntimeItemRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRow = SqlSchema.void({
    Request: OrchestrationRuntimeItem,
    execute: (row) => sql`
      INSERT INTO projection_runtime_items (
        runtime_item_id, provider_item_id, thread_id, session_id, turn_id, kind, scope, label,
        provider_state, synthetic_state, effective_state, terminal_source,
        may_still_be_running, provider_event_id, synthetic_event_id,
        started_at, updated_at, completed_at, last_sequence
      ) VALUES (
        ${row.runtimeItemId}, ${row.providerItemId}, ${row.threadId}, ${row.sessionId},
        ${row.turnId}, ${row.kind},
        ${row.scope}, ${row.label}, ${row.providerState}, ${row.syntheticState},
        ${row.effectiveState}, ${row.terminalSource}, ${row.mayStillBeRunning ? 1 : 0},
        ${row.providerEventId}, ${row.syntheticEventId}, ${row.startedAt}, ${row.updatedAt},
        ${row.completedAt}, ${row.lastSequence}
      )
      ON CONFLICT (thread_id, session_id, kind, runtime_item_id) DO UPDATE SET
        provider_item_id = excluded.provider_item_id,
        turn_id = excluded.turn_id,
        kind = excluded.kind,
        scope = excluded.scope,
        label = excluded.label,
        provider_state = excluded.provider_state,
        synthetic_state = excluded.synthetic_state,
        effective_state = excluded.effective_state,
        terminal_source = excluded.terminal_source,
        may_still_be_running = excluded.may_still_be_running,
        provider_event_id = excluded.provider_event_id,
        synthetic_event_id = excluded.synthetic_event_id,
        started_at = excluded.started_at,
        updated_at = excluded.updated_at,
        completed_at = excluded.completed_at,
        last_sequence = excluded.last_sequence
    `,
  });

  const getRow = SqlSchema.findOneOption({
    Request: GetProjectionRuntimeItemInput,
    Result: ProjectionRuntimeItemDbRow,
    execute: ({ threadId, sessionId, kind, runtimeItemId }) => sql`
      SELECT
        runtime_item_id AS "runtimeItemId",
        provider_item_id AS "providerItemId",
        thread_id AS "threadId",
        session_id AS "sessionId",
        turn_id AS "turnId",
        kind,
        scope,
        label,
        provider_state AS "providerState",
        synthetic_state AS "syntheticState",
        effective_state AS "effectiveState",
        terminal_source AS "terminalSource",
        may_still_be_running AS "mayStillBeRunning",
        provider_event_id AS "providerEventId",
        synthetic_event_id AS "syntheticEventId",
        started_at AS "startedAt",
        updated_at AS "updatedAt",
        completed_at AS "completedAt",
        last_sequence AS "lastSequence"
      FROM projection_runtime_items
      WHERE thread_id = ${threadId}
        AND session_id = ${sessionId}
        AND kind = ${kind}
        AND runtime_item_id = ${runtimeItemId}
    `,
  });

  const listRows = SqlSchema.findAll({
    Request: ListProjectionRuntimeItemsInput,
    Result: ProjectionRuntimeItemDbRow,
    execute: ({ threadId }) => sql`
      SELECT
        runtime_item_id AS "runtimeItemId",
        provider_item_id AS "providerItemId",
        thread_id AS "threadId",
        session_id AS "sessionId",
        turn_id AS "turnId",
        kind,
        scope,
        label,
        provider_state AS "providerState",
        synthetic_state AS "syntheticState",
        effective_state AS "effectiveState",
        terminal_source AS "terminalSource",
        may_still_be_running AS "mayStillBeRunning",
        provider_event_id AS "providerEventId",
        synthetic_event_id AS "syntheticEventId",
        started_at AS "startedAt",
        updated_at AS "updatedAt",
        completed_at AS "completedAt",
        last_sequence AS "lastSequence"
      FROM projection_runtime_items
      WHERE thread_id = ${threadId}
      ORDER BY last_sequence ASC, runtime_item_id ASC
    `,
  });

  const deleteRows = SqlSchema.void({
    Request: ListProjectionRuntimeItemsInput,
    execute: ({ threadId }) => sql`
      DELETE FROM projection_runtime_items
      WHERE thread_id = ${threadId}
    `,
  });

  const upsert: ProjectionRuntimeItemRepositoryShape["upsert"] = (row) =>
    upsertRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionRuntimeItemRepository.upsert:query")),
    );
  const getById: ProjectionRuntimeItemRepositoryShape["getById"] = (input) =>
    getRow(input).pipe(
      Effect.map(Option.map(toRuntimeItem)),
      Effect.mapError(toPersistenceSqlError("ProjectionRuntimeItemRepository.getById:query")),
    );
  const listByThreadId: ProjectionRuntimeItemRepositoryShape["listByThreadId"] = (input) =>
    listRows(input).pipe(
      Effect.map((rows) => rows.map(toRuntimeItem)),
      Effect.mapError(
        toPersistenceSqlError("ProjectionRuntimeItemRepository.listByThreadId:query"),
      ),
    );
  const deleteByThreadId: ProjectionRuntimeItemRepositoryShape["deleteByThreadId"] = (input) =>
    deleteRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionRuntimeItemRepository.deleteByThreadId:query"),
      ),
    );

  return { upsert, getById, listByThreadId, deleteByThreadId };
});

export const ProjectionRuntimeItemRepositoryLive = Layer.effect(
  ProjectionRuntimeItemRepository,
  makeProjectionRuntimeItemRepository,
);
