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
import * as Stream from "effect/Stream";

import { nowIso } from "../../Domain/Time.ts";
import { RunAttemptRepository } from "../Services/RunAttemptRepository.ts";
import { RunAttemptRepositoryLive } from "./RunAttemptRepository.ts";
import { WorkItemRepository } from "../Services/WorkItemRepository.ts";
import { WorkItemRepositoryLive } from "./WorkItemRepository.ts";
import { RunEventRepository } from "../Services/RunEventRepository.ts";
import { RunEventRepositoryLive } from "./RunEventRepository.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";

const layer = it.layer(
  RunEventRepositoryLive.pipe(
    Layer.provideMerge(RunAttemptRepositoryLive),
    Layer.provideMerge(WorkItemRepositoryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

const seedRunAttempt = (attemptId: string, workItemId: string) =>
  Effect.gen(function* () {
    const workItems = yield* WorkItemRepository;
    const attempts = yield* RunAttemptRepository;
    const now = yield* nowIso;
    yield* workItems.upsert({
      id: WorkItemId.make(workItemId),
      mode: "symphony",
      projectId: SymphonyProjectId.make("run-event-project"),
      objective: "Seed",
      acceptanceCriteria: [],
      source: { kind: "github", externalId: workItemId, externalUrl: "https://example.test" },
      lifecycle: "running",
      trackerIssueId: workItemId,
      blocked: false,
      eligibilityReasons: [],
      evidence: null,
      createdAt: now,
      updatedAt: now,
    });
    yield* attempts.create({
      id: RunAttemptId.make(attemptId),
      workItemId: WorkItemId.make(workItemId),
      attemptNumber: 1,
      workspacePath: "/ws",
      provider: {
        instanceId: ProviderInstanceId.make("codex_default"),
        driver: ProviderDriverKind.make("codex"),
      },
      status: "streaming_turn",
      startedAt: now,
      finishedAt: null,
      error: null,
    } satisfies RunAttempt);
  });

layer("RunEventRepository", (it) => {
  it.effect("appends events with monotonically increasing sequences", () =>
    Effect.gen(function* () {
      const repo = yield* RunEventRepository;
      const attemptId = RunAttemptId.make("run-events-1");
      yield* seedRunAttempt("run-events-1", "wi-events-1");
      const first = yield* repo.append(attemptId, "workspace_created");
      const second = yield* repo.append(attemptId, "agent_started", { pid: 42 });
      expect(second.sequence).toBe(first.sequence + 1);
      expect(second.payload).toEqual({ pid: 42 });

      const events = yield* repo.listForAttempt(attemptId);
      expect(events.map((e) => e.eventType)).toEqual(["workspace_created", "agent_started"]);
    }),
  );

  it.effect("streams events after a sequence cursor", () =>
    Effect.gen(function* () {
      const repo = yield* RunEventRepository;
      const attemptId = RunAttemptId.make("run-events-2");
      yield* seedRunAttempt("run-events-2", "wi-events-2");
      const a = yield* repo.append(attemptId, "a");
      yield* repo.append(attemptId, "b");
      yield* repo.append(attemptId, "c");

      const collected = yield* Stream.runCollect(repo.streamAfter(attemptId, a.sequence, 10));
      const events = Array.from(collected);
      expect(events.map((e) => e.eventType)).toEqual(["b", "c"]);
    }),
  );

  it.effect("lastSequence starts at 0 and tracks appended events", () =>
    Effect.gen(function* () {
      const repo = yield* RunEventRepository;
      const attemptId = RunAttemptId.make("run-events-3");
      yield* seedRunAttempt("run-events-3", "wi-events-3");
      expect(yield* repo.lastSequence(attemptId)).toBe(0);
      const a = yield* repo.append(attemptId, "a");
      expect(yield* repo.lastSequence(attemptId)).toBe(a.sequence);
    }),
  );
});
