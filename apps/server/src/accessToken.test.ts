import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { normalizeAccessToken, resolveAccessToken } from "./accessToken.ts";

const layer = it.layer(NodeServices.layer);

layer("accessToken", (it) => {
  it.effect("rejects a 31 character token", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-access-token-" });
        void dir;
        const error = yield* Effect.flip(normalizeAccessToken("t".repeat(31), "env"));
        assert.strictEqual(error._tag, "AccessTokenError");
        assert.strictEqual(error.reason, "too_short");
        assert.strictEqual(error.source, "env");
        assert.notInclude(error.message, "t".repeat(31));
      }),
    ),
  );

  it.effect("rejects whitespace inside the token", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        normalizeAccessToken(`${"t".repeat(16)} ${"t".repeat(16)}`, "env"),
      );
      assert.strictEqual(error._tag, "AccessTokenError");
      assert.strictEqual(error.reason, "invalid_characters");
    }),
  );

  it.effect("generates 43 characters and writes mode 0600 once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-access-token-" });
        const first = yield* resolveAccessToken({
          baseDir: dir,
          envToken: undefined,
          tokenFile: undefined,
          generate: true,
        });
        assert.isTrue(Option.isSome(first));
        if (Option.isNone(first)) return;
        assert.strictEqual(first.value.token.length, 43);
        assert.strictEqual(first.value.source, "generated");
        const p = path.join(dir, "access-token");
        assert.strictEqual((yield* fs.stat(p)).mode & 0o777, 0o600);
        const second = yield* resolveAccessToken({
          baseDir: dir,
          envToken: undefined,
          tokenFile: undefined,
          generate: true,
        });
        assert.isTrue(Option.isSome(second));
        if (Option.isNone(second)) return;
        assert.strictEqual(second.value.token, first.value.token);
        assert.strictEqual(second.value.source, "default-file");
      }),
    ),
  );

  it.effect("flag file beats env beats default file", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-access-token-" });
        const flagPath = path.join(dir, "flag-token");
        const defaultPath = path.join(dir, "access-token");
        yield* fs.writeFileString(flagPath, "f".repeat(40));
        yield* fs.writeFileString(defaultPath, "d".repeat(40));
        const input = {
          baseDir: dir,
          envToken: "e".repeat(32),
          tokenFile: flagPath,
          generate: true,
        };
        const first = yield* resolveAccessToken(input);
        assert.isTrue(Option.isSome(first));
        if (Option.isNone(first)) return;
        assert.strictEqual(first.value.token, "f".repeat(40));
        assert.strictEqual(first.value.source, "flag-file");
        yield* fs.remove(flagPath);
        const second = yield* resolveAccessToken({ ...input, tokenFile: undefined });
        assert.isTrue(Option.isSome(second));
        if (Option.isNone(second)) return;
        assert.strictEqual(second.value.token, "e".repeat(32));
        assert.strictEqual(second.value.source, "env");
        const third = yield* resolveAccessToken({
          ...input,
          tokenFile: undefined,
          envToken: undefined,
        });
        assert.isTrue(Option.isSome(third));
        if (Option.isNone(third)) return;
        assert.strictEqual(third.value.token, "d".repeat(40));
        assert.strictEqual(third.value.source, "default-file");
      }),
    ),
  );

  it.effect("file with trailing newline is trimmed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-access-token-" });
        const flagPath = path.join(dir, "flag-token");
        yield* fs.writeFileString(flagPath, `${"f".repeat(40)}\n`);
        const resolved = yield* resolveAccessToken({
          baseDir: dir,
          envToken: undefined,
          tokenFile: flagPath,
          generate: false,
        });
        assert.isTrue(Option.isSome(resolved));
        if (Option.isNone(resolved)) return;
        assert.strictEqual(resolved.value.token, "f".repeat(40));
      }),
    ),
  );

  it.effect("read-only policy returns none and creates nothing when no source exists", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-access-token-" });
        const resolved = yield* resolveAccessToken({
          baseDir: dir,
          envToken: undefined,
          tokenFile: undefined,
          generate: false,
        });
        assert.isTrue(Option.isNone(resolved));
        assert.isFalse(yield* fs.exists(path.join(dir, "access-token")));
      }),
    ),
  );

  it.effect("an existing default file is returned when exclusive create loses the race", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-access-token-" });
        yield* fs.writeFileString(path.join(dir, "access-token"), "d".repeat(40));
        const resolved = yield* resolveAccessToken({
          baseDir: dir,
          envToken: undefined,
          tokenFile: undefined,
          generate: true,
        });
        assert.isTrue(Option.isSome(resolved));
        if (Option.isNone(resolved)) return;
        assert.strictEqual(resolved.value.token, "d".repeat(40));
        assert.strictEqual(resolved.value.source, "default-file");
      }),
    ),
  );

  it.effect("an existing default file with mode 0644 is tightened to 0600 on read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "neokod-access-token-" });
        const defaultPath = path.join(dir, "access-token");
        yield* fs.writeFileString(defaultPath, "d".repeat(40));
        yield* fs.chmod(defaultPath, 0o644);
        const resolved = yield* resolveAccessToken({
          baseDir: dir,
          envToken: undefined,
          tokenFile: undefined,
          generate: false,
        });
        assert.isTrue(Option.isSome(resolved));
        if (Option.isNone(resolved)) return;
        assert.strictEqual(resolved.value.token, "d".repeat(40));
        assert.strictEqual(resolved.value.source, "default-file");
        assert.strictEqual((yield* fs.stat(defaultPath)).mode & 0o777, 0o600);
      }),
    ),
  );
});
