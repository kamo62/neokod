import { WorkItemId } from "@neokod/contracts";
import type { WorkItem, WorkLifecycle } from "@neokod/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { nowIso } from "../../Domain/Time.ts";
import { SymphonyClaimLost } from "../Errors.ts";
import { WorkItemRepository } from "../Services/WorkItemRepository.ts";
import { WorkItemRepositoryLive } from "./WorkItemRepository.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";

const layer = it.layer(WorkItemRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

const makeWorkItem = (
  id: string,
  trackerIssueId: string,
  lifecycle: WorkLifecycle = "eligible",
): Effect.Effect<WorkItem> =>
  Effect.gen(function* () {
    const now = yield* nowIso;
    return {
      id: WorkItemId.make(id),
      mode: "symphony",
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
      const byIssue = yield* repo.getByTrackerIssue("github", "46");
      expect(byIssue?.id).toBe(id);
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
