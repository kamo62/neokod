import { defineRule } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.ts";

const SERVER_TIMESTAMP_FIELDS = new Set([
  "completedAt",
  "createdAt",
  "generatedAt",
  "observedAt",
  "requestedAt",
  "startedAt",
  "updatedAt",
]);

const normalizePath = (path: string) => path.replaceAll("\\", "/");

const toRepoPath = (filename: string, cwd: string): string => {
  const normalizedFilename = normalizePath(filename);
  const normalizedCwd = normalizePath(cwd).replace(/\/+$/u, "");
  const prefix = `${normalizedCwd}/`;
  return normalizedFilename.startsWith(prefix)
    ? normalizedFilename.slice(prefix.length)
    : normalizedFilename;
};

const isClientServerPayloadModule = (filename: string, cwd: string): boolean => {
  const path = toRepoPath(filename, cwd);
  const clientMarker = "/apps/web/src/";
  const markerIndex = path.lastIndexOf(clientMarker);
  const clientPath = markerIndex >= 0 ? path.slice(markerIndex + 1) : path;
  if (
    !clientPath.startsWith("apps/web/src/") ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(clientPath)
  ) {
    return false;
  }
  return (
    clientPath.startsWith("apps/web/src/state/") ||
    clientPath.startsWith("apps/web/src/rpc/") ||
    /(?:Command|Mutation|Request)s?\.[cm]?[jt]s$/u.test(clientPath)
  );
};

const isDateNowCall = (node: unknown): boolean => {
  const expression = unwrapExpression(node);
  if (Option.isNone(expression) || expression.value.type !== "CallExpression") return false;
  const callee = unwrapExpression(expression.value.callee);
  if (Option.isNone(callee) || callee.value.type !== "MemberExpression") return false;
  return (
    isIdentifier(unwrapExpression(callee.value.object), "Date") &&
    Option.getOrNull(getPropertyName(callee.value.property)) === "now" &&
    expression.value.arguments.length === 0
  );
};

const isAmbientDateConstruction = (node: unknown): boolean => {
  const expression = unwrapExpression(node);
  if (Option.isNone(expression) || expression.value.type !== "NewExpression") return false;
  if (!isIdentifier(unwrapExpression(expression.value.callee), "Date")) return false;
  return expression.value.arguments.length === 0 || expression.value.arguments.some(isDateNowCall);
};

const isAmbientTimestamp = (node: unknown): boolean => {
  if (isDateNowCall(node) || isAmbientDateConstruction(node)) return true;

  const expression = unwrapExpression(node);
  if (Option.isNone(expression) || expression.value.type !== "CallExpression") return false;
  const callee = unwrapExpression(expression.value.callee);
  if (Option.isNone(callee) || callee.value.type !== "MemberExpression") return false;
  return (
    Option.getOrNull(getPropertyName(callee.value.property)) === "toISOString" &&
    isAmbientDateConstruction(callee.value.object)
  );
};

const message =
  "Do not author server-owned timestamps in the client; omit the field or send explicitly named local metadata.";

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow ambient client timestamps in server payload modules without banning local component clocks.",
    },
  },
  createOnce(context) {
    return {
      Property(node) {
        if (!isClientServerPayloadModule(context.filename, context.cwd)) return;
        const propertyName = getPropertyName(node.key);
        if (
          Option.isNone(propertyName) ||
          !SERVER_TIMESTAMP_FIELDS.has(propertyName.value) ||
          !isAmbientTimestamp(node.value)
        ) {
          return;
        }
        context.report({ node, message });
      },
    };
  },
});
