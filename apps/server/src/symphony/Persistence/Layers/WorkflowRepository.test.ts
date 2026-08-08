import type { WorkflowRecord } from "@neokod/contracts";
import { WorkflowId } from "@neokod/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { WorkflowRepository } from "../Services/WorkflowRepository.ts";
import { WorkflowRepositoryLive } from "./WorkflowRepository.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";

const layer = it.layer(WorkflowRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));
const FIXTURE_AT = "2026-08-05T00:00:00.000Z";

const makeWorkflow = (id: string, repositoryPath: string): WorkflowRecord => ({
  id: WorkflowId.make(id),
  repositoryPath,
  workflowPath: `${repositoryPath}/WORKFLOW.md`,
  status: "draft",
  autonomy: "execute",
  validationError: null,
  definition: {
    config: { tracker: { kind: "github" } },
    promptTemplate: "Implement the issue.",
  },
  effectiveConfig: null,
  enabledAt: null,
  createdAt: FIXTURE_AT,
  updatedAt: FIXTURE_AT,
});

layer("WorkflowRepository", (it) => {
  it.effect("upserts by repository and reads back", () =>
    Effect.gen(function* () {
      const repo = yield* WorkflowRepository;
      const workflow = makeWorkflow("wf-1", "/repo/a");
      const saved = yield* repo.upsert(workflow);
      expect(saved.id).toBe("wf-1");

      const loaded = yield* repo.getByRepository("/repo/a");
      expect(loaded?.workflowPath).toBe("/repo/a/WORKFLOW.md");
      expect(loaded?.definition.promptTemplate).toBe("Implement the issue.");
    }),
  );

  it.effect("updates status and validation error", () =>
    Effect.gen(function* () {
      const repo = yield* WorkflowRepository;
      yield* repo.upsert(makeWorkflow("wf-2", "/repo/b"));
      yield* repo.setStatus(
        WorkflowId.make("wf-2"),
        "invalid",
        "tracker.kind must be one of github, jira, ...",
        null,
      );

      const loaded = yield* repo.getById(WorkflowId.make("wf-2"));
      expect(loaded?.status).toBe("invalid");
      expect(loaded?.validationError).toContain("tracker.kind");
    }),
  );

  it.effect("lists all workflows", () =>
    Effect.gen(function* () {
      const repo = yield* WorkflowRepository;
      yield* repo.upsert(makeWorkflow("wf-3", "/repo/c"));
      yield* repo.upsert(makeWorkflow("wf-4", "/repo/d"));
      const list = yield* repo.list();
      const repos = list.map((w) => w.repositoryPath);
      expect(repos).toContain("/repo/c");
      expect(repos).toContain("/repo/d");
    }),
  );
});
