import { SymphonyProjectId, WorkflowId, WorkItemId } from "@neokod/contracts";
import type { WorkItem, WorkLifecycle } from "@neokod/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
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
  lifecycle: WorkLifecycle = "eligible",
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

const seed = (id: string, trackerIssueId: string, lifecycle: WorkLifecycle = "eligible") =>
  Effect.gen(function* () {
    const repo = yield* WorkItemRepository;
    const item = yield* makeWorkItem(id, trackerIssueId, lifecycle);
    yield* repo.upsert(item);
    return item.id;
  });

layer("WorkItemRepository claim authority", (it) => {
  it.effect("exactly one claim succeeds for a shared eligible row", () =>
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
      // eligible -> running is not a legal default source pair.
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
      const second = yield* makeWorkItem(
        "workitem-project-b",
        "shared",
        "eligible",
        otherProjectId,
      );
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
