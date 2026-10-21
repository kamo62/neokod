import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProjectId, ProviderInstanceId, ThreadId } from "@neokod/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import { ServerConfig } from "../config.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import { ProjectionProjectRepositoryLive } from "../persistence/Layers/ProjectionProjects.ts";
import { ProjectionThreadRepositoryLive } from "../persistence/Layers/ProjectionThreads.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  ProjectionProjectRepository,
  type ProjectionProject,
} from "../persistence/Services/ProjectionProjects.ts";
import {
  ProjectionThreadRepository,
  type ProjectionThread,
} from "../persistence/Services/ProjectionThreads.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as ReviewService from "./ReviewService.ts";

const TEST_TIMESTAMP = "2026-01-01T00:00:00.000Z";

type SeedProject = {
  readonly workspaceRoot: string;
  readonly deletedAt?: string | null;
  readonly threadWorktrees?: ReadonlyArray<string>;
  readonly deletedThreadWorktrees?: ReadonlyArray<string>;
};

function makeProjectRow(project: SeedProject, index: number): ProjectionProject {
  return {
    projectId: ProjectId.make(`project-${index}`),
    title: `Project ${index}`,
    workspaceRoot: project.workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    createdAt: TEST_TIMESTAMP,
    updatedAt: TEST_TIMESTAMP,
    deletedAt: project.deletedAt ?? null,
  };
}

function makeThreadRow(
  project: ProjectionProject,
  threadIndex: number,
  worktreePath: string,
  deletedAt: string | null = null,
): ProjectionThread {
  return {
    threadId: ThreadId.make(`${project.projectId}-thread-${threadIndex}`),
    projectId: project.projectId,
    title: `Thread ${threadIndex}`,
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath,
    goal: null,
    goalStatus: "active",
    latestTurnId: null,
    createdAt: TEST_TIMESTAMP,
    updatedAt: TEST_TIMESTAMP,
    archivedAt: null,
    latestUserMessageAt: null,
    pendingApprovalCount: 0,
    pendingUserInputCount: 0,
    hasActionableProposedPlan: 0,
    workerCount: 0,
    deletedAt,
  };
}

const seedProjectsLayer = (projects: ReadonlyArray<SeedProject>) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const projectRepository = yield* ProjectionProjectRepository;
      const threadRepository = yield* ProjectionThreadRepository;
      yield* Effect.forEach(
        projects,
        (project, projectIndex) =>
          Effect.gen(function* () {
            const projectRow = makeProjectRow(project, projectIndex);
            yield* projectRepository.upsert(projectRow);
            const liveWorktrees = project.threadWorktrees ?? [];
            yield* Effect.forEach(
              liveWorktrees,
              (worktreePath, threadIndex) =>
                threadRepository.upsert(makeThreadRow(projectRow, threadIndex, worktreePath)),
              { concurrency: 1 },
            );
            yield* Effect.forEach(
              project.deletedThreadWorktrees ?? [],
              (worktreePath, threadIndex) =>
                threadRepository.upsert(
                  makeThreadRow(
                    projectRow,
                    liveWorktrees.length + threadIndex,
                    worktreePath,
                    TEST_TIMESTAMP,
                  ),
                ),
              { concurrency: 1 },
            );
          }),
        { concurrency: 1 },
      );
    }).pipe(Effect.orDie),
  );

function makeLayer(input: {
  readonly workspaceRoot: string;
  readonly baseDir: string;
  readonly detectCalls?: Array<{ readonly cwd: string }>;
  readonly projects?: ReadonlyArray<SeedProject>;
  readonly failProjectRegistry?: boolean;
}) {
  const projectRepositoryLayer = input.failProjectRegistry
    ? Layer.mock(ProjectionProjectRepository)({
        listAll: () =>
          Effect.fail(
            new PersistenceSqlError({
              operation: "test.ProjectionProjectRepository.listAll",
              detail: "registry unavailable",
            }),
          ),
      })
    : ProjectionProjectRepositoryLive;
  const persistenceLayer = Layer.mergeAll(
    projectRepositoryLayer,
    ProjectionThreadRepositoryLive,
  ).pipe(Layer.provideMerge(SqlitePersistenceMemory));
  const seededPersistenceLayer = seedProjectsLayer(input.projects ?? []).pipe(
    Layer.provideMerge(persistenceLayer),
  );

  return ReviewService.layer.pipe(
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        get: () => Effect.die("unexpected VCS registry get"),
        resolve: () => Effect.die("unexpected VCS registry resolve"),
        detect: (request) =>
          Effect.sync(() => {
            input.detectCalls?.push({ cwd: request.cwd });
            return null;
          }),
      }),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(ServerConfig.layerTest(input.workspaceRoot, input.baseDir)),
    Layer.provide(seededPersistenceLayer),
    Layer.provideMerge(NodeServices.layer),
  );
}

