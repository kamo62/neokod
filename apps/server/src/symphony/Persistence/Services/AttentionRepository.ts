import {
  AttentionItemId,
  type AttentionItem,
  type AttentionItemKind,
  type AttentionItemState,
  WorkItemId,
} from "@neokod/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Schema from "effect/Schema";

import { nowIso } from "../../Domain/Time.ts";
import { SymphonyPersistenceSqlError } from "../Errors.ts";
import { decodeJson, encodeJson } from "../Json.ts";

const AttentionRowSchema = Schema.Struct({
  id: AttentionItemId,
  workItemId: WorkItemId,
  runAttemptId: Schema.NullOr(Schema.String),
  kind: Schema.String,
  severity: Schema.String,
  state: Schema.String,
  payloadJson: Schema.String,
  recommendedAction: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  resolvedAt: Schema.NullOr(Schema.String),
  resolution: Schema.NullOr(Schema.String),
});

const rowToAttentionItem = (row: Schema.Schema.Type<typeof AttentionRowSchema>): AttentionItem => {
  const payload = decodeJson(row.payloadJson) as {
    whatHappened: string;
    whyHuman: string;
    recommendedResponse?: string;
    availableActions: string[];
    consequences?: string;
  };
  return {
    id: row.id,
    workItemId: row.workItemId,
    ...(row.runAttemptId === null ? {} : { runAttemptId: row.runAttemptId as never }),
    kind: row.kind as AttentionItemKind,
    severity: row.severity as AttentionItem["severity"],
    state: row.state as AttentionItemState,
    whatHappened: payload.whatHappened,
    whyHuman: payload.whyHuman,
    ...(payload.recommendedResponse !== undefined
      ? { recommendedResponse: payload.recommendedResponse }
      : {}),
    availableActions: payload.availableActions,
    ...(payload.consequences !== undefined ? { consequences: payload.consequences } : {}),
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
    ...(row.resolution === null ? {} : { resolution: row.resolution }),
  };
};

const SELECT_COLUMNS = `
  id, work_item_id AS "workItemId", run_attempt_id AS "runAttemptId",
  kind, severity, state, payload_json AS "payloadJson",
  recommended_action AS "recommendedAction", created_at AS "createdAt",
  resolved_at AS "resolvedAt", resolution
`;

const toSqlError =
  (operation: string) =>
  (cause: unknown): SymphonyPersistenceSqlError =>
    new SymphonyPersistenceSqlError({ operation, detail: "Failed to execute", cause });

export interface AttentionRepositoryShape {
  readonly create: (input: {
    readonly id: AttentionItemId;
    readonly workItemId: WorkItemId;
    readonly runAttemptId?: string;
    readonly kind: AttentionItemKind;
    readonly severity: AttentionItem["severity"];
    readonly whatHappened: string;
    readonly whyHuman: string;
    readonly recommendedResponse?: string;
    readonly availableActions: ReadonlyArray<string>;
    readonly consequences?: string;
  }) => Effect.Effect<void, SymphonyPersistenceSqlError>;

  readonly listOpen: (options?: {
    readonly limit?: number;
  }) => Effect.Effect<AttentionItem[], SymphonyPersistenceSqlError>;

  readonly resolve: (
    id: AttentionItemId,
    resolution: string,
  ) => Effect.Effect<boolean, SymphonyPersistenceSqlError>;
}

export class AttentionRepository extends Context.Service<
  AttentionRepository,
  AttentionRepositoryShape
>()("neokod/symphony/Persistence/Services/AttentionRepository") {}

const makeRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const create: AttentionRepositoryShape["create"] = (input) =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      const payload = {
        whatHappened: input.whatHappened,
        whyHuman: input.whyHuman,
        ...(input.recommendedResponse !== undefined
          ? { recommendedResponse: input.recommendedResponse }
          : {}),
        availableActions: [...input.availableActions],
        ...(input.consequences !== undefined ? { consequences: input.consequences } : {}),
      };
      yield* sql`
        INSERT INTO symphony_attention_items (
          id, work_item_id, run_attempt_id, kind, severity, state,
          payload_json, recommended_action, created_at
        )
        VALUES (
          ${String(input.id)}, ${String(input.workItemId)}, ${input.runAttemptId ?? null},
          ${input.kind}, ${input.severity}, 'open',
          ${encodeJson(payload)}, ${input.recommendedResponse ?? null}, ${now}
        )
      `.pipe(Effect.mapError(toSqlError("AttentionRepository.create")));
    });

  const listOpen: AttentionRepositoryShape["listOpen"] = (options) =>
    sql<Schema.Schema.Type<typeof AttentionRowSchema>>`
      SELECT ${sql.literal(SELECT_COLUMNS)}
      FROM symphony_attention_items
      WHERE state = 'open'
      ORDER BY created_at DESC
      ${options?.limit ? sql`LIMIT ${options.limit}` : sql``}
    `.pipe(
      Effect.mapError(toSqlError("AttentionRepository.listOpen")),
      Effect.map((rows) => rows.map(rowToAttentionItem)),
    );

  const resolve: AttentionRepositoryShape["resolve"] = (id, resolution) =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      const rows = yield* sql`
        UPDATE symphony_attention_items SET
          state = 'resolved',
          resolved_at = ${now},
          resolution = ${resolution}
        WHERE id = ${String(id)} AND state = 'open'
        RETURNING id
      `.pipe(Effect.mapError(toSqlError("AttentionRepository.resolve")));
      return rows.length > 0;
    });

  return { create, listOpen, resolve };
});

export const AttentionRepositoryLive: Layer.Layer<AttentionRepository, never, SqlClient.SqlClient> =
  Layer.effect(AttentionRepository, makeRepository);
