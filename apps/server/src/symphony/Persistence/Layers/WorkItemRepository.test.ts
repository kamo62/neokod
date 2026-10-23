import { SymphonyProjectId, WorkflowId, WorkItemId } from "@neokod/contracts";
import type { WorkItem, WorkLifecycle } from "@neokod/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { nowIso } from "../../Domain/Time.ts";
import { SymphonyClaimLost } from "../Errors.ts";
import { WorkItemRepository } from "../Services/WorkItemRepository.ts";
import { WorkItemRepositoryLive } from "./WorkItemRepository.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../../persistence/Layers/Sqlite.ts";

const layer = it.layer(WorkItemRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));
const PROJECT_ID = SymphonyProjectId.make("symphony-project-test");

const makeWorkItem = (
  id: string,
  trackerIssueId: string,
  lifecycle: WorkLifecycle = "queued",
  projectId: SymphonyProjectId | undefined = PROJECT_ID,
): Effect.Effect<WorkItem> =>
  Effect.gen(function* () {
    const now = yield* nowIso;
    return {
      id: WorkItemId.make(id),
      mode: "symphony",
      ...(projectId === undefined ? {} : { projectId }),
      workflowId: undefined,
      objective: `Implement ${trackerIssueId}`,
      acceptanceCriteria: [],
      source: { kind: "github", externalId: trackerIssueId, externalUrl: "https://example.test/i" },
      lifecycle,
      trackerIssueId,
      trackerIdentifier: `#${trackerIssueId}`,
      blocked: false,
      eligibilityReasons: [],
      evidence: null,
      createdAt: now,
      updatedAt: now,
    } satisfies WorkItem;
  });

const seed = (id: string, trackerIssueId: string, lifecycle: WorkLifecycle = "queued") =>
  Effect.gen(function* () {
    const repo = yield* WorkItemRepository;
    const item = yield* makeWorkItem(id, trackerIssueId, lifecycle);
    yield* repo.upsert(item);
    return item.id;
  });

