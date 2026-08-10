import {
  ProviderDriverKind,
  ProviderInstanceId,
  RunAttemptId,
  SymphonyProjectId,
  WorkItemId,
} from "@neokod/contracts";
import type { RunAttempt } from "@neokod/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { nowIso } from "../../Domain/Time.ts";
import { WorkItemRepository } from "../Services/WorkItemRepository.ts";
import { WorkItemRepositoryLive } from "./WorkItemRepository.ts";
import { RunAttemptRepository } from "../Services/RunAttemptRepository.ts";
import { RunAttemptRepositoryLive } from "./RunAttemptRepository.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";

const layer = it.layer(
  RunAttemptRepositoryLive.pipe(
    Layer.provideMerge(WorkItemRepositoryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

const seedWorkItem = (workItemId: string) =>
  Effect.gen(function* () {
    const repo = yield* WorkItemRepository;
    const now = yield* nowIso;
    yield* repo.upsert({
      id: WorkItemId.make(workItemId),
      mode: "symphony",
      projectId: SymphonyProjectId.make("run-attempt-project"),
      objective: "Seed work item",
      acceptanceCriteria: [],
      source: { kind: "github", externalId: workItemId, externalUrl: "https://example.test" },
      lifecycle: "queued",
      trackerIssueId: workItemId,
      blocked: false,
      eligibilityReasons: [],
      evidence: null,
      createdAt: now,
      updatedAt: now,
    });
  });

const makeAttempt = (id: string, workItemId: string, attemptNumber: number) =>
  Effect.gen(function* () {
    const now = yield* nowIso;
    return {
      id: RunAttemptId.make(id),
      workItemId: WorkItemId.make(workItemId),
      attemptNumber,
      workspacePath: "/ws",
      provider: {
        instanceId: ProviderInstanceId.make("codex_default"),
        driver: ProviderDriverKind.make("codex"),
      },
      model: "gpt-5",
      status: "preparing_workspace",
      startedAt: now,
      finishedAt: null,
      error: null,
    } satisfies RunAttempt;
  });

layer("RunAttemptRepository", (it) => {
  it.effect("creates, updates status, and lists by work item", () =>
    Effect.gen(function* () {
      const repo = yield* RunAttemptRepository;
      yield* seedWorkItem("wi-1");
      const attempt = yield* makeAttempt("run-1", "wi-1", 1);
      const created = yield* repo.create(attempt);
      expect(created.id).toBe("run-1");

      yield* repo.updateStatus(RunAttemptId.make("run-1"), "succeeded", {
        finishedAt: created.startedAt,
        tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      });

      const loaded = yield* repo.getById(RunAttemptId.make("run-1"));
      expect(loaded?.status).toBe("succeeded");
      expect(loaded?.tokenUsage?.totalTokens).toBe(150);

      const list = yield* repo.listByWorkItem(WorkItemId.make("wi-1"));
      expect(list).toHaveLength(1);
    }),
  );

  it.effect("latestForWorkItem returns the highest attempt number", () =>
    Effect.gen(function* () {
      const repo = yield* RunAttemptRepository;
      yield* seedWorkItem("wi-2");
      yield* repo.create(yield* makeAttempt("run-2a", "wi-2", 1));
      yield* repo.create(yield* makeAttempt("run-2b", "wi-2", 2));

      const latest = yield* repo.latestForWorkItem(WorkItemId.make("wi-2"));
      expect(latest?.attemptNumber).toBe(2);
    }),
  );

  it.effect("does not overwrite a terminal status with a later one", () =>
    Effect.gen(function* () {
      const repo = yield* RunAttemptRepository;
      yield* seedWorkItem("wi-5");
      const attempt = yield* makeAttempt("run-5", "wi-5", 1);
      yield* repo.create(attempt);

      yield* repo.updateStatus(RunAttemptId.make("run-5"), "succeeded", {
        finishedAt: attempt.startedAt,
      });
      // A late cancelRun arriving after success must not clobber it
      // (fix-lane item 5).
      yield* repo.updateStatus(RunAttemptId.make("run-5"), "user_cancelled", {
        finishedAt: attempt.startedAt,
      });

      const loaded = yield* repo.getById(RunAttemptId.make("run-5"));
      expect(loaded?.status).toBe("succeeded");

      // Re-writing the same terminal status is allowed (idempotent
      // finalizer path).
      yield* repo.updateStatus(RunAttemptId.make("run-5"), "succeeded", {
        finishedAt: attempt.startedAt,
      });
      const stillSucceeded = yield* repo.getById(RunAttemptId.make("run-5"));
      expect(stillSucceeded?.status).toBe("succeeded");
    }),
  );

  it.effect("returns null for a missing attempt", () =>
    Effect.gen(function* () {
      const repo = yield* RunAttemptRepository;
      const missing = yield* repo.getById(RunAttemptId.make("run-missing"));
      expect(missing).toBeNull();
    }),
  );

  it.effect("listRecent returns newest first with optional status filter", () =>
    Effect.gen(function* () {
      const repo = yield* RunAttemptRepository;
      yield* seedWorkItem("wi-3");
      yield* seedWorkItem("wi-4");
      const older = yield* makeAttempt("run-3a", "wi-3", 1);
      const newer = yield* makeAttempt("run-3b", "wi-3", 2);
      const other = yield* makeAttempt("run-4a", "wi-4", 1);
      yield* repo.create({ ...older, startedAt: "2026-01-01T00:00:00.000Z" });
      yield* repo.create({ ...newer, startedAt: "2026-01-02T00:00:00.000Z" });
      yield* repo.create({ ...other, startedAt: "2026-01-03T00:00:00.000Z" });
      yield* repo.updateStatus(RunAttemptId.make("run-3a"), "succeeded", {
        finishedAt: newer.startedAt,
      });

      const recent = yield* repo.listRecent();
      expect(
        recent
          .filter((attempt) => ["run-3a", "run-3b", "run-4a"].includes(String(attempt.id)))
          .map((attempt) => attempt.id),
      ).toEqual(["run-4a", "run-3b", "run-3a"]);

      const succeeded = yield* repo.listRecent({ status: "succeeded" });
      expect(succeeded.map((attempt) => attempt.id)).toContain("run-3a");
      expect(succeeded.map((attempt) => attempt.id)).not.toContain("run-4a");

      const limited = yield* repo.listRecent({ limit: 2 });
      expect(limited).toHaveLength(2);
    }),
  );
});
