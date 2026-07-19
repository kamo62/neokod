import type { ToolLifecycleItemType } from "@neokod/contracts";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";

export type ToolCallIconKind = "terminal" | "eye" | "square-pen" | "search" | "wrench";

export interface ToolCallLabelInput {
  readonly toolName?: string | undefined;
  readonly input?: unknown;
  readonly command?: string | undefined;
  readonly changedFiles?: ReadonlyArray<string> | undefined;
  readonly itemType?: ToolLifecycleItemType | undefined;
  readonly requestKind?: "command" | "file-read" | "file-change" | undefined;
  readonly workspaceRoot?: string | undefined;
  readonly fallbackLabel: string;
}

export interface ToolCallLabel {
  readonly verb: string;
  readonly target?: string | undefined;
  readonly iconKind: ToolCallIconKind;
}

export function deriveToolCallResultSummary(input: {
  readonly exitCode?: number | undefined;
}): string | undefined {
  return input.exitCode === undefined ? undefined : `exit ${input.exitCode}`;
}

const MAX_LABEL_DETAIL_LENGTH = 72;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function truncate(value: string): string {
  return value.length <= MAX_LABEL_DETAIL_LENGTH
    ? value
    : `${value.slice(0, MAX_LABEL_DETAIL_LENGTH - 1).trimEnd()}…`;
}

function truncateLeft(value: string): string {
  return value.length <= MAX_LABEL_DETAIL_LENGTH
    ? value
    : `…${value.slice(-(MAX_LABEL_DETAIL_LENGTH - 1)).trimStart()}`;
}

function displayPath(path: string, workspaceRoot: string | undefined): string {
  const formatted = formatWorkspaceRelativePath(path, workspaceRoot);
  if (!/^(?:[A-Za-z]:)?\//.test(formatted)) return formatted;
  return formatted.replace(/\\/g, "/").replace(/\/+$/u, "").split("/").at(-1) || formatted;
}

function structuredValue(input: unknown, keys: ReadonlyArray<string>): string | undefined {
  const record = asRecord(input);
  if (!record) return undefined;
  const direct = firstString(...keys.map((key) => record[key]));
  if (direct) return direct;
  return structuredValue(record.input, keys) ?? structuredValue(record.rawInput, keys);
}

function pathFrom(input: ToolCallLabelInput): string | undefined {
  return (
    firstString(input.changedFiles?.[0]) ??
    structuredValue(input.input, ["path", "filePath", "file_path", "filename", "newPath"])
  );
}

function actionFrom(input: ToolCallLabelInput): "command" | "read" | "edit" | "search" | "other" {
  const name = input.toolName?.toLowerCase() ?? "";
  if (
    input.requestKind === "command" ||
    input.itemType === "command_execution" ||
    /(?:bash|shell|exec|terminal|command)/.test(name)
  ) {
    return "command";
  }
  if (input.requestKind === "file-read" || /(?:read|view|open[_ -]?file)/.test(name)) {
    return "read";
  }
  if (
    input.changedFiles?.length ||
    input.requestKind === "file-change" ||
    input.itemType === "file_change" ||
    /(?:^|[_ -])(edit(?:file)?|write(?:file)?|patch|replace|create|delete|move)(?:$|[_ -])/.test(
      name,
    )
  ) {
    return "edit";
  }
  if (input.itemType === "web_search" || /(?:search|grep|glob|find)/.test(name)) return "search";
  return "other";
}

function shellLabel(command: string): ToolCallLabel {
  const [verb = "command", ...args] = command.trim().split(/\s+/u);
  if (verb === "git") {
    return { verb: "Ran", target: `git${args[0] ? ` ${args[0]}` : ""}`, iconKind: "terminal" };
  }
  if (["cat", "sed", "head", "tail", "less", "more"].includes(verb)) {
    const target = args.find((arg) => !arg.startsWith("-"));
    return target
      ? { verb: "Read", target, iconKind: "eye" }
      : { verb: "Ran", target: verb, iconKind: "terminal" };
  }
  if (["rg", "grep"].includes(verb)) {
    const query = args.find((arg) => !arg.startsWith("-"));
    return query
      ? {
          verb: "Searched",
          target: `\"${truncate(query.replace(/[\"']/g, ""))}\"`,
          iconKind: "search",
        }
      : { verb: "Ran", target: verb, iconKind: "terminal" };
  }
  return { verb: "Ran", target: verb, iconKind: "terminal" };
}

export function deriveToolCallLabel(input: ToolCallLabelInput): ToolCallLabel {
  const action = actionFrom(input);
  const path = pathFrom(input);
  if (action === "command") {
    return input.command
      ? shellLabel(input.command)
      : { verb: "Ran command", iconKind: "terminal" };
  }
  if (action === "read") {
    return {
      verb: path ? "Read" : "Read file",
      ...(path ? { target: truncateLeft(displayPath(path, input.workspaceRoot)) } : {}),
      iconKind: "eye",
    };
  }
  if (action === "edit") {
    return {
      verb: path ? "Edited" : "Edited file",
      ...(path ? { target: truncateLeft(displayPath(path, input.workspaceRoot)) } : {}),
      iconKind: "square-pen",
    };
  }
  if (action === "search") {
    const query = structuredValue(input.input, ["query", "pattern", "searchTerm", "term"]);
    return query
      ? { verb: "Searched", target: `\"${truncate(query)}\"`, iconKind: "search" }
      : { verb: "Searched", iconKind: "search" };
  }
  return { verb: input.toolName || input.fallbackLabel, iconKind: "wrench" };
}

export function formatToolCallLabel(label: ToolCallLabel): string {
  return label.target ? `${label.verb} ${label.target}` : label.verb;
}

export function formatInProgressToolLabel(label: ToolCallLabel): string {
  return label.target
    ? `Running ${label.target}`
    : label.verb === "Ran command"
      ? "Running command"
      : label.verb;
}