layer("WorkItemRepository claim authority", (it) => {
  it.effect("exactly one claim succeeds for a shared queued row", () =>
    Effect.gen(function* () {
      const repo = yield* WorkItemRepository;
      const id = yield* seed("workitem-claim-1", "42");

      const firstResult = yield* Effect.result(repo.claim(id, "owner-a"));
      const second = yield* Effect.result(repo.claim(id, "owner-b"));

      expect(firstResult._tag).toBe("Success");
      if (firstResult._tag === "Success") {
        expect(firstResult.success.workItem.lifecycle).toBe("preparing");
        expect(firstResult.success.generation).toBeGreaterThanOrEqual(1);
      }

      expect(second._tag).toBe("Failure");
      if (second._tag === "Failure") {
        expect(second.failure).toBeInstanceOf(SymphonyClaimLost);
      }
    }),
  );

  it.effect("the loser cannot transition under the winner's fence", () =>
    Effect.gen(function* () {
      const repo = yield* WorkItemRepository;
      const id = yield* seed("workitem-claim-2", "43");

      const winner = yield* repo.claim(id, "owner-a");
      expect(winner.workItem.lifecycle).toBe("preparing");

      // The loser's fence transition must be rejected: wrong owner token.
      const loserTransition = yield* repo.transition(id, "running", {
        ownerToken: "owner-b",
        generation: 0,
      });
      expect(loserTransition).toBe(false);

      // The winner's own fence transition succeeds.
      const winnerTransition = yield* repo.transition(id, "running", {
        ownerToken: "owner-a",
        generation: winner.generation,
      });
      expect(winnerTransition).toBe(true);
    }),
  );

  it.effect("claim does not store the server pid", () =>
    Effect.gen(function* () {
      const repo = yield* WorkItemRepository;
      const id = yield* seed("workitem-claim-pid-1", "pid1");

      const { workItem } = yield* repo.claim(id, "owner-a");
      expect(workItem.ownerPid).toBeUndefined();
    }),
  );

  it.effect("setClaimOwnerPid records the pid only for the current owner and generation", () =>
    Effect.gen(function* () {
      const repo = yield* WorkItemRepository;
      const id = yield* seed("workitem-claim-pid-2", "pid2");

      const { generation } = yield* repo.claim(id, "owner-a");
      expect(yield* repo.setClaimOwnerPid(id, "owner-a", generation, 4321)).toBe(true);
      expect((yield* repo.getById(id))?.ownerPid).toBe(4321);
      expect(yield* repo.setClaimOwnerPid(id, "owner-a", generation + 1, 9999)).toBe(false);
      expect(yield* repo.setClaimOwnerPid(id, "other", generation, 9999)).toBe(false);
      expect((yield* repo.getById(id))?.ownerPid).toBe(4321);
    }),
  );

  it.effect("setBaseBranch records the branch for the current claim only", () =>
    Effect.gen(function* () {
      const repo = yield* WorkItemRepository;
      const id = yield* seed("workitem-base-branch-1", "bb1");

      const { generation } = yield* repo.claim(id, "owner-a");
      expect(yield* repo.setBaseBranch(id, "owner-a", generation, "develop")).toBe(true);
      expect((yield* repo.getById(id))?.baseBranch).toBe("develop");
      expect(yield* repo.setBaseBranch(id, "owner-a", generation + 1, "x")).toBe(false);
    }),
  );

  it.effect("a tracker re-poll keeps the recorded base branch", () =>
    Effect.gen(function* () {
      const repo = yield* WorkItemRepository;
      const id = yield* seed("workitem-base-branch-2", "bb2");

      const { generation } = yield* repo.claim(id, "owner-a");
      expect(yield* repo.setBaseBranch(id, "owner-a", generation, "develop")).toBe(true);
      const rediscovered = yield* makeWorkItem("workitem-base-branch-2", "bb2", "queued");
      yield* repo.upsert(rediscovered);
      expect((yield* repo.getById(id))?.baseBranch).toBe("develop");
    }),
  );

  it.effect("unfenced transition succeeds without an owner check", () =>
    Effect.gen(function* () {
      const repo = yield* WorkItemRepository;
      const id = yield* seed("workitem-claim-3", "44");

      const ok = yield* repo.transition(id, "cancelled");
      expect(ok).toBe(true);

      const row = yield* repo.getById(id);
      expect(row?.lifecycle).toBe("cancelled");
    }),
  );

  it.effect("a transition without from is bounded by the legality table", () =>
    Effect.gen(function* () {
      const repo = yield* WorkItemRepository;
      // queued -> running is not a legal default source pair.
      const illegal = yield* repo.transition(WorkItemId.make("workitem-claim-3"), "running");
      expect(illegal).toBe(false);
      const row = yield* repo.getById(WorkItemId.make("workitem-claim-3"));
      expect(row?.lifecycle).toBe("cancelled");
    }),
  );

  it.effect("a terminal lifecycle is immutable by default", () =>
    Effect.gen(function* () {
      const repo = yield* WorkItemRepository;
      const id = yield* seed("workitem-claim-4", "45");
      yield* repo.transition(id, "cancelled");
      // completed/cancelled/failed never appear in the default sources:
      // leaving a terminal lifecycle must be refused without an explicit
      // `from` opt-in.
      const blocked = yield* repo.transition(id, "blocked");
      expect(blocked).toBe(false);
      const row = yield* repo.getById(id);
      expect(row?.lifecycle).toBe("cancelled");
    }),
  );

  it.effect("a terminal item cannot be claimed again", () =>
    Effect.gen(function* () {
      const repo = yield* WorkItemRepository;
      const id = yield* seed("workitem-claim-4", "45", "completed");
      const result = yield* Effect.result(repo.claim(id, "owner-a"));
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("an ineligible item cannot be claimed", () =>
    Effect.gen(function* () {
      const repo = yield* WorkItemRepository;
      const id = yield* seed("workitem-claim-ineligible", "48", "ineligible");
      const result = yield* Effect.result(repo.claim(id, "owner-a"));
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure).toBeInstanceOf(SymphonyClaimLost);
      }
      expect((yield* repo.getById(id))?.lifecycle).toBe("ineligible");
    }),
  );

  it.effect("getByTrackerIssue resolves the same row across re-discovery", () =>
    Effect.gen(function* () {
      const repo = yield* WorkItemRepository;
      const id = yield* seed("workitem-claim-5", "46");

      const reUpsert = yield* makeWorkItem("workitem-claim-5", "46");
      const afterUpsert = yield* repo.upsert(reUpsert);

      expect(afterUpsert.id).toBe(id);
      const byIssue = yield* repo.getByTrackerIssue(PROJECT_ID, "github", "46");
      expect(byIssue?.id).toBe(id);
    }),
  );

  it.effect("rejects work items that are not assigned to a Symphony project", () =>
    Effect.gen(function* () {
      const repo = yield* WorkItemRepository;
      const scoped = yield* makeWorkItem("workitem-unscoped", "unscoped");
      const { projectId: _projectId, ...item } = scoped;
      const result = yield* Effect.result(repo.upsert(item));

      expect(result._tag).toBe("Failure");
      expect(yield* repo.getById(item.id)).toBeNull();
    }),
  );

  it.effect("isolates the same tracker issue across Symphony projects", () =>
    Effect.gen(function* () {
      const repo = yield* WorkItemRepository;
      const otherProjectId = SymphonyProjectId.make("symphony-project-other");
      const first = yield* makeWorkItem("workitem-project-a", "shared");
      const second = yield* makeWorkItem("workitem-project-b", "shared", "queued", otherProjectId);
      yield* repo.upsert(first);
      yield* repo.upsert(second);

      expect((yield* repo.getByTrackerIssue(PROJECT_ID, "github", "shared"))?.id).toBe(first.id);
      expect((yield* repo.getByTrackerIssue(otherProjectId, "github", "shared"))?.id).toBe(
        second.id,
      );
    }),
  );

  it.effect("tracker re-discovery updates metadata without resetting an active lifecycle", () =>
    Effect.gen(function* () {
      const repo = yield* WorkItemRepository;
      const id = yield* seed("workitem-claim-6", "47");
      yield* repo.claim(id, "owner-a");

      const rediscovered = yield* makeWorkItem("workitem-claim-6", "47", "queued");
      const afterUpsert = yield* repo.upsert({
        ...rediscovered,
        workflowId: WorkflowId.make("wf-47"),
        objective: "Updated tracker title",
      });

      expect(afterUpsert.lifecycle).toBe("preparing");
      expect(afterUpsert.workflowId).toBe(WorkflowId.make("wf-47"));
      expect(afterUpsert.objective).toBe("Updated tracker title");
    }),
  );

  it.effect("listForBoard isolates the project and bounds active and terminal slices", () =>
    Effect.gen(function* () {
      const repo = yield* WorkItemRepository;
      const projectId = SymphonyProjectId.make("symphony-project-board-coverage");
      const otherProjectId = SymphonyProjectId.make("symphony-project-board-other");
      const seedAt = (
        id: string,
        lifecycle: WorkLifecycle,
        createdAt: string,
        updatedAt: string,
        itemProjectId: SymphonyProjectId = projectId,
      ) =>
        Effect.gen(function* () {
          const item = yield* makeWorkItem(id, id, lifecycle, itemProjectId);
          yield* repo.upsert({ ...item, createdAt, updatedAt });
        });

      yield* seedAt(
        "board-active-d",
        "queued",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );
      yield* seedAt(
        "board-active-c",
        "queued",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );
      yield* seedAt(
        "board-active-b",
        "queued",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );
      yield* seedAt(
        "board-active-a",
        "queued",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );
      yield* seedAt(
        "board-running",
        "running",
        "2026-01-02T00:00:00.000Z",
        "2026-01-02T00:00:00.000Z",
      );
      yield* seedAt(
        "board-completed-new-a",
        "completed",
        "2026-01-01T00:00:00.000Z",
        "2026-01-04T00:00:00.000Z",
      );
      yield* seedAt(
        "board-completed-new-b",
        "completed",
        "2026-01-01T00:00:00.000Z",
        "2026-01-04T00:00:00.000Z",
      );
      yield* seedAt(
        "board-completed-old",
        "completed",
        "2026-01-01T00:00:00.000Z",
        "2026-01-02T00:00:00.000Z",
      );
      yield* seedAt(
        "board-completed-oldest",
        "completed",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );
      yield* seedAt(
        "board-other-project",
        "queued",
        "2026-01-01T00:00:00.000Z",
        "2025-12-01T00:00:00.000Z",
        otherProjectId,
      );

      const board = yield* repo.listForBoard(projectId, {
        activeLimit: 2,
        terminalLimit: 2,
      });

      expect(board.items.map((item) => item.id)).toEqual([
        WorkItemId.make("board-active-a"),
        WorkItemId.make("board-active-b"),
        WorkItemId.make("board-completed-new-b"),
        WorkItemId.make("board-completed-new-a"),
      ]);
      expect(board.totalsByLifecycle).toEqual({
        completed: 4,
        queued: 4,
        running: 1,
      });
    }),
  );

  it.effect("board and scheduler reads fail with a typed error naming a corrupt row", () =>
    Effect.gen(function* () {
      const repo = yield* WorkItemRepository;
      const sql = yield* SqlClient.SqlClient;
      const projectId = SymphonyProjectId.make("symphony-project-board-corrupt");
      const item = yield* makeWorkItem("board-corrupt-row", "corrupt-row", "queued", projectId);
      yield* repo.upsert(item);
      const id = item.id;
      yield* sql`UPDATE symphony_work_items SET acceptance_criteria_json = 'not json' WHERE id = ${id}`;

      const results = yield* Effect.gen(function* () {
        const board = yield* Effect.result(
          repo.listForBoard(projectId, { activeLimit: 10, terminalLimit: 10 }),
        );
        const listed = yield* Effect.result(repo.listByLifecycle(["queued"], { projectId }));
        return { board, listed };
      }).pipe(
        Effect.ensuring(
          sql`UPDATE symphony_work_items SET acceptance_criteria_json = '[]' WHERE id = ${id}`.pipe(
            Effect.ignore,
          ),
        ),
      );

      expect(results.board._tag).toBe("Failure");
      if (results.board._tag === "Failure") {
        expect(results.board.failure._tag).toBe("SymphonyPersistenceDecodeError");
        expect(results.board.failure.message).toContain(id);
      }
      expect(results.listed._tag).toBe("Failure");
      if (results.listed._tag === "Failure") {
        expect(results.listed.failure._tag).toBe("SymphonyPersistenceDecodeError");
        expect(results.listed.failure.message).toContain(id);
      }
    }),
  );

  it.effect("a syntactically valid null source payload fails as a named-row decode error", () =>
    Effect.gen(function* () {
      const repo = yield* WorkItemRepository;
      const sql = yield* SqlClient.SqlClient;
      const projectId = SymphonyProjectId.make("symphony-project-board-null-source");
      const item = yield* makeWorkItem("board-null-source", "null-source", "queued", projectId);
      yield* repo.upsert(item);
      const id = item.id;
      yield* sql`UPDATE symphony_work_items SET source_json = 'null' WHERE id = ${id}`;

      const result = yield* Effect.result(
        repo.listForBoard(projectId, { activeLimit: 10, terminalLimit: 10 }),
      ).pipe(
        Effect.ensuring(
          sql`UPDATE symphony_work_items SET source_json = '{"kind":"manual"}' WHERE id = ${id}`.pipe(
            Effect.ignore,
          ),
        ),
      );

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("SymphonyPersistenceDecodeError");
        expect(result.failure.message).toContain(id);
      }
    }),
  );
});

