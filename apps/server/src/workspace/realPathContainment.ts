// @effect-diagnostics nodeBuiltinImport:off
/**
 * Containment and write-target resolution for workspace paths.
 *
 * @module realPathContainment
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const errorCode = (cause: unknown): string | undefined =>
  cause instanceof Error && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : undefined;

/** True when `candidate` is inside `realRoot`, or is `realRoot` itself. */
export const isContainedPath = (realRoot: string, candidate: string): boolean => {
  const relative = NodePath.relative(realRoot, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${NodePath.sep}`) &&
      !NodePath.isAbsolute(relative))
  );
};

/**
 * Resolve the canonical path a write should land on, or `null` when the
 * deepest existing ancestor leaves the workspace root.
 *
 * The deepest existing ancestor is resolved with `realpath` and the missing
 * tail is re-appended, because a missing component cannot be a symlink.
 * A dangling symlink is reported as an error rather than treated as missing.
 */
export const resolveWriteTargetWithinRoot = async (
  realRoot: string,
  absolutePath: string,
): Promise<string | null> => {
  let existing = absolutePath;
  const missing: Array<string> = [];
  let realBase: string;
  for (;;) {
    try {
      realBase = await NodeFSP.realpath(existing);
      break;
    } catch (cause) {
      if (errorCode(cause) !== "ENOENT") throw cause;

      // realpath also reports ENOENT for a dangling symlink. Only a path whose
      // own lstat is ENOENT is genuinely missing.
      let linkExists = true;
      try {
        await NodeFSP.lstat(existing);
      } catch (lstatCause) {
        if (errorCode(lstatCause) !== "ENOENT") throw lstatCause;
        linkExists = false;
      }
      if (linkExists) throw cause;

      const parent = NodePath.dirname(existing);
      if (parent === existing) throw cause;
      missing.unshift(NodePath.basename(existing));
      existing = parent;
    }
  }

  if (!isContainedPath(realRoot, realBase)) return null;
  return NodePath.join(realBase, ...missing);
};
