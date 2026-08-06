import { WorkItemId } from "@neokod/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import {
  WorkspaceOwnershipRepository,
  WorkspaceRemovalGuard,
  WorkspaceRemovalBlockedError,
} from "../Services/WorkspaceOwnershipRepository.ts";
import {
  WorkspaceOwnershipRepositoryLive,
  WorkspaceRemovalGuardLive,
} from "./WorkspaceOwnershipRepository.ts";

const layer = it.layer(
  WorkspaceOwnershipRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const guardLayer = it.layer(
  Layer.mergeAll(
    WorkspaceOwnershipRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    WorkspaceRemovalGuardLive.pipe(
      Layer.provide(WorkspaceOwnershipRepositoryLive),
      Layer.provideMerge(SqlitePersistenceMemory),
    ),
  ),
);

layer("Workspace ownership", (it) => {
  it.effect("acquires an unowned workspace", () =>
    Effect.gen(function* () {
      const repo = yield* WorkspaceOwnershipRepository;
      const record = yield* repo.acquire({
        workspacePath: "/ws/a",
        owner: "symphony",
        workItemId: WorkItemId.make("wi-1"),
      });
      expect(record).not.toBeNull();
      expect(record?.owner).toBe("symphony");
      expect(record?.generation).toBe(1);
      expect(record?.workItemId).toBe("wi-1");
    }),
  );

  it.effect("refuses acquire when another owner holds a live lease", () =>
    Effect.gen(function* () {
      const repo = yield* WorkspaceOwnershipRepository;
      yield* repo.acquire({ workspacePath: "/ws/b", owner: "symphony" });
      const taken = yield* repo.acquire({
        workspacePath: "/ws/b",
        owner: "work",
      });
      expect(taken).toBeNull();
    }),
  );

  it.effect("re-acquires a workspace whose lease expired", () =>
    Effect.gen(function* () {
      const repo = yield* WorkspaceOwnershipRepository;
      // TestClock starts at epoch (1970); use a past and a future lease.
      yield* repo.acquire({
        workspacePath: "/ws/c",
        owner: "symphony",
        leaseExpiresAt: "1969-01-01T00:00:00.000Z",
      });
      const record = yield* repo.acquire({
        workspacePath: "/ws/c",
        owner: "work",
        leaseExpiresAt: "2099-01-01T00:00:00.000Z",
      });
      expect(record).not.toBeNull();
      expect(record?.owner).toBe("work");
      expect(record?.generation).toBe(2);
    }),
  );

  it.effect("transfers ownership under the generation fence", () =>
    Effect.gen(function* () {
      const repo = yield* WorkspaceOwnershipRepository;
      const held = yield* repo.acquire({
        workspacePath: "/ws/d",
        owner: "symphony",
        workItemId: WorkItemId.make("wi-1"),
      });
      expect(held).not.toBeNull();
      const generation = held?.generation ?? 0;

      const staleTransfer = yield* repo.transfer({
        workspacePath: "/ws/d",
        owner: "work",
        generation: generation - 1,
      });
      expect(staleTransfer).toBeNull();

      const transferred = yield* repo.transfer({
        workspacePath: "/ws/d",
        owner: "work",
        generation,
        threadId: "th-1",
      });
      expect(transferred?.owner).toBe("work");
      expect(transferred?.generation).toBe(generation + 1);
      expect(transferred?.threadId).toBe("th-1");
      expect(transferred?.workItemId).toBeNull();
    }),
  );

  it.effect("renews a lease under the generation fence", () =>
    Effect.gen(function* () {
      const repo = yield* WorkspaceOwnershipRepository;
      const held = yield* repo.acquire({
        workspacePath: "/ws/e",
        owner: "symphony",
        leaseExpiresAt: "2026-01-01T00:00:00.000Z",
      });
      const generation = held?.generation ?? 0;
      const renewed = yield* repo.renew({
        workspacePath: "/ws/e",
        owner: "symphony",
        generation,
        leaseExpiresAt: "2099-01-01T00:00:00.000Z",
      });
      expect(renewed?.leaseExpiresAt).toBe("2099-01-01T00:00:00.000Z");
    }),
  );

  it.effect("release removes the record", () =>
    Effect.gen(function* () {
      const repo = yield* WorkspaceOwnershipRepository;
      const held = yield* repo.acquire({
        workspacePath: "/ws/f",
        owner: "work",
        threadId: "th-1",
      });
      const generation = held?.generation ?? 0;
      yield* repo.release({ workspacePath: "/ws/f", owner: "work", generation });
      const after = yield* repo.getByWorkspacePath("/ws/f");
      expect(after).toBeNull();
      // A fresh acquire starts a new generation.
      const reacquired = yield* repo.acquire({ workspacePath: "/ws/f", owner: "symphony" });
      expect(reacquired?.generation).toBe(1);
    }),
  );
});

guardLayer("Workspace removal guard", (it) => {
  it.effect("allows removal when no ownership record exists", () =>
    Effect.gen(function* () {
      const guard = yield* WorkspaceRemovalGuard;
      const result = yield* Effect.result(
        guard.assertRemovable({ workspacePath: "/ws/unknown", removingOwner: "work" }),
      );
      expect(result._tag).toBe("Success");
    }),
  );

  it.effect("allows the owning mode to remove its own workspace", () =>
    Effect.gen(function* () {
      const repo = yield* WorkspaceOwnershipRepository;
      yield* repo.acquire({ workspacePath: "/ws/own", owner: "work", threadId: "th-1" });
      const guard = yield* WorkspaceRemovalGuard;
      const result = yield* Effect.result(
        guard.assertRemovable({ workspacePath: "/ws/own", removingOwner: "work" }),
      );
      expect(result._tag).toBe("Success");
    }),
  );

  it.effect("blocks the other mode from removing a live lease", () =>
    Effect.gen(function* () {
      const repo = yield* WorkspaceOwnershipRepository;
      yield* repo.acquire({ workspacePath: "/ws/held", owner: "symphony" });
      const guard = yield* WorkspaceRemovalGuard;
      const result = yield* Effect.result(
        guard.assertRemovable({ workspacePath: "/ws/held", removingOwner: "work" }),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure).toBeInstanceOf(WorkspaceRemovalBlockedError);
      }
    }),
  );

  it.effect("blocks even with an unexpired lease", () =>
    Effect.gen(function* () {
      const repo = yield* WorkspaceOwnershipRepository;
      // TestClock starts at epoch; 2099 is far in the future.
      yield* repo.acquire({
        workspacePath: "/ws/future",
        owner: "symphony",
        leaseExpiresAt: "2099-01-01T00:00:00.000Z",
      });
      const guard = yield* WorkspaceRemovalGuard;
      const result = yield* Effect.result(
        guard.assertRemovable({ workspacePath: "/ws/future", removingOwner: "work" }),
      );
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("allows removal of an expired lease", () =>
    Effect.gen(function* () {
      const repo = yield* WorkspaceOwnershipRepository;
      yield* repo.acquire({
        workspacePath: "/ws/expired",
        owner: "symphony",
        leaseExpiresAt: "1969-01-01T00:00:00.000Z",
      });
      const guard = yield* WorkspaceRemovalGuard;
      const result = yield* Effect.result(
        guard.assertRemovable({ workspacePath: "/ws/expired", removingOwner: "work" }),
      );
      expect(result._tag).toBe("Success");
    }),
  );

  it.effect("force bypasses a live lease", () =>
    Effect.gen(function* () {
      const repo = yield* WorkspaceOwnershipRepository;
      yield* repo.acquire({ workspacePath: "/ws/forced", owner: "symphony" });
      const guard = yield* WorkspaceRemovalGuard;
      const result = yield* Effect.result(
        guard.assertRemovable({
          workspacePath: "/ws/forced",
          removingOwner: "work",
          force: true,
        }),
      );
      expect(result._tag).toBe("Success");
    }),
  );
});
