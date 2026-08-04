import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { OrchestratorStateRepository } from "../Services/OrchestratorStateRepository.ts";
import { OrchestratorStateRepositoryLive } from "./OrchestratorStateRepository.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";

const layer = it.layer(
  OrchestratorStateRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("OrchestratorStateRepository advisory lock", (it) => {
  it.effect("acquires the lock once and blocks a second owner, then releases", () =>
    Effect.gen(function* () {
      const repo = yield* OrchestratorStateRepository;
      const acquired = yield* repo.acquireLock({ ownerToken: "owner-a", leaseMs: 60_000 });
      expect(acquired).toBe(true);

      const second = yield* repo.acquireLock({ ownerToken: "owner-b", leaseMs: 60_000 });
      expect(second).toBe(false);

      yield* repo.releaseLock("owner-a");
      const afterRelease = yield* repo.acquireLock({ ownerToken: "owner-b", leaseMs: 60_000 });
      expect(afterRelease).toBe(true);
      yield* repo.releaseLock("owner-b");
    }),
  );

  it.effect("blocks a second owner while the lease is live and allows renewal", () =>
    Effect.gen(function* () {
      const repo = yield* OrchestratorStateRepository;
      const acquired = yield* repo.acquireLock({ ownerToken: "owner-a", leaseMs: 60_000 });
      expect(acquired).toBe(true);

      // A second owner cannot acquire while the lease is live.
      const blocked = yield* repo.acquireLock({ ownerToken: "owner-b", leaseMs: 60_000 });
      expect(blocked).toBe(false);

      // The owner can renew; a stranger cannot.
      const stranger = yield* repo.renewLock({ ownerToken: "owner-b", leaseMs: 60_000 });
      expect(stranger).toBe(false);
      const owner = yield* repo.renewLock({ ownerToken: "owner-a", leaseMs: 60_000 });
      expect(owner).toBe(true);

      yield* repo.releaseLock("owner-a");
    }),
  );

  it.effect("renewLock only works for the current owner", () =>
    Effect.gen(function* () {
      const repo = yield* OrchestratorStateRepository;
      yield* repo.acquireLock({ ownerToken: "owner-a", leaseMs: 60_000 });

      const stranger = yield* repo.renewLock({ ownerToken: "owner-b", leaseMs: 60_000 });
      expect(stranger).toBe(false);

      const owner = yield* repo.renewLock({ ownerToken: "owner-a", leaseMs: 60_000 });
      expect(owner).toBe(true);

      yield* repo.releaseLock("owner-a");
    }),
  );

  it.effect("global pause toggles independently of the lock", () =>
    Effect.gen(function* () {
      const repo = yield* OrchestratorStateRepository;
      expect(yield* repo.isGlobalPaused()).toBe(false);
      yield* repo.setGlobalPaused(true);
      expect(yield* repo.isGlobalPaused()).toBe(true);
      yield* repo.setGlobalPaused(false);
      expect(yield* repo.isGlobalPaused()).toBe(false);
    }),
  );
});
