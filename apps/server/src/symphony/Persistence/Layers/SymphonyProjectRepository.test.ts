import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  SymphonyProjectId,
  type SymphonyProject,
} from "@neokod/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { SymphonyProjectRepository } from "../Services/SymphonyProjectRepository.ts";
import { SymphonyProjectRepositoryLive } from "./SymphonyProjectRepository.ts";

const layer = it.layer(
  SymphonyProjectRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const project = (id: string, codeProjectId: string): SymphonyProject => ({
  id: SymphonyProjectId.make(id),
  codeProjectId: ProjectId.make(codeProjectId),
  title: "Example",
  repositoryPath: `/repo/${id}`,
  status: "paused",
  setupState: "ready",
  configuration: {
    tracker: { kind: "jira", projectKey: "OPS" },
    trackerRequiredLabels: [],
    trackerActiveStates: ["open"],
    trackerTerminalStates: ["done"],
    autonomy: "observe",
    agentProvider: {
      instanceId: ProviderInstanceId.make("codex"),
      driver: ProviderDriverKind.make("codex"),
    },
    validationRequired: [],
    maxConcurrentAgents: 1,
    maxTurns: 20,
    maxAttempts: 3,
    approvalsBeforePush: false,
    approvalsBeforePullRequest: false,
    approvalsBeforeMerge: true,
  },
  revision: 0,
  legacyWorkflowId: null,
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z",
});

layer("SymphonyProjectRepository", (it) => {
  it.effect("enforces one project per Code project and revision-fenced updates", () =>
    Effect.gen(function* () {
      const repository = yield* SymphonyProjectRepository;
      const created = yield* repository.create(project("symphony-a", "code-a"));
      const duplicate = yield* repository.create(project("symphony-b", "code-a"));

      expect(duplicate.id).toBe(created.id);
      expect(yield* repository.list()).toHaveLength(1);

      const updated = yield* repository.update(
        { ...created, title: "Renamed", updatedAt: "2026-08-10T00:01:00.000Z" },
        0,
      );
      expect(updated?.title).toBe("Renamed");
      expect(updated?.revision).toBe(1);

      const stale = yield* repository.update({ ...created, title: "Stale" }, 0);
      expect(stale).toBeNull();
    }),
  );
});
