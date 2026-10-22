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
 * Evidence that a path is the same filesystem object. Device and inode catch
 * symlink and case aliases without assuming every macOS volume is
 * case-insensitive. Missing paths keep the resolved nearest-existing-parent
 * path so a not-yet-created location still has an identity.
 */
export interface WorkspaceIdentityEvidence {
  readonly physicalPath: string;
  readonly exists: boolean;
  readonly device: string | null;
  readonly inode: string | null;
}

const readOptionalStat = (value: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.stat(value).pipe(
      Effect.map(Option.some),
      Effect.catch((error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(Option.none()) : Effect.fail(error),
      ),
    );
  });

export const readWorkspaceIdentityEvidence = Effect.fn("readWorkspaceIdentityEvidence")(function* (
  value: string,
) {
  const physicalPath = yield* resolvePhysicalPath(value);
  const info = yield* readOptionalStat(physicalPath);
  if (Option.isNone(info)) {
    return {
      physicalPath,
      exists: false,
      device: null,
      inode: null,
    } satisfies WorkspaceIdentityEvidence;
  }
  return {
    physicalPath,
    exists: true,
    device: String(info.value.dev),
    inode: Option.match(info.value.ino, {
      onNone: () => null,
      onSome: (inode) => String(inode),
    }),
  } satisfies WorkspaceIdentityEvidence;
});

const fileIdentityMatches = (
  left: WorkspaceIdentityEvidence,
  right: WorkspaceIdentityEvidence,
): boolean =>
  left.device !== null &&
  left.inode !== null &&
  right.device !== null &&
  right.inode !== null &&
  left.device === right.device &&
  left.inode === right.inode;

/**
 * `unknown` means an existing target cannot be proven the same or different.
 * Callers making destructive decisions treat it as a refusal.
 */
export function workspaceIdentitiesMatch(
  left: WorkspaceIdentityEvidence,
  right: WorkspaceIdentityEvidence,
): "same" | "different" | "unknown" {
  if (left.exists || right.exists) {
    if (
      left.device === null ||
      left.inode === null ||
      right.device === null ||
      right.inode === null
    ) {
      return "unknown";
    }
    return fileIdentityMatches(left, right) ? "same" : "different";
  }
  return left.physicalPath === right.physicalPath ? "same" : "different";
}

const isPathSameOrInside = (parent: string, child: string, caseSensitive: boolean): boolean => {
  const left = caseSensitive ? parent : parent.toLowerCase();
  const right = caseSensitive ? child : child.toLowerCase();
  if (left === right) {
    return true;
  }
  const separator = left.includes("\\") && !left.includes("/") ? "\\" : "/";
  const prefix = left.endsWith(separator) ? left : `${left}${separator}`;
  return right.startsWith(prefix);
};

/**
 * True when the candidate workspace is the target worktree or lives inside it.
 * Existing paths are compared by walking canonical ancestors with device and
 * inode evidence, so case-insensitive aliases match without lowercasing every
 * macOS path. Missing paths fall back to the resolved physical path prefix.
 */
export const isWorkspaceSameOrInside = Effect.fn("isWorkspaceSameOrInside")(function* (input: {
  readonly target: WorkspaceIdentityEvidence;
  readonly candidatePath: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hostPlatform = yield* HostProcessPlatform;
  const candidate = yield* readWorkspaceIdentityEvidence(input.candidatePath);
  const match = workspaceIdentitiesMatch(input.target, candidate);
  if (match === "same") {
    return true;
  }

  if (input.target.exists && input.target.device !== null && input.target.inode !== null) {
    let current = candidate.physicalPath;
    while (true) {
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      const info = yield* fileSystem.stat(parent).pipe(
        Effect.map(Option.some),
        Effect.catch((error) =>
          error.reason._tag === "NotFound" ? Effect.succeed(Option.none()) : Effect.fail(error),
        ),
      );
      if (
        Option.isSome(info) &&
        String(info.value.dev) === input.target.device &&
        Option.isSome(info.value.ino) &&
        String(info.value.ino.value) === input.target.inode
      ) {
        return true;
      }
      current = parent;
    }
  }

  return isPathSameOrInside(
    input.target.physicalPath,
    candidate.physicalPath,
    hostPlatform !== "win32",
  );
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
