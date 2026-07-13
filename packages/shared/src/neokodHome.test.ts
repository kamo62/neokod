import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolveNeokodHome } from "./neokodHome.ts";

describe("resolveNeokodHome", () => {
  it.layer(NodeServices.layer)("handles every default-home migration branch", (it) => {
    const resolve = (homeDirectory: string, warnings: string[]) =>
      resolveNeokodHome({
        configuredHome: undefined,
        homeDirectory,
        onWarning: (message) => warnings.push(message),
      });

    it.effect("uses the new directory when it exists", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-home-new-" });
        const newHome = path.join(home, ".neokod");
        yield* fs.makeDirectory(newHome);
        assert.equal(yield* resolve(home, []), newHome);
      }),
    );

    it.effect("migrates the old directory when it is the only one", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-home-migrate-" });
        const oldHome = path.join(home, ".t3");
        const newHome = path.join(home, ".neokod");
        yield* fs.makeDirectory(oldHome);
        assert.equal(yield* resolve(home, []), newHome);
        assert.isFalse(yield* fs.exists(oldHome));
        assert.isTrue(yield* fs.exists(newHome));
      }),
    );

    it.effect("uses the new directory without merging when both exist", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-home-both-" });
        const newHome = path.join(home, ".neokod");
        const oldHome = path.join(home, ".t3");
        yield* fs.makeDirectory(newHome);
        yield* fs.makeDirectory(oldHome);
        const warnings: string[] = [];
        assert.equal(yield* resolve(home, warnings), newHome);
        assert.isTrue(yield* fs.exists(oldHome));
        assert.lengthOf(warnings, 1);
      }),
    );

    it.effect("keeps the legacy directory when migration fails", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-home-failure-" });
        const oldHome = path.join(home, ".t3");
        yield* fs.makeDirectory(oldHome);
        const warnings: string[] = [];
        const failingFileSystem = new Proxy(fs, {
          get(target, property, receiver) {
            if (property === "rename") return () => Effect.fail({ message: "rename failed" } as never);
            return Reflect.get(target, property, receiver);
          },
        });
        assert.equal(
          yield* resolve(home, warnings).pipe(
            Effect.provideService(FileSystem.FileSystem, failingFileSystem),
          ),
          oldHome,
        );
        assert.lengthOf(warnings, 1);
      }),
    );
  });
});
