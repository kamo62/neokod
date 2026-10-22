import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Path from "effect/Path";

import { readWorkspaceIdentityEvidence, workspaceIdentitiesMatch } from "./WorkspaceIdentity.ts";

const layer = it.layer(NodeServices.layer);

layer("WorkspaceIdentity", (it) => {
  it.effect("matches a symlink alias by same-file identity", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-identity-" });
      const target = path.join(root, "target");
      const alias = path.join(root, "alias");
      yield* fs.makeDirectory(target);
      yield* fs.symlink(target, alias);

      const direct = yield* readWorkspaceIdentityEvidence(target);
      const throughAlias = yield* readWorkspaceIdentityEvidence(alias);

      expect(direct.exists).toBe(true);
      expect(workspaceIdentitiesMatch(direct, throughAlias)).toBe("same");
    }),
  );

  it.effect("detects a symlink-parent retarget before removal", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-identity-" });
      const first = path.join(root, "first");
      const second = path.join(root, "second");
      const link = path.join(root, "link");
      yield* fs.makeDirectory(path.join(first, "worktree"), { recursive: true });
      yield* fs.makeDirectory(path.join(second, "worktree"), { recursive: true });
      yield* fs.symlink(first, link);
      const inspected = yield* readWorkspaceIdentityEvidence(path.join(link, "worktree"));

      yield* fs.remove(link);
      yield* fs.symlink(second, link);
      const submitted = yield* readWorkspaceIdentityEvidence(path.join(link, "worktree"));

      expect(inspected.exists).toBe(true);
      expect(submitted.exists).toBe(true);
      expect(inspected.physicalPath).not.toBe(submitted.physicalPath);
      expect(workspaceIdentitiesMatch(inspected, submitted)).toBe("different");
    }),
  );

  it.effect("keeps a physical identity for a missing path via its existing parent", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-identity-" });
      const parent = path.join(root, "parent");
      yield* fs.makeDirectory(parent);
      const missing = path.join(parent, "not-created", "worktree");

      const identity = yield* readWorkspaceIdentityEvidence(missing);

      expect(identity.exists).toBe(false);
      expect(identity.device).toBeNull();
      expect(identity.inode).toBeNull();
      expect(identity.physicalPath.endsWith(path.join("parent", "not-created", "worktree"))).toBe(
        true,
      );
    }),
  );

  it.effect("treats two distinct existing directories as different", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-identity-" });
      const first = path.join(root, "first");
      const second = path.join(root, "second");
      yield* fs.makeDirectory(first);
      yield* fs.makeDirectory(second);

      const firstIdentity = yield* readWorkspaceIdentityEvidence(first);
      const secondIdentity = yield* readWorkspaceIdentityEvidence(second);

      expect(workspaceIdentitiesMatch(firstIdentity, secondIdentity)).toBe("different");
    }),
  );
});
