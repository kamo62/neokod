import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Path from "effect/Path";

import {
  WorktreeAdmissionBlockedError,
  WorktreeRemovalLease,
  WorktreeRemovalLeaseConflictError,
  WorktreeRemovalLeaseLive,
} from "./WorktreeRemovalLease.ts";
import { readWorkspaceIdentityEvidence } from "../vcs/WorkspaceIdentity.ts";

const layer = it.layer(WorktreeRemovalLeaseLive.pipe(Layer.provideMerge(NodeServices.layer)));

const admission = (
  workspacePaths: readonly string[],
  preparedWorktreePaths: readonly string[] = [],
) => ({ workspacePaths, preparedWorktreePaths }) as const;

layer("WorktreeRemovalLease", (it) => {
  it.effect("blocks admission of the reserved target and paths inside it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-lease-" });
      const target = path.join(root, "worktree");
      const nested = path.join(target, "packages", "app");
      const unrelated = path.join(root, "other");
      yield* fs.makeDirectory(nested, { recursive: true });
      yield* fs.makeDirectory(unrelated, { recursive: true });

      const lease = yield* WorktreeRemovalLease;
      const identity = yield* readWorkspaceIdentityEvidence(target);

      yield* lease.withRemovalReservation(
        identity,
        Effect.gen(function* () {
          const exact = yield* lease
            .withAdmission("thread.create", admission([target]), Effect.succeed("admitted"))
            .pipe(Effect.flip);
          expect(exact).toBeInstanceOf(WorktreeAdmissionBlockedError);

          const descendant = yield* lease
            .withAdmission("thread.meta.update", admission([nested]), Effect.succeed("admitted"))
            .pipe(Effect.flip);
          expect(descendant).toBeInstanceOf(WorktreeAdmissionBlockedError);

          const allowed = yield* lease.withAdmission(
            "thread.create",
            admission([unrelated]),
            Effect.succeed("admitted"),
          );
          expect(allowed).toBe("admitted");
        }),
      );

      const afterRelease = yield* lease.withAdmission(
        "thread.create",
        admission([target]),
        Effect.succeed("admitted"),
      );
      expect(afterRelease).toBe("admitted");
      expect(yield* lease.hasReservations).toBe(false);
    }),
  );

  it.effect("blocks admission in a parent of the reserved target", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-lease-" });
      const target = path.join(root, "worktree");
      const sibling = path.join(root, "other");
      yield* fs.makeDirectory(target, { recursive: true });
      yield* fs.makeDirectory(sibling, { recursive: true });

      const lease = yield* WorktreeRemovalLease;
      const identity = yield* readWorkspaceIdentityEvidence(target);

      yield* lease.withRemovalReservation(
        identity,
        Effect.gen(function* () {
          const parent = yield* lease
            .withAdmission("thread.turn.start", admission([root]), Effect.succeed("admitted"))
            .pipe(Effect.flip);
          expect(parent).toBeInstanceOf(WorktreeAdmissionBlockedError);

          const allowed = yield* lease.withAdmission(
            "thread.turn.start",
            admission([sibling]),
            Effect.succeed("admitted"),
          );
          expect(allowed).toBe("admitted");
        }),
      );
    }),
  );

  it.effect("refuses overlapping reservations and releases on completion", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-lease-" });
      const target = path.join(root, "worktree");
      yield* fs.makeDirectory(target, { recursive: true });
      const lease = yield* WorktreeRemovalLease;
      const identity = yield* readWorkspaceIdentityEvidence(target);

      yield* lease.withRemovalReservation(
        identity,
        Effect.gen(function* () {
          expect(yield* lease.hasReservations).toBe(true);
          const conflict = yield* lease
            .withRemovalReservation(identity, Effect.succeed("second"))
            .pipe(Effect.flip);
          expect(conflict).toBeInstanceOf(WorktreeRemovalLeaseConflictError);
        }),
      );

      expect(yield* lease.hasReservations).toBe(false);
    }),
  );

  it.effect("matches an alias of the reserved target by same-file identity", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-lease-" });
      const target = path.join(root, "worktree");
      const alias = path.join(root, "alias");
      yield* fs.makeDirectory(target, { recursive: true });
      yield* fs.symlink(target, alias);
      const lease = yield* WorktreeRemovalLease;
      const identity = yield* readWorkspaceIdentityEvidence(target);

      yield* lease.withRemovalReservation(
        identity,
        Effect.gen(function* () {
          const blocked = yield* lease
            .withAdmission("thread.create", admission([alias]), Effect.succeed("admitted"))
            .pipe(Effect.flip);
          expect(blocked).toBeInstanceOf(WorktreeAdmissionBlockedError);
        }),
      );
    }),
  );

  it.effect("rejects a missing worktree even without a prepared record", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-lease-" });
      const missing = path.join(root, "never-created");
      const lease = yield* WorktreeRemovalLease;

      const blocked = yield* lease
        .withAdmission("thread.create", admission([missing], [missing]), Effect.succeed("admitted"))
        .pipe(Effect.flip);

      expect(blocked).toBeInstanceOf(WorktreeAdmissionBlockedError);
      expect(blocked.message).toContain("does not exist");
    }),
  );

  it.effect("rejects a prepared worktree removed before attachment", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-lease-" });
      const target = path.join(root, "worktree");
      yield* fs.makeDirectory(target, { recursive: true });
      const lease = yield* WorktreeRemovalLease;
      yield* lease.recordPreparedWorktree(target);

      yield* fs.remove(target, { recursive: true });
      const blocked = yield* lease
        .withAdmission("thread.create", admission([target], [target]), Effect.succeed("admitted"))
        .pipe(Effect.flip);

      expect(blocked).toBeInstanceOf(WorktreeAdmissionBlockedError);
      expect(blocked.message).toContain("does not exist");
    }),
  );

  it.effect("clears a prepared record after a successful removal", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-lease-" });
      const target = path.join(root, "worktree");
      yield* fs.makeDirectory(target, { recursive: true });
      const lease = yield* WorktreeRemovalLease;
      yield* lease.recordPreparedWorktree(target);
      const identity = yield* readWorkspaceIdentityEvidence(target);

      yield* lease.withRemovalReservation(identity, Effect.void);
      yield* fs.rename(target, path.join(root, "removed-original"));
      yield* fs.makeDirectory(target, { recursive: true });

      const admitted = yield* lease.withAdmission(
        "thread.create",
        admission([target], [target]),
        Effect.succeed("admitted"),
      );
      expect(admitted).toBe("admitted");
    }),
  );

  it.effect("rejects a prepared worktree replaced at the same path", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-lease-" });
      const target = path.join(root, "worktree");
      yield* fs.makeDirectory(target, { recursive: true });
      const lease = yield* WorktreeRemovalLease;
      yield* lease.recordPreparedWorktree(target);

      yield* fs.rename(target, path.join(root, "replaced-original"));
      yield* fs.makeDirectory(target, { recursive: true });
      const blocked = yield* lease
        .withAdmission("thread.create", admission([target], [target]), Effect.succeed("admitted"))
        .pipe(Effect.flip);

      expect(blocked).toBeInstanceOf(WorktreeAdmissionBlockedError);
      expect(blocked.message).toContain("removed or replaced");
    }),
  );
});