layer("WorkItemRepository confirmed Stop", (it) => {
  it.effect("cancels and clears the claim once, preventing a racing retry", () =>
    Effect.gen(function* () {
      const repo = yield* WorkItemRepository;
      const id = yield* seed("stop-1", "stop-1");
      const { generation } = yield* repo.claim(id, "owner-a");
      yield* repo.setClaimOwnerPid(id, "owner-a", generation, 4321);

      const released = yield* repo.releaseConfirmedStop(id);
      expect(released).toBe(true);

      const after = yield* repo.getById(id);
      expect(after?.lifecycle).toBe("cancelled");
      // Releasing the claim removes the recorded child identity, not just the token.
      expect(after?.ownerPid ?? null).toBeNull();

      // A failure that races the stop can no longer schedule a retry: the
      // owner fence is gone and the terminal lifecycle is not a legal source.
      const retried = yield* repo.transition(id, "retry_scheduled", {
        ownerToken: "owner-a",
        generation,
      });
      expect(retried).toBe(false);

      // Confirmed closure releases exactly once.
      expect(yield* repo.releaseConfirmedStop(id)).toBe(false);
      expect((yield* repo.getById(id))?.lifecycle).toBe("cancelled");
    }),
  );

  it.effect("does not re-release an already terminal item", () =>
    Effect.gen(function* () {
      const repo = yield* WorkItemRepository;
      const id = yield* seed("stop-2", "stop-2", "failed");
      expect(yield* repo.releaseConfirmedStop(id)).toBe(false);
      expect((yield* repo.getById(id))?.lifecycle).toBe("failed");
    }),
  );
});

