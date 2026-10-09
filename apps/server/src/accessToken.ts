/**
 * Stable access token for web-mode `neokod serve`.
 *
 * Resolution order (first match wins): an explicit flag file, the
 * `NEOKOD_ACCESS_TOKEN` environment value, the `<baseDir>/access-token`
 * file, or a freshly generated token persisted for the next launch.
 * This module must not import `config.ts` at runtime (config imports its
 * type) and must not use `ServerSecretStore` (that service needs a
 * `ServerConfig`, which does not exist yet when the token resolves).
 */
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export const ACCESS_TOKEN_MIN_LENGTH = 32;
export const ACCESS_TOKEN_FILE_NAME = "access-token";

export const AccessTokenSource = Schema.Literals(["flag-file", "env", "default-file", "generated"]);
export type AccessTokenSource = typeof AccessTokenSource.Type;

export interface ResolvedAccessToken {
  readonly token: string;
  readonly source: AccessTokenSource;
  readonly filePath: string | undefined;
}

export class AccessTokenError extends Schema.TaggedErrorClass<AccessTokenError>()(
  "AccessTokenError",
  {
    reason: Schema.Literals(["too_short", "invalid_characters", "unreadable", "unwritable"]),
    source: AccessTokenSource,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Access token from ${this.source} is unusable (${this.reason}).`;
  }
}

export const normalizeAccessToken = (
  raw: string,
  source: AccessTokenSource,
): Effect.Effect<string, AccessTokenError> => {
  const token = raw.trim();
  if (token.length < ACCESS_TOKEN_MIN_LENGTH) {
    return Effect.fail(new AccessTokenError({ reason: "too_short", source }));
  }
  if (!/^[\x21-\x7e]+$/.test(token)) {
    return Effect.fail(new AccessTokenError({ reason: "invalid_characters", source }));
  }
  return Effect.succeed(token);
};

const readTokenFile = (
  filePath: string,
  source: AccessTokenSource,
): Effect.Effect<string, AccessTokenError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const contents = yield* fs
      .readFileString(filePath)
      .pipe(
        Effect.mapError((cause) => new AccessTokenError({ reason: "unreadable", source, cause })),
      );
    return yield* normalizeAccessToken(contents, source);
  });

export const resolveAccessToken = Effect.fn("accessToken.resolve")(function* (input: {
  readonly baseDir: string;
  readonly envToken: string | undefined;
  readonly tokenFile: string | undefined;
  readonly generate: boolean;
}): Effect.fn.Return<
  Option.Option<ResolvedAccessToken>,
  AccessTokenError,
  FileSystem.FileSystem | Path.Path
> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (input.tokenFile !== undefined) {
    const token = yield* readTokenFile(input.tokenFile, "flag-file");
    return Option.some({ token, source: "flag-file", filePath: input.tokenFile });
  }
  if (input.envToken !== undefined) {
    const token = yield* normalizeAccessToken(input.envToken, "env");
    return Option.some({ token, source: "env", filePath: undefined });
  }
  const defaultPath = path.join(input.baseDir, ACCESS_TOKEN_FILE_NAME);
  const hasDefaultFile = yield* fs
    .exists(defaultPath)
    .pipe(
      Effect.mapError(
        (cause) => new AccessTokenError({ reason: "unreadable", source: "default-file", cause }),
      ),
    );
  if (hasDefaultFile) {
    const token = yield* readTokenFile(defaultPath, "default-file");
    yield* fs.chmod(defaultPath, 0o600).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("failed to tighten the access token file permissions", {
          filePath: defaultPath,
          cause,
        }),
      ),
    );
    return Option.some({ token, source: "default-file", filePath: defaultPath });
  }
  if (!input.generate) {
    return Option.none();
  }
  const token = NodeCrypto.randomBytes(32).toString("base64url");
  const created = yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fs.open(defaultPath, { flag: "wx", mode: 0o600 });
      yield* file.writeAll(new TextEncoder().encode(token));
      yield* file.sync;
      yield* fs.chmod(defaultPath, 0o600);
    }).pipe(Effect.option),
  );
  if (created._tag === "Some") {
    return Option.some({ token, source: "generated", filePath: defaultPath });
  }
  // The exclusive create failed. If someone else won the race the file now
  // exists: read theirs. Otherwise surface the original failure.
  const existsAfterRace = yield* fs
    .exists(defaultPath)
    .pipe(
      Effect.mapError(
        (cause) => new AccessTokenError({ reason: "unreadable", source: "default-file", cause }),
      ),
    );
  if (existsAfterRace) {
    const raced = yield* readTokenFile(defaultPath, "default-file");
    return Option.some({ token: raced, source: "default-file", filePath: defaultPath });
  }
  return yield* Effect.fail(new AccessTokenError({ reason: "unwritable", source: "generated" }));
});
