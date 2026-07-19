import type { ToolLifecycleItemType } from "@neokod/contracts";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";

export type ToolCallIconKind = "terminal" | "eye" | "square-pen" | "search" | "sparkles" | "wrench";

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

export function deriveToolIconKindFromName(name: string | null | undefined): ToolCallIconKind {
  const normalizedName = name?.toLowerCase() ?? "";
  if (/\b(?:bash|shell|exec|terminal)\b/u.test(normalizedName)) return "terminal";
  if (/\b(?:grep|search|glob|find)\b/u.test(normalizedName)) return "search";
  if (/\b(?:read|view|cat)\b/u.test(normalizedName)) return "eye";
  if (/\b(?:edit|write|patch)\b/u.test(normalizedName)) return "square-pen";
  if (/\bskill\b/u.test(normalizedName)) return "sparkles";
  return "wrench";
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
  const segments = formatted.replace(/\\/g, "/").replace(/\/+$/u, "").split("/");
  return segments.slice(-2).join("/") || formatted;
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

export function deriveToolCallAction(
  input: ToolCallLabelInput,
): "command" | "read" | "edit" | "search" | "other" {
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
  // A bare command string (no request-kind/tool-name signal) is still a command;
  // shellLabel refines cat/grep/git into read/search for the row label.
  if (typeof input.command === "string" && input.command.trim().length > 0) return "command";
  return "other";
}

function tokenizeShell(command: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (quote) {
      if (character === quote) quote = null;
      else token += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/u.test(character)) {
      if (token) tokens.push(token);
      token = "";
    } else if (character === "|" || character === ";" || character === "&") {
      if (token) tokens.push(token);
      break;
    } else {
      token += character;
    }
  }
  if (token) tokens.push(token);
  return tokens;
}

function nonFlagShellArguments(args: ReadonlyArray<string>): string[] {
  const valueFlags = new Set([
    "-A",
    "-B",
    "-C",
    "-e",
    "-f",
    "-g",
    "-m",
    "--after-context",
    "--before-context",
    "--context",
    "--file",
    "--glob",
    "--max-count",
    "--regexp",
  ]);
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg.startsWith("-")) {
      if (valueFlags.has(arg)) index += 1;
    } else {
      result.push(arg);
    }
  }
  return result;
}

function shellLabel(command: string): ToolCallLabel {
  const tokens = tokenizeShell(command);
  while (tokens[0] && /^[A-Za-z_][A-Za-z0-9_]*=.*/u.test(tokens[0])) tokens.shift();
  const [verb = "command", ...args] = tokens;
  if (verb === "git") {
    return { verb: "Ran", target: `git${args[0] ? ` ${args[0]}` : ""}`, iconKind: "terminal" };
  }
  if (["cat", "sed", "head", "tail", "less", "more"].includes(verb)) {
    const target = nonFlagShellArguments(args).at(-1);
    return target
      ? { verb: "Read", target, iconKind: "eye" }
      : { verb: "Ran", target: verb, iconKind: "terminal" };
  }
  if (["rg", "grep"].includes(verb)) {
    const query = nonFlagShellArguments(args)[0];
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
  const action = deriveToolCallAction(input);
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
  return {
    verb: input.toolName || input.fallbackLabel,
    iconKind: deriveToolIconKindFromName(input.toolName),
  };
}

export function formatToolCallLabel(label: ToolCallLabel): string {
  return label.target ? `${label.verb} ${label.target}` : label.verb;
}

export function formatInProgressToolLabel(label: ToolCallLabel): string {
  if (label.verb === "Ran") {
    return label.target ? `Running ${label.target}` : "Running command";
  }
  return formatToolCallLabel(label);
}