describe("ReviewService", () => {
  it.effect("rejects diff preview cwd outside the configured workspace roots", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "neokod-review-workspace-",
      });
      const outsideRoot = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-review-outside-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: outsideRoot }).pipe(Effect.flip);
      }).pipe(Effect.provide(makeLayer({ workspaceRoot, baseDir, detectCalls })));

      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      assert.strictEqual(error.operation, "ReviewService.getDiffPreview");
      assert.match(
        "detail" in error ? error.detail : "",
        /must be inside the server workspace, a registered project or one of its worktrees/,
      );
      assert.deepStrictEqual(detectCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows diff preview cwd inside the configured workspace root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "neokod-review-workspace-",
      });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const result = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: workspaceRoot });
      }).pipe(Effect.provide(makeLayer({ workspaceRoot, baseDir, detectCalls })));

      assert.strictEqual(result.cwd, workspaceRoot);
      assert.deepStrictEqual(result.sources, []);
      assert.deepStrictEqual(detectCalls, [{ cwd: workspaceRoot }]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows a registered project root outside the server workspace", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "neokod-review-workspace-",
      });
      const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-review-project-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const result = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: projectRoot });
      }).pipe(
        Effect.provide(
          makeLayer({
            workspaceRoot,
            baseDir,
            detectCalls,
            projects: [{ workspaceRoot: projectRoot }],
          }),
        ),
      );

      assert.strictEqual(result.cwd, projectRoot);
      assert.deepStrictEqual(result.sources, []);
      assert.deepStrictEqual(detectCalls, [{ cwd: projectRoot }]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a path that is not registered", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "neokod-review-workspace-",
      });
      const registeredRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "neokod-review-registered-",
      });
      const unregisteredRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "neokod-review-unregistered-",
      });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: unregisteredRoot }).pipe(Effect.flip);
      }).pipe(
        Effect.provide(
          makeLayer({
            workspaceRoot,
            baseDir,
            detectCalls,
            projects: [{ workspaceRoot: registeredRoot }],
          }),
        ),
      );

      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      assert.strictEqual(error.operation, "ReviewService.getDiffPreview");
      assert.deepStrictEqual(detectCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a deleted project root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "neokod-review-workspace-",
      });
      const deletedProjectRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "neokod-review-deleted-",
      });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: deletedProjectRoot }).pipe(Effect.flip);
      }).pipe(
        Effect.provide(
          makeLayer({
            workspaceRoot,
            baseDir,
            detectCalls,
            projects: [{ workspaceRoot: deletedProjectRoot, deletedAt: TEST_TIMESTAMP }],
          }),
        ),
      );

      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      assert.deepStrictEqual(detectCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows a thread worktree outside the worktrees directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "neokod-review-workspace-",
      });
      const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-review-project-" });
      const threadWorktree = yield* fs.makeTempDirectoryScoped({
        prefix: "neokod-review-thread-worktree-",
      });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const result = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: threadWorktree });
      }).pipe(
        Effect.provide(
          makeLayer({
            workspaceRoot,
            baseDir,
            detectCalls,
            projects: [{ workspaceRoot: projectRoot, threadWorktrees: [threadWorktree] }],
          }),
        ),
      );

      assert.strictEqual(result.cwd, threadWorktree);
      assert.deepStrictEqual(detectCalls, [{ cwd: threadWorktree }]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a deleted thread worktree", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "neokod-review-workspace-",
      });
      const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-review-project-" });
      const deletedWorktree = yield* fs.makeTempDirectoryScoped({
        prefix: "neokod-review-deleted-worktree-",
      });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: deletedWorktree }).pipe(Effect.flip);
      }).pipe(
        Effect.provide(
          makeLayer({
            workspaceRoot,
            baseDir,
            detectCalls,
            projects: [
              {
                workspaceRoot: projectRoot,
                deletedThreadWorktrees: [deletedWorktree],
              },
            ],
          }),
        ),
      );

      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      assert.deepStrictEqual(detectCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not accept a sibling directory with the same prefix", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "neokod-review-workspace-",
      });
      const parentDir = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-review-parent-" });
      const projectRoot = path.join(parentDir, "app");
      const siblingRoot = path.join(parentDir, "app-evil");
      yield* fs.makeDirectory(projectRoot);
      yield* fs.makeDirectory(siblingRoot);
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: siblingRoot }).pipe(Effect.flip);
      }).pipe(
        Effect.provide(
          makeLayer({
            workspaceRoot,
            baseDir,
            detectCalls,
            projects: [{ workspaceRoot: projectRoot }],
          }),
        ),
      );

      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      assert.deepStrictEqual(detectCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a symlink that escapes a registered project root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "neokod-review-workspace-",
      });
      const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-review-project-" });
      const outsideRoot = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-review-outside-" });
      const escapingLink = path.join(projectRoot, "escaping-link");
      yield* fs.symlink(outsideRoot, escapingLink);
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: escapingLink }).pipe(Effect.flip);
      }).pipe(
        Effect.provide(
          makeLayer({
            workspaceRoot,
            baseDir,
            detectCalls,
            projects: [{ workspaceRoot: projectRoot }],
          }),
        ),
      );

      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      assert.deepStrictEqual(detectCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves a typed failure when the project registry cannot be read", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "neokod-review-workspace-",
      });
      const outsideRoot = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-review-outside-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: outsideRoot }).pipe(Effect.flip);
      }).pipe(
        Effect.provide(
          makeLayer({ workspaceRoot, baseDir, detectCalls, failProjectRegistry: true }),
        ),
      );

      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      if (error._tag !== "VcsRepositoryDetectionError") return;
      assert.strictEqual(error.operation, "ReviewService.assertWorkspaceBoundCwd.registeredRoots");
      assert.match(error.detail, /Failed to read registered project roots/);
      assert.instanceOf(error.cause, PersistenceSqlError);
      assert.deepStrictEqual(detectCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves unexpected path-resolution failures", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "neokod-review-workspace-",
      });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-review-base-" });
      const invalidCwd = `${workspaceRoot}\0invalid`;
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: invalidCwd }).pipe(Effect.flip);
      }).pipe(Effect.provide(makeLayer({ workspaceRoot, baseDir, detectCalls })));

      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      if (error._tag !== "VcsRepositoryDetectionError") return;
      assert.strictEqual(error.operation, "ReviewService.assertWorkspaceBoundCwd.canonicalizePath");
      assert.strictEqual(error.cwd, invalidCwd);
      assert.match(error.detail, /Failed to resolve a path/);
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.deepStrictEqual(detectCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
