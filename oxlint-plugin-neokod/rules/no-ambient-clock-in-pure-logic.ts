import { defineRule } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.ts";

const normalizePath = (path: string) => path.replaceAll("\\", "/");

const toRepoPath = (filename: string, cwd: string): string => {
  const normalizedFilename = normalizePath(filename);
  const normalizedCwd = normalizePath(cwd).replace(/\/+$/u, "");
  const prefix = `${normalizedCwd}/`;
  return normalizedFilename.startsWith(prefix)
    ? normalizedFilename.slice(prefix.length)
    : normalizedFilename;
};

const isPureLogicFile = (filename: string, cwd: string): boolean =>
  toRepoPath(filename, cwd).endsWith(".logic.ts");

const isMemberCall = (callee: unknown, objectName: string, propertyName: string): boolean => {
  const expression = unwrapExpression(callee);
  if (Option.isNone(expression) || expression.value.type !== "MemberExpression") return false;
  return (
    isIdentifier(unwrapExpression(expression.value.object), objectName) &&
    Option.getOrNull(getPropertyName(expression.value.property)) === propertyName
  );
};

const message =
  "Inject the current time into pure logic; ambient clocks belong at runtime or component boundaries.";

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow ambient clock reads in production *.logic.ts modules while allowing deterministic time conversion.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        if (!isPureLogicFile(context.filename, context.cwd)) return;
        const noArguments = node.arguments.length === 0;
        if (
          noArguments &&
          (isMemberCall(node.callee, "Date", "now") ||
            isMemberCall(node.callee, "performance", "now") ||
            isIdentifier(unwrapExpression(node.callee), "Date"))
        ) {
          context.report({ node, message });
        }
      },
      NewExpression(node) {
        if (!isPureLogicFile(context.filename, context.cwd)) return;
        if (node.arguments.length === 0 && isIdentifier(unwrapExpression(node.callee), "Date")) {
          context.report({ node, message });
        }
      },
    };
  },
});
