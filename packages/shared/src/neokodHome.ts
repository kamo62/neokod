import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const resolveNeokodHome = Effect.fn("resolveNeokodHome")(function* (input: {
  readonly configuredHome: string | undefined;
  readonly homeDirectory: string;
  readonly onWarning?: (message: string) => void;
}) {
  const path = yield* Path.Path;
  const configuredHome = input.configuredHome?.trim();
  if (configuredHome) return path.resolve(configuredHome);

  const fileSystem = yield* FileSystem.FileSystem;
  const neokodHome = path.join(input.homeDirectory, ".neokod");
  const legacyHome = path.join(input.homeDirectory, ".t3");
  const [newExists, oldExists] = yield* Effect.all([
    fileSystem.exists(neokodHome).pipe(Effect.orElseSucceed(() => false)),
    fileSystem.exists(legacyHome).pipe(Effect.orElseSucceed(() => false)),
  ]);
  if (newExists) {
    if (oldExists) {
      yield* Effect.sync(() =>
        input.onWarning?.(
          `Both ${neokodHome} and legacy ${legacyHome} exist; using ${neokodHome} without merging.`,
        ),
      );
    }
    return neokodHome;
  }
  if (!oldExists) return neokodHome;

  return yield* fileSystem.rename(legacyHome, neokodHome).pipe(
    Effect.as(neokodHome),
    Effect.catch((error) =>
      Effect.sync(() => {
        input.onWarning?.(
          `Could not migrate legacy state from ${legacyHome} to ${neokodHome}; using ${legacyHome} for this launch. ${error.message}`,
        );
        return legacyHome;
      }),
    ),
  );
});
