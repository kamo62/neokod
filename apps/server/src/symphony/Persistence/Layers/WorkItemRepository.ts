import { WorkItemId, WorkLifecycleSchema } from "@neokod/contracts";
import type { WorkItem } from "@neokod/contracts";
import { Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { nowIso } from "../../Domain/Time.ts";
import { SymphonyBusy, SymphonyClaimLost, SymphonyPersistenceSqlError } from "../Errors.ts";
import {
  WorkItemRepository,
  type WorkItemRepositoryShape,
} from "../Services/WorkItemRepository.ts";

const WorkItemRowSchema = Schema.Struct({
  id: WorkItemId,
  workflowId: Schema.NullOr(Schema.String),
  trackerKind: Schema.String,
  trackerIssueId: Schema.String,
  trackerIdentifier: Schema.NullOr(Schema.String),
  repositoryPath: Schema.NullOr(Schema.String),
  objective: Schema.String,
  description: Schema.NullOr(Schema.String),
  priority: Schema.NullOr(Schema.Int),
  state: Schema.NullOr(Schema.String),
  labelsJson: Schema.String,
  assigneeId: Schema.NullOr(Schema.String),
  blockersJson: Schema.String,
  branchName: Schema.NullOr(Schema.String),
  issueUrl: Schema.NullOr(Schema.String),
  lifecycle: WorkLifecycleSchema,
  workspaceKey: Schema.NullOr(Schema.String),
  workspacePath: Schema.NullOr(Schema.String),
  baseBranch: Schema.NullOr(Schema.String),
  sourceJson: Schema.String,
  acceptanceCriteriaJson: Schema.String,
  ownerToken: Schema.NullOr(Schema.String),
  generation: Schema.Int,
  ownerPid: Schema.NullOr(Schema.Int),
  ownerStartedAt: Schema.NullOr(Schema.String),
  leaseExpiresAt: Schema.NullOr(Schema.String),
  excluded: Schema.Int,
  localPriority: Schema.NullOr(Schema.Int),
  eligibilityReasonsJson: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  lastSeenAt: Schema.NullOr(Schema.String),
  claimedAt: Schema.NullOr(Schema.String),
});

const rowToWorkItem = (row: Schema.Schema.Type<typeof WorkItemRowSchema>): WorkItem => ({
  id: row.id,
  mode: "symphony",
  repositoryPath: row.repositoryPath ?? undefined,
  workflowId: row.workflowId === null ? undefined : (row.workflowId as WorkItem["workflowId"]),
  objective: row.objective,
  description: row.description ?? undefined,
  acceptanceCriteria: JSON.parse(row.acceptanceCriteriaJson) as string[],
  source: JSON.parse(row.sourceJson) as WorkItem["source"],
  workspaceKey:
    row.workspaceKey === null ? undefined : (row.workspaceKey as WorkItem["workspaceKey"]),
  workspacePath: row.workspacePath ?? undefined,
  baseBranch: row.baseBranch ?? undefined,
  lifecycle: row.lifecycle,
  trackerIssueId: row.trackerIssueId === "" ? undefined : row.trackerIssueId,
  trackerIdentifier: row.trackerIdentifier ?? undefined,
  priority: row.priority ?? undefined,
  localPriority: row.localPriority ?? undefined,
  excluded: row.excluded === 1,
  blocked: false,
  eligibilityReasons: JSON.parse(row.eligibilityReasonsJson) as string[],
  evidence: null,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const workItemToRow = (workItem: WorkItem): Schema.Schema.Type<typeof WorkItemRowSchema> => ({
  id: workItem.id,
  workflowId: workItem.workflowId ?? null,
  trackerKind: workItem.source.kind,
  trackerIssueId:
    workItem.trackerIssueId ??
    (workItem.source.kind === "manual" ? "" : workItem.source.externalId),
  trackerIdentifier: workItem.trackerIdentifier ?? null,
  repositoryPath: workItem.repositoryPath ?? null,
  objective: workItem.objective,
  description: workItem.description ?? null,
  priority: workItem.priority ?? null,
  state: null,
  labelsJson: "[]",
  assigneeId: null,
  blockersJson: "[]",
  branchName: null,
  issueUrl: null,
  lifecycle: workItem.lifecycle,
  workspaceKey: workItem.workspaceKey ?? null,
  workspacePath: workItem.workspacePath ?? null,
  baseBranch: workItem.baseBranch ?? null,
  sourceJson: JSON.stringify(workItem.source),
  acceptanceCriteriaJson: JSON.stringify(workItem.acceptanceCriteria ?? []),
  ownerToken: null,
  generation: 0,
  ownerPid: null,
  ownerStartedAt: null,
  leaseExpiresAt: null,
  excluded: workItem.excluded === true ? 1 : 0,
  localPriority: workItem.localPriority ?? null,
  eligibilityReasonsJson: JSON.stringify(workItem.eligibilityReasons ?? []),
  createdAt: workItem.createdAt,
  updatedAt: workItem.updatedAt,
  lastSeenAt: workItem.updatedAt,
  claimedAt: null,
});

// The verbose RETURNING / SELECT column list is written once and interpolated
// as a literal fragment (`sql.literal`). Kept in sync with WorkItemRowSchema by
// hand.
const SELECT_COLUMNS = `  id, workflow_id AS "workflowId", tracker_kind AS "trackerKind",
  tracker_issue_id AS "trackerIssueId", tracker_identifier AS "trackerIdentifier",
  repository_path AS "repositoryPath", objective, description, priority, state,
  labels_json AS "labelsJson", assignee_id AS "assigneeId",
  blockers_json AS "blockersJson", branch_name AS "branchName",
  issue_url AS "issueUrl", lifecycle, workspace_key AS "workspaceKey",
  workspace_path AS "workspacePath", base_branch AS "baseBranch",
  source_json AS "sourceJson", acceptance_criteria_json AS "acceptanceCriteriaJson",
  owner_token AS "ownerToken", generation, owner_pid AS "ownerPid",
  owner_started_at AS "ownerStartedAt", lease_expires_at AS "leaseExpiresAt",
  excluded, local_priority AS "localPriority",
  eligibility_reasons_json AS "eligibilityReasonsJson",
  created_at AS "createdAt",
  updated_at AS "updatedAt", last_seen_at AS "lastSeenAt",
  claimed_at AS "claimedAt"
`;

const ClaimRequestSchema = Schema.Struct({
  id: WorkItemId,
  ownerToken: Schema.String,
  ownerPid: Schema.Int,
  now: Schema.String,
});

const TransitionRequestSchema = Schema.Struct({
  id: WorkItemId,
  lifecycle: WorkLifecycleSchema,
  ownerToken: Schema.optional(Schema.String),
  generation: Schema.optional(Schema.Int),
  from: Schema.optional(Schema.Array(WorkLifecycleSchema)),
  now: Schema.String,
});

const isBusy = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  String((cause as { code: unknown }).code).includes("BUSY");

const toSqlError =
  (operation: string) =>
  (cause: unknown): SymphonyPersistenceSqlError =>
    new SymphonyPersistenceSqlError({ operation, detail: "Failed to execute", cause });

const toBusyOrSqlError =
  (operation: string) =>
  (cause: unknown): SymphonyPersistenceSqlError | SymphonyBusy =>
    isBusy(cause)
      ? new SymphonyBusy({ operation })
      : new SymphonyPersistenceSqlError({ operation, detail: "Failed to execute", cause });

const makeRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const cols = sql.literal(SELECT_COLUMNS);

  const insertRow = SqlSchema.findOneOption({
    Request: WorkItemRowSchema,
    Result: WorkItemRowSchema,
    execute: (row) =>
      sql`
        INSERT INTO symphony_work_items (
          id, workflow_id, tracker_kind, tracker_issue_id, tracker_identifier,
          repository_path, objective, description, priority, state, labels_json,
          assignee_id, blockers_json, branch_name, issue_url, lifecycle,
          workspace_key, workspace_path, base_branch, source_json,
          acceptance_criteria_json, eligibility_reasons_json,
          created_at, updated_at, last_seen_at
        )
        VALUES (
          ${row.id}, ${row.workflowId}, ${row.trackerKind}, ${row.trackerIssueId},
          ${row.trackerIdentifier}, ${row.repositoryPath}, ${row.objective},
          ${row.description}, ${row.priority}, ${row.state}, ${row.labelsJson},
          ${row.assigneeId}, ${row.blockersJson}, ${row.branchName}, ${row.issueUrl},
          ${row.lifecycle}, ${row.workspaceKey}, ${row.workspacePath}, ${row.baseBranch},
          ${row.sourceJson}, ${row.acceptanceCriteriaJson}, ${row.eligibilityReasonsJson},
          ${row.createdAt}, ${row.updatedAt}, ${row.lastSeenAt}
        )
        ON CONFLICT(tracker_kind, tracker_issue_id) DO NOTHING
        RETURNING ${cols}
      `,
  });

  const updateRow = SqlSchema.findOneOption({
    Request: WorkItemRowSchema,
    Result: WorkItemRowSchema,
    execute: (row) =>
      sql`
        UPDATE symphony_work_items SET
          workflow_id = ${row.workflowId},
          repository_path = ${row.repositoryPath},
          objective = ${row.objective},
          description = ${row.description},
          priority = ${row.priority},
          state = ${row.state},
          labels_json = ${row.labelsJson},
          assignee_id = ${row.assigneeId},
          blockers_json = ${row.blockersJson},
          branch_name = ${row.branchName},
          issue_url = ${row.issueUrl},
          lifecycle = ${row.lifecycle},
          workspace_key = ${row.workspaceKey},
          workspace_path = ${row.workspacePath},
          base_branch = ${row.baseBranch},
          acceptance_criteria_json = ${row.acceptanceCriteriaJson},
          eligibility_reasons_json = ${row.eligibilityReasonsJson},
          updated_at = ${row.updatedAt},
          last_seen_at = ${row.lastSeenAt}
        WHERE id = ${row.id}
        RETURNING ${cols}
      `,
  });

  const claimRow = SqlSchema.findOneOption({
    Request: ClaimRequestSchema,
    Result: WorkItemRowSchema,
    execute: (request) =>
      sql`
        UPDATE symphony_work_items SET
          lifecycle = 'preparing',
          owner_token = ${request.ownerToken},
          generation = generation + 1,
          owner_pid = ${request.ownerPid},
          owner_started_at = ${request.now},
          lease_expires_at = ${request.now},
          claimed_at = ${request.now},
          updated_at = ${request.now}
        WHERE id = ${request.id}
          AND lifecycle IN ('eligible', 'queued', 'retry_scheduled')
        RETURNING ${cols}
      `,
  });

  const transitionRow = SqlSchema.findOneOption({
    Request: TransitionRequestSchema,
    Result: WorkItemRowSchema,
    execute: (request) => {
      const fence =
        request.ownerToken === undefined || request.generation === undefined
          ? sql``
          : sql`AND owner_token = ${request.ownerToken} AND generation = ${request.generation}`;
      const fromRestriction =
        request.from === undefined || request.from.length === 0
          ? sql``
          : sql`AND lifecycle IN (${sql.literal(
              request.from.map((value) => `'${String(value).replaceAll("'", "''")}'`).join(", "),
            )})`;
      return sql`
        UPDATE symphony_work_items SET
          lifecycle = ${request.lifecycle},
          updated_at = ${request.now}
        WHERE id = ${request.id}
          ${fence}
          ${fromRestriction}
        RETURNING ${cols}
      `;
    },
  });

  const upsert: WorkItemRepositoryShape["upsert"] = (workItem) => {
    const row = workItemToRow(workItem);
    return insertRow(row).pipe(
      Effect.mapError(toBusyOrSqlError("WorkItemRepository.upsert:insert")),
      Effect.flatMap((inserted) =>
        Option.match(inserted, {
          onNone: () =>
            updateRow(row).pipe(
              Effect.mapError(toSqlError("WorkItemRepository.upsert:update")),
              Effect.flatMap((updated) =>
                Option.match(updated, {
                  onNone: () =>
                    Effect.fail(
                      new SymphonyPersistenceSqlError({
                        operation: "WorkItemRepository.upsert",
                        detail: `Missing row after upsert for ${workItem.id}`,
                      }),
                    ),
                  onSome: (row) => Effect.succeed(rowToWorkItem(row)),
                }),
              ),
            ),
          onSome: (row) => Effect.succeed(rowToWorkItem(row)),
        }),
      ),
    );
  };

  const getById: WorkItemRepositoryShape["getById"] = (id) =>
    selectById(sql, id).pipe(
      Effect.mapError(toSqlError("WorkItemRepository.getById")),
      Effect.map(
        Option.match({
          onNone: () => null,
          onSome: rowToWorkItem,
        }),
      ),
    );

  const getByTrackerIssue: WorkItemRepositoryShape["getByTrackerIssue"] = (
    trackerKind,
    trackerIssueId,
  ) =>
    SqlSchema.findOneOption({
      Request: Schema.Struct({ trackerKind: Schema.String, trackerIssueId: Schema.String }),
      Result: WorkItemRowSchema,
      execute: (request) =>
        sql`
          SELECT ${cols}
          FROM symphony_work_items
          WHERE tracker_kind = ${request.trackerKind}
            AND tracker_issue_id = ${request.trackerIssueId}
        `,
    })({ trackerKind, trackerIssueId }).pipe(
      Effect.mapError(toSqlError("WorkItemRepository.getByTrackerIssue")),
      Effect.map(
        Option.match({
          onNone: () => null,
          onSome: rowToWorkItem,
        }),
      ),
    );

  const listByLifecycle: WorkItemRepositoryShape["listByLifecycle"] = (lifecycles, options) => {
    const workflowFilter =
      options?.workflowId === undefined ? sql`` : sql`AND workflow_id = ${options.workflowId}`;
    const lifecycleFilter = sql.in("lifecycle", lifecycles);
    return sql<Schema.Schema.Type<typeof WorkItemRowSchema>>`
      SELECT ${cols}
      FROM symphony_work_items
      WHERE ${lifecycleFilter}
        ${workflowFilter}
      ORDER BY (priority BETWEEN 1 AND 4) DESC, priority ASC, created_at ASC
      LIMIT ${options?.limit ?? 500}
    `.pipe(
      Effect.mapError(toSqlError("WorkItemRepository.listByLifecycle")),
      Effect.map((rows) => rows.map(rowToWorkItem)),
    );
  };

  const claim: WorkItemRepositoryShape["claim"] = (id, ownerToken) =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      const row = yield* claimRow({
        id,
        ownerToken,
        ownerPid: process.pid,
        now,
      }).pipe(Effect.mapError(toBusyOrSqlError("WorkItemRepository.claim")));
      return yield* Option.match(row, {
        onNone: () => Effect.fail(new SymphonyClaimLost({ workItemId: id })),
        onSome: (row) =>
          Effect.succeed({ workItem: rowToWorkItem(row), generation: row.generation }),
      });
    });

  const transition: WorkItemRepositoryShape["transition"] = (id, lifecycle, options) =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      const row = yield* transitionRow({
        id,
        lifecycle,
        ownerToken: options?.ownerToken,
        generation: options?.generation,
        from: options?.from,
        now,
      }).pipe(Effect.mapError(toBusyOrSqlError("WorkItemRepository.transition")));
      return Option.isSome(row);
    });

  const releaseClaim: WorkItemRepositoryShape["releaseClaim"] = (id, to) =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      const row = yield* sql<Schema.Schema.Type<typeof WorkItemRowSchema>>`
        UPDATE symphony_work_items SET
          lifecycle = ${to},
          owner_token = NULL,
          owner_pid = NULL,
          owner_started_at = NULL,
          lease_expires_at = NULL,
          generation = generation + 1,
          updated_at = ${now}
        WHERE id = ${id}
          AND lifecycle IN ('preparing', 'running')
        RETURNING ${cols}
      `.pipe(Effect.mapError(toBusyOrSqlError("WorkItemRepository.releaseClaim")));
      return row.length > 0;
    });

  const writeOverrides: WorkItemRepositoryShape["writeOverrides"] = (id, overrides) =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      yield* sql`
        UPDATE symphony_work_items SET
          excluded = ${overrides.excluded === true ? 1 : 0},
          local_priority = ${overrides.localPriority ?? null},
          updated_at = ${now}
        WHERE id = ${id}
      `.pipe(Effect.mapError(toSqlError("WorkItemRepository.writeOverrides")));
    });

  const refreshTrackerSnapshot: WorkItemRepositoryShape["refreshTrackerSnapshot"] = (
    id,
    snapshot,
  ) =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      yield* sql`
        UPDATE symphony_work_items SET
          state = COALESCE(${snapshot.state}, state),
          labels_json = ${JSON.stringify(snapshot.labels ?? [])},
          priority = ${snapshot.priority ?? null},
          last_seen_at = ${snapshot.lastSeenAt ?? now},
          updated_at = ${now}
        WHERE id = ${id}
      `.pipe(Effect.mapError(toSqlError("WorkItemRepository.refreshTrackerSnapshot")));
    });

  return {
    upsert,
    getById,
    getByTrackerIssue,
    listByLifecycle,
    claim,
    transition,
    releaseClaim,
    writeOverrides,
    refreshTrackerSnapshot,
  } satisfies WorkItemRepositoryShape;
});

export const WorkItemRepositoryLive = Layer.effect(WorkItemRepository, makeRepository);

const selectById = (sql: SqlClient.SqlClient, id: WorkItemId) =>
  SqlSchema.findOneOption({
    Request: Schema.Struct({ id: WorkItemId }),
    Result: WorkItemRowSchema,
    execute: (request) =>
      sql`
        SELECT ${sql.literal(SELECT_COLUMNS)}
        FROM symphony_work_items
        WHERE id = ${request.id}
      `,
  })({ id });
