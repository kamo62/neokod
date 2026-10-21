import { HostProcessPlatform } from "@neokod/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

/**
 * Resolve a path to its physical form, following symlinks. Missing trailing
 * segments are appended to the nearest existing physical parent so a worktree
 * path that has not been created yet can still be compared.
 */
export const resolvePhysicalPath = Effect.fn("resolvePhysicalPath")(function* (value: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const missingSegments: string[] = [];
  let candidate = path.resolve(value);
  while (true) {
    const resolved = yield* fileSystem.realPath(candidate).pipe(
      Effect.map(Option.some),
      Effect.catch((error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(Option.none()) : Effect.fail(error),
      ),
    );
    if (Option.isSome(resolved)) {
      return path.join(resolved.value, ...missingSegments);
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) {
      return candidate;
    }
    missingSegments.unshift(path.basename(candidate));
    candidate = parent;
  }
});

/**
 * The canonical identity used for worktree ownership checks. Windows compares
 * case-insensitively because its filesystem usually does.
 */
export const resolveWorkspaceIdentity = Effect.fn("resolveWorkspaceIdentity")(function* (
  value: string,
) {
  const hostPlatform = yield* HostProcessPlatform;
  const physicalPath = yield* resolvePhysicalPath(value);
  return hostPlatform === "win32" ? physicalPath.toLowerCase() : physicalPath;
});

/**
 * Build an identity resolver from already-provided services so callers that
 * captured them while building a layer do not gain new Effect requirements.
 */
export const makeWorkspaceIdentityResolver = (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly hostPlatform: string;
}) => {
  return (value: string) =>
    resolvePhysicalPath(value).pipe(
      Effect.provideService(FileSystem.FileSystem, input.fileSystem),
      Effect.provideService(Path.Path, input.path),
      Effect.map((physicalPath) =>
        input.hostPlatform === "win32" ? physicalPath.toLowerCase() : physicalPath,
      ),
    );
};
