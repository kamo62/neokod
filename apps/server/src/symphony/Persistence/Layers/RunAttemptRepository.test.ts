import {
  ProviderDriverKind,
  ProviderInstanceId,
  RunAttemptId,
  SymphonyProjectId,
  WorkflowId,
  WorkItemId,
} from "@neokod/contracts";
import type { AcceptedGuidanceSnapshot, RunAttempt } from "@neokod/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { nowIso } from "../../Domain/Time.ts";
import { WorkItemRepository } from "../Services/WorkItemRepository.ts";
import { WorkItemRepositoryLive } from "./WorkItemRepository.ts";
import {
  RunAttemptRepository,
  validateAcceptedGuidanceSnapshot,
} from "../Services/RunAttemptRepository.ts";
import { RunAttemptRepositoryLive } from "./RunAttemptRepository.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";

const layer = it.layer(
  RunAttemptRepositoryLive.pipe(
    Layer.provideMerge(WorkItemRepositoryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

const seedWorkItem = (
  workItemId: string,
  projectId: SymphonyProjectId = SymphonyProjectId.make("run-attempt-project"),
) =>
  Effect.gen(function* () {
    const repo = yield* WorkItemRepository;
    const now = yield* nowIso;
    yield* repo.upsert({
      id: WorkItemId.make(workItemId),
      mode: "symphony",
      projectId,
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

const makeAcceptedGuidance = (
  overrides: Partial<AcceptedGuidanceSnapshot> = {},
): AcceptedGuidanceSnapshot => ({
  schemaVersion: 1,
  acceptedAt: "2026-10-23T08:00:00.000Z",
  digest: "sha256:accepted",
  workflow: {
    id: WorkflowId.make("wf-1"),
    path: "/repo/WORKFLOW.md",
    revision: "2026-10-22T09:00:00.000Z",
    digest: "sha256:workflow",
    instructions: "Follow the repository contribution policy.",
    validationRequired: ["vp check"],
  },
  source: {
    trackerId: "tracker-1",
    kind: "github",
    externalId: "1",
    externalUrl: "https://example.test/issues/1",
    identifier: "#1",
    title: "Fix the login bug",
    description: null,
    acceptanceCriteria: [],
    labels: ["agent-ready"],
    revision: null,
    digest: "sha256:source",
  },
  guidance: {
    batch: { state: "absent" },
    story: { state: "present", text: "" },
    digest: "sha256:guidance",
  },
  target: {
    repositoryPath: "/repo",
    workflowPath: "/repo/WORKFLOW.md",
    provider: {
      instanceId: ProviderInstanceId.make("codex_default"),
      driver: ProviderDriverKind.make("codex"),
    },
  },
  permission: {
    autonomy: "execute",
    approvalPolicy: "on-request",
    threadSandbox: "workspace-write",
    turnSandboxPolicy: { type: "workspaceWrite" },
    editsAllowed: true,
    approvalsEnabled: true,
    protectedPaths: [],
    delivery: {
      approvalBeforePush: null,
      approvalBeforePullRequest: true,
      approvalBeforeMerge: null,
    },
  },
  ...overrides,
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

  it.effect("latestIdsForProject returns the newest attempt of each item in one project", () =>
    Effect.gen(function* () {
      const repo = yield* RunAttemptRepository;
      const projectId = SymphonyProjectId.make("run-attempt-project-latest");
      yield* seedWorkItem("wi-lp-a", projectId);
      yield* seedWorkItem("wi-lp-b", projectId);
      yield* seedWorkItem("wi-lp-other", SymphonyProjectId.make("other-project"));
      yield* repo.create(yield* makeAttempt("run-lp-a1", "wi-lp-a", 1));
      yield* repo.create(yield* makeAttempt("run-lp-a2", "wi-lp-a", 2));
      yield* repo.create(yield* makeAttempt("run-lp-b1", "wi-lp-b", 1));
      yield* repo.create(yield* makeAttempt("run-lp-other1", "wi-lp-other", 1));

      const latest = yield* repo.latestIdsForProject(projectId);

      expect(
        [...latest].sort((left, right) =>
          String(left.workItemId).localeCompare(String(right.workItemId)),
        ),
      ).toEqual([
        {
          workItemId: WorkItemId.make("wi-lp-a"),
          runAttemptId: RunAttemptId.make("run-lp-a2"),
        },
        {
          workItemId: WorkItemId.make("wi-lp-b"),
          runAttemptId: RunAttemptId.make("run-lp-b1"),
        },
      ]);
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

  it.effect("round-trips accepted guidance and never replaces it", () =>
    Effect.gen(function* () {
      const repo = yield* RunAttemptRepository;
      yield* seedWorkItem("wi-guidance");
      const attempt = yield* makeAttempt("run-guidance", "wi-guidance", 1);
      const acceptedGuidance = makeAcceptedGuidance();

      const created = yield* repo.create({ ...attempt, acceptedGuidance });
      expect(created.acceptedGuidance).toEqual(acceptedGuidance);

      yield* repo.updateStatus(RunAttemptId.make("run-guidance"), "succeeded", {
        finishedAt: attempt.startedAt,
      });
      const afterStatus = yield* repo.getById(RunAttemptId.make("run-guidance"));
      expect(afterStatus?.acceptedGuidance).toEqual(acceptedGuidance);

      const replacement = makeAcceptedGuidance({
        acceptedAt: "2026-10-24T08:00:00.000Z",
        digest: "sha256:replacement",
        guidance: {
          batch: { state: "present", text: "Different guidance." },
          story: { state: "absent" },
          digest: "sha256:replacement-guidance",
        },
      });
      expect(afterStatus).not.toBeNull();
      if (afterStatus === null) {
        throw new Error("expected the run attempt to exist");
      }
      yield* repo.update({
        ...afterStatus,
        currentStage: "review",
        acceptedGuidance: replacement,
      });

      const afterUpdate = yield* repo.getById(RunAttemptId.make("run-guidance"));
      expect(afterUpdate?.currentStage).toBe("review");
      expect(afterUpdate?.acceptedGuidance).toEqual(acceptedGuidance);
    }),
  );

  it.effect("never backfills accepted guidance through update", () =>
    Effect.gen(function* () {
      const repo = yield* RunAttemptRepository;
      yield* seedWorkItem("wi-legacy-guidance");
      const attempt = yield* makeAttempt("run-legacy-guidance", "wi-legacy-guidance", 1);
      yield* repo.create(attempt);

      const legacy = yield* repo.getById(RunAttemptId.make("run-legacy-guidance"));
      expect(legacy?.acceptedGuidance).toBeUndefined();
      if (legacy === null) {
        throw new Error("expected the legacy run attempt to exist");
      }

      yield* repo.update({
        ...legacy,
        acceptedGuidance: makeAcceptedGuidance(),
      });
      const afterUpdate = yield* repo.getById(RunAttemptId.make("run-legacy-guidance"));
      expect(afterUpdate?.acceptedGuidance).toBeUndefined();
    }),
  );

  it.effect("rejects an invalid snapshot at create and on read", () =>
    Effect.gen(function* () {
      const repo = yield* RunAttemptRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* seedWorkItem("wi-invalid-guidance");

      const attempt = yield* makeAttempt("run-invalid-guidance", "wi-invalid-guidance", 1);
      const createError = yield* repo
        .create({
          ...attempt,
          acceptedGuidance: makeAcceptedGuidance({ acceptedAt: "not-a-date" }),
        })
        .pipe(Effect.flip);
      expect(createError._tag).toBe("SymphonyPersistenceDecodeError");
      expect(yield* repo.getById(RunAttemptId.make("run-invalid-guidance"))).toBeNull();

      const valid = yield* repo.create({
        ...attempt,
        acceptedGuidance: makeAcceptedGuidance(),
      });
      expect(valid.id).toBe("run-invalid-guidance");

      yield* sql`
        UPDATE symphony_run_attempts
        SET accepted_guidance_json = '{"schemaVersion":1}'
        WHERE id = 'run-invalid-guidance'
      `;
      const readError = yield* repo
        .getById(RunAttemptId.make("run-invalid-guidance"))
        .pipe(Effect.flip);
      expect(readError._tag).toBe("SymphonyPersistenceDecodeError");
    }),
  );

  it("validates canonical shape, revision timestamps and approval consistency", () => {
    const snapshot = makeAcceptedGuidance();
    expect(validateAcceptedGuidanceSnapshot(snapshot)).toEqual({
      _tag: "valid",
      snapshot,
    });
    expect(
      validateAcceptedGuidanceSnapshot({
        ...snapshot,
        acceptedAt: "2026-10-23T08:00:00.000Z",
      })._tag,
    ).toBe("valid");
    expect(
      validateAcceptedGuidanceSnapshot({ ...snapshot, acceptedAt: "not-a-date" }),
    ).toMatchObject({ _tag: "invalid" });
    expect(
      validateAcceptedGuidanceSnapshot({
        ...snapshot,
        permission: { ...snapshot.permission, approvalsEnabled: false },
      }),
    ).toMatchObject({ _tag: "invalid" });
  });
});
