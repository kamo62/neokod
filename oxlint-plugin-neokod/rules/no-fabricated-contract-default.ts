import { defineRule } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, unwrapExpression } from "../utils.ts";

const normalizePath = (path: string) => path.replaceAll("\\", "/");

const toRepoPath = (filename: string, cwd: string): string => {
  const normalizedFilename = normalizePath(filename);
  const normalizedCwd = normalizePath(cwd).replace(/\/+$/u, "");
  const prefix = `${normalizedCwd}/`;
  return normalizedFilename.startsWith(prefix)
    ? normalizedFilename.slice(prefix.length)
    : normalizedFilename;
};

const isClientProductionFile = (filename: string, cwd: string): boolean => {
  const path = toRepoPath(filename, cwd);
  const isClientFile = path.startsWith("apps/web/src/") || path.includes("/apps/web/src/");
  return isClientFile && !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path);
};

const isQueryData = (node: unknown): boolean => {
  const expression = unwrapExpression(node);
  if (Option.isNone(expression) || expression.value.type !== "MemberExpression") return false;
  if (Option.getOrNull(getPropertyName(expression.value.property)) !== "data") return false;

  const object = unwrapExpression(expression.value.object);
  return (
    Option.isSome(object) &&
    object.value.type === "Identifier" &&
    object.value.name.endsWith("Query")
  );
};

const isFabricatedDefault = (node: unknown): boolean => {
  const expression = unwrapExpression(node);
  if (Option.isNone(expression)) return false;
  if (expression.value.type === "ObjectExpression") return true;
  return (
    expression.value.type === "Identifier" &&
    /^(?:EMPTY|DEFAULT|FALLBACK)_/u.test(expression.value.name)
  );
};

const message =
  "Preserve missing contract data as unavailable; do not replace query evidence with a fabricated object/default sentinel.";

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow fabricated object defaults for typed client query data without banning ordinary presentation fallbacks.",
    },
  },
  createOnce(context) {
    return {
      LogicalExpression(node) {
        if (!isClientProductionFile(context.filename, context.cwd)) return;
        if (node.operator !== "??" && node.operator !== "||") return;
        if (!isQueryData(node.left) || !isFabricatedDefault(node.right)) return;
        context.report({ node, message });
      },
    };
  },
});