layer("WorkItemRepository lifecycle legality (plan section 19 suite 6)", (it) => {
  it.effect("a from-restricted transition succeeds from a matching lifecycle", () =>
    Effect.gen(function* () {
      const repo = yield* WorkItemRepository;
      const id = yield* seed("lifecycle-1", "61", "running");

      const changed = yield* repo.transition(id, "blocked", { from: ["running"] });
      expect(changed).toBe(true);
      const row = yield* repo.getById(id);
      expect(row?.lifecycle).toBe("blocked");
    }),
  );

  it.effect("a from-restricted transition is refused from a non-matching lifecycle", () =>
    Effect.gen(function* () {
      const repo = yield* WorkItemRepository;
      const id = yield* seed("lifecycle-2", "62", "queued");

      const changed = yield* repo.transition(id, "blocked", { from: ["running"] });
      expect(changed).toBe(false);
      const row = yield* repo.getById(id);
      expect(row?.lifecycle).toBe("queued");
    }),
  );

  it.effect("a from-restricted transition only matches the stated source", () =>
    Effect.gen(function* () {
      const repo = yield* WorkItemRepository;
      const id = yield* seed("lifecycle-3", "63", "completed");

      // A transition whose from-restriction excludes the current lifecycle
      // is refused; the caller is responsible for not passing a terminal
      // source (the takeover park in HandoffService passes only
      // non-terminal lifecycles).
      const changed = yield* repo.transition(id, "queued", { from: ["running"] });
      expect(changed).toBe(false);
      const row = yield* repo.getById(id);
      expect(row?.lifecycle).toBe("completed");
    }),
  );

  it.effect("an unfenced transition still respects a from restriction", () =>
    Effect.gen(function* () {
      const repo = yield* WorkItemRepository;
      const id = yield* seed("lifecycle-4", "64", "ready_for_review");

      // Unfenced + from-restricted: allowed source -> blocked is a legal
      // takeover park, but ready_to_merge must not be the source here.
      const changed = yield* repo.transition(id, "changes_requested", {
        from: ["ready_for_review"],
      });
      expect(changed).toBe(true);
    }),
  );

  it.effect("a testing item can be re-scheduled for retry", () =>
    Effect.gen(function* () {
      const repo = yield* WorkItemRepository;
      const id = yield* seed("lifecycle-5", "65", "testing");

      const changed = yield* repo.transition(id, "retry_scheduled");
      expect(changed).toBe(true);
      const row = yield* repo.getById(id);
      expect(row?.lifecycle).toBe("retry_scheduled");
    }),
  );

  it.effect("a preparing item can fail", () =>
    Effect.gen(function* () {
      const repo = yield* WorkItemRepository;
      const id = yield* seed("lifecycle-6", "66", "preparing");

      const changed = yield* repo.transition(id, "failed");
      expect(changed).toBe(true);
      const row = yield* repo.getById(id);
      expect(row?.lifecycle).toBe("failed");
    }),
  );

  it.effect("a failed item cannot be re-queued without an explicit from", () =>
    Effect.gen(function* () {
      const repo = yield* WorkItemRepository;
      const id = yield* seed("lifecycle-7", "67", "preparing");
      expect(yield* repo.transition(id, "failed")).toBe(true);

      expect(yield* repo.transition(id, "queued")).toBe(false);
      expect(yield* repo.transition(id, "queued", { from: ["failed"] })).toBe(true);
      const row = yield* repo.getById(id);
      expect(row?.lifecycle).toBe("queued");
    }),
  );

  it.effect("listByLifecycle pages through a stable order with offset", () =>
    Effect.gen(function* () {
      const repo = yield* WorkItemRepository;
      const projectId = SymphonyProjectId.make("symphony-project-pagination");
      const seeded: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        const item = yield* makeWorkItem(
          `workitem-page-${index}`,
          `page-${index}`,
          "ready_to_merge",
          projectId,
        );
        const row = yield* repo.upsert({
          ...item,
          createdAt: `2026-08-0${index + 1}T00:00:00.000Z`,
          updatedAt: `2026-08-0${index + 1}T00:00:00.000Z`,
        });
        seeded.push(String(row.id));
      }

      const first = yield* repo.listByLifecycle(["ready_to_merge"], { projectId, limit: 2 });
      const second = yield* repo.listByLifecycle(["ready_to_merge"], {
        projectId,
        limit: 2,
        offset: 2,
      });
      const third = yield* repo.listByLifecycle(["ready_to_merge"], {
        projectId,
        limit: 2,
        offset: 4,
      });
      const past = yield* repo.listByLifecycle(["ready_to_merge"], {
        projectId,
        limit: 2,
        offset: 9,
      });

      // Pages are disjoint — the order is total — and together cover every row.
      const paged = [...first, ...second, ...third].map((item) => String(item.id));
      expect(new Set(paged).size).toBe(5);
      expect(new Set(paged)).toEqual(new Set(seeded));
      expect(past).toEqual([]);
    }),
  );
});

