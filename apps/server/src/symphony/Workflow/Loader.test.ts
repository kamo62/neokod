import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { WorkflowRepository } from "../Persistence/Services/WorkflowRepository.ts";
import { WorkflowRepositoryLive } from "../Persistence/Layers/WorkflowRepository.ts";
import { WorkflowLoaderService, WorkflowLoaderLive } from "./Loader.ts";

const layer = it.layer(
  WorkflowLoaderLive.pipe(
    Layer.provideMerge(WorkflowRepositoryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const freshRepo = (prefix: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const nonce = yield* Random.nextIntBetween(1_000_000, 9_999_999);
    const dir = yield* fs.makeTempDirectory();
    return { repo: path.join(dir, prefix, `${nonce}`), dir };
  });

const writeWorkflow = (repositoryPath: string, content: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(repositoryPath, { recursive: true });
    yield* fs.writeFileString(path.join(repositoryPath, "WORKFLOW.md"), content);
  });

layer("WorkflowLoader", (it) => {
  it.effect("loads a valid WORKFLOW.md into an active workflow record", () =>
    Effect.gen(function* () {
      const { repo } = yield* freshRepo("wf-load");
      yield* writeWorkflow(
        repo,
        `---
tracker:
  kind: github
  active_states: ["open"]
  terminal_states: ["closed"]
---
Implement the change.
`,
      );
      const loader = yield* WorkflowLoaderService;
      const result = yield* loader.loadWorkflow({ repositoryPath: repo });
      expect(result.errors).toHaveLength(0);
      expect(result.workflow.status).toBe("active");
      expect(result.workflow.effectiveConfig).not.toBeNull();
      expect(result.workflow.definition.promptTemplate).toContain("Implement the change.");

      const workflows = yield* WorkflowRepository;
      const stored = yield* workflows
        .list()
        .pipe(Effect.map((all) => all.find((w) => w.repositoryPath === repo)));
      expect(stored).toBeDefined();
      expect(stored?.status).toBe("active");
    }),
  );

  it.effect("records an invalid workflow as invalid with validation errors", () =>
    Effect.gen(function* () {
      const { repo } = yield* freshRepo("wf-bad");
      yield* writeWorkflow(
        repo,
        `---
tracker:
  kind: not-a-tracker
---
Do it.
`,
      );
      const loader = yield* WorkflowLoaderService;
      const result = yield* loader.loadWorkflow({ repositoryPath: repo });
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.workflow.status).toBe("invalid");
      expect(result.workflow.validationError).not.toBeNull();

      const workflows = yield* WorkflowRepository;
      const stored = yield* workflows
        .list()
        .pipe(Effect.map((all) => all.find((w) => w.repositoryPath === repo)));
      expect(stored?.status).toBe("invalid");
    }),
  );

  it.effect("createWorkflow writes WORKFLOW.md and loads it into an active workflow record", () =>
    Effect.gen(function* () {
      const { repo } = yield* freshRepo("wf-create");
      const loader = yield* WorkflowLoaderService;
      const result = yield* loader.createWorkflow({
        repositoryPath: repo,
        content: `---
tracker:
  kind: github
  active_states: ["open"]
  terminal_states: ["closed"]
---
Implement the change.
`,
      });
      expect(result.validationError).toBeUndefined();

      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const written = yield* fs.readFileString(path.join(repo, "WORKFLOW.md"));
      expect(written).toContain("Implement the change.");

      const workflows = yield* WorkflowRepository;
      const stored = yield* workflows.getById(result.workflowId);
      expect(stored?.status).toBe("active");
    }),
  );

  it.effect(
    "createWorkflow with invalid content still writes the file and records it as invalid",
    () =>
      Effect.gen(function* () {
        const { repo } = yield* freshRepo("wf-create-bad");
        const loader = yield* WorkflowLoaderService;
        const result = yield* loader.createWorkflow({
          repositoryPath: repo,
          content: `---
tracker:
  kind: not-a-tracker
---
Do it.
`,
        });
        expect(result.validationError).toBeDefined();

        const workflows = yield* WorkflowRepository;
        const stored = yield* workflows.getById(result.workflowId);
        expect(stored?.status).toBe("invalid");
      }),
  );

  it.effect(
    "createWorkflow refuses when a WORKFLOW.md already exists, without overwriting it",
    () =>
      Effect.gen(function* () {
        const { repo } = yield* freshRepo("wf-create-exists");
        yield* writeWorkflow(repo, "original content\n");
        const loader = yield* WorkflowLoaderService;
        const outcome = yield* Effect.result(
          loader.createWorkflow({ repositoryPath: repo, content: "new content\n" }),
        );
        expect(outcome._tag).toBe("Failure");

        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stillThere = yield* fs.readFileString(path.join(repo, "WORKFLOW.md"));
        expect(stillThere).toBe("original content\n");
      }),
  );
});