describe("WorkItemRepository two-connection contention", () => {
  it.effect("exactly one claim wins across two independent connections", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Two truly independent SQLite connections over the same file (plan
        // section 19 suite 1; audit item 6): the loser must see the winner's
        // claim, not a stale snapshot.
        const os = yield* Effect.promise(() => import("node:os"));
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const nonce = yield* Random.nextIntBetween(1_000_000, 9_999_999);
        const dir = path.join(os.tmpdir(), `symphony-contend-${nonce}`);
        const dbPath = path.join(dir, "contention.db");
        yield* fs.makeDirectory(dir, { recursive: true });

        const scope = yield* Effect.scope;
        const memoMap = yield* Layer.makeMemoMap;
        const layerA = WorkItemRepositoryLive.pipe(
          Layer.provideMerge(makeSqlitePersistenceLive(dbPath)),
          Layer.provideMerge(NodeServices.layer),
        );
        const layerB = WorkItemRepositoryLive.pipe(
          Layer.provideMerge(makeSqlitePersistenceLive(dbPath)),
          Layer.provideMerge(NodeServices.layer),
        );
        const contextA = yield* Layer.buildWithMemoMap(layerA, memoMap, scope);
        const contextB = yield* Layer.buildWithMemoMap(layerB, memoMap, scope);

        const repoA = yield* Effect.service(WorkItemRepository).pipe(Effect.provide(contextA));
        const repoB = yield* Effect.service(WorkItemRepository).pipe(Effect.provide(contextB));

        const item = yield* makeWorkItem("contend-1", "contend-1");
        yield* repoA.upsert(item);

        const [resultA, resultB] = yield* Effect.all(
          [
            repoB.claim(WorkItemId.make("contend-1"), "owner-b").pipe(Effect.result),
            repoA.claim(WorkItemId.make("contend-1"), "owner-a").pipe(Effect.result),
          ],
          { concurrency: "unbounded" },
        );

        const successes = [resultA, resultB].filter((result) => result._tag === "Success");
        expect(successes).toHaveLength(1);
        const failures = [resultA, resultB].filter((result) => result._tag === "Failure");
        expect(failures).toHaveLength(1);

        yield* fs.remove(dir, { recursive: true }).pipe(Effect.catch(() => Effect.void));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
