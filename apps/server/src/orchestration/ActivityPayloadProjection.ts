/**
 * ActivityPayloadProjection - Transport-side pruning of thread activity payloads.
 *
 * Tool activities embed the provider's raw item data: Codex ships the whole
 * item notification (aggregated command output, file-change patches), the
 * Claude adapter attaches the full tool_result block, and ACP providers attach
 * content and location arrays. The full payload stays in the event store and
 * projection tables; this module trims what goes over the websocket and HTTP
 * transports down to the fields the web client reads.
 *
 * Keep-list, matched field by field against the web client:
 * - `data.command`, `data.input.command`, `data.rawInput.command`,
 *   `data.item.command`, `data.item.input.command`, `data.item.result.command`
 *   feed `extractToolCommand` (apps/web/src/session-logic.ts).
 * - `data.input` and `data.rawInput` are kept whole: the expanded tool call
 *   renders the full input (`buildToolCallExpandedBody` in
 *   apps/web/src/components/chat/MessagesTimeline.logic.ts).
 * - `data.rawOutput` is kept whole: the expanded tool call renders the full
 *   output, and `summarizeToolRawOutput` reads its content/stdout/totalFiles.
 * - `data.toolName` and `data.kind` feed `entry.toolName` and
 *   `deriveToolCallAction`.
 * - `data.toolCallId` feeds tool lifecycle collapsing.
 * - `data.item.result.exitCode` feeds `extractToolExitCode`.
 * - Path-like values anywhere under `data` feed `extractChangedFiles`; the
 *   server-side walk below collects them from the full payload and re-emits
 *   them as `files: [{ path }]`, which the client's walk still finds.
 * - `mcp_tool_call` payloads pass through untouched: the client renders
 *   `data.item` verbatim.
 *
 * Everything else under `data` (Codex `item` bulk, Claude `result` blocks, ACP
 * `content`/`locations`) is dropped from the wire.
 */
import type {
  OrchestrationEvent,
  OrchestrationThreadActivity,
  OrchestrationThreadDetailSnapshot,
} from "@neokod/contracts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function pushChangedFile(target: string[], seen: Set<string>, value: unknown): void {
  const normalized = asTrimmedString(value);
  if (!normalized || seen.has(normalized)) {
    return;
  }
  seen.add(normalized);
  target.push(normalized);
}

/**
 * Mirrors the walk in the web client's `collectChangedFiles` (same key list,
 * same depth and count caps) so the collected paths match what the client
 * would have derived from the full payload.
 */
function collectChangedFiles(
  value: unknown,
  target: string[],
  seen: Set<string>,
  depth: number,
): void {
  if (depth > 4 || target.length >= 12) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectChangedFiles(entry, target, seen, depth + 1);
      if (target.length >= 12) {
        return;
      }
    }
    return;
  }

  const record = asRecord(value);
  if (!record) {
    return;
  }

  pushChangedFile(target, seen, record.path);
  pushChangedFile(target, seen, record.filePath);
  pushChangedFile(target, seen, record.relativePath);
  pushChangedFile(target, seen, record.filename);
  pushChangedFile(target, seen, record.newPath);
  pushChangedFile(target, seen, record.oldPath);

  for (const nestedKey of [
    "item",
    "result",
    "input",
    "data",
    "changes",
    "files",
    "edits",
    "patch",
    "patches",
    "operations",
  ]) {
    if (!(nestedKey in record)) {
      continue;
    }
    collectChangedFiles(record[nestedKey], target, seen, depth + 1);
    if (target.length >= 12) {
      return;
    }
  }
}

/**
 * Projects the nested provider item (Codex item notifications) down to the
 * command fields and exit code the client reads.
 */
function projectItemData(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const item = asRecord(data.item);
  if (!item) {
    return undefined;
  }

  const projectedItem: Record<string, unknown> = {};
  if ("command" in item) {
    projectedItem.command = item.command;
  }

  const input = asRecord(item.input);
  if (input && "command" in input) {
    projectedItem.input = { command: input.command };
  }

  const result = asRecord(item.result);
  if (result) {
    const projectedResult: Record<string, unknown> = {};
    if ("command" in result) {
      projectedResult.command = result.command;
    }
    if ("exitCode" in result) {
      projectedResult.exitCode = result.exitCode;
    }
    if (Object.keys(projectedResult).length > 0) {
      projectedItem.result = projectedResult;
    }
  }

  return Object.keys(projectedItem).length > 0 ? projectedItem : undefined;
}

const KEPT_TOP_LEVEL_DATA_KEYS = [
  "command",
  "toolName",
  "kind",
  "toolCallId",
  "input",
  "rawInput",
  "rawOutput",
] as const;

/**
 * Removes activity payload fields that no current client reads while retaining
 * the full payload in persistence and the event store.
 */
export function projectActivityPayload(
  activity: OrchestrationThreadActivity,
): OrchestrationThreadActivity {
  const payload = asRecord(activity.payload);
  const data = asRecord(payload?.data);
  if (!payload || !data || payload.itemType === "mcp_tool_call") {
    return activity;
  }

  const projectedData: Record<string, unknown> = {};
  const item = projectItemData(data);
  if (item) {
    projectedData.item = item;
  }
  for (const key of KEPT_TOP_LEVEL_DATA_KEYS) {
    if (key in data) {
      projectedData[key] = data[key];
    }
  }

  const changedFiles: string[] = [];
  collectChangedFiles(data, changedFiles, new Set<string>(), 0);
  if (changedFiles.length > 0) {
    // The client discovers file names by walking objects with path-like keys.
    projectedData.files = changedFiles.map((path) => ({ path }));
  }

  return {
    ...activity,
    payload: {
      ...payload,
      data: projectedData,
    },
  };
}

/**
 * Matches the validity rule in the web client's
 * `deriveLatestContextWindowSnapshot`: rows without a finite, non-negative
 * `usedTokens` are skipped during its backward walk, so they must not shadow
 * an earlier resolvable row here.
 */
function isResolvableContextWindowActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "context-window.updated") {
    return false;
  }
  const payload = asRecord(activity.payload);
  const usedTokens = payload?.usedTokens;
  return typeof usedTokens === "number" && Number.isFinite(usedTokens) && usedTokens >= 0;
}

/**
 * Drops all but the last resolvable context-window activity per turn from a
 * snapshot. Clients only ever read the latest usage value (walking the array
 * backwards), so shipping the full history, often thousands of rows on long
 * threads, buys nothing. Retention is per turn rather than per thread because
 * a live `thread.reverted` makes the client discard whole turns; keeping each
 * turn's latest row means the meter can still resolve a value from the turns
 * that survive. Malformed rows pass through untouched rather than shadowing a
 * valid earlier row. Live `thread.activity-appended` events are untouched:
 * newer updates still stream through and supersede the retained rows on the
 * client.
 */
function dropStaleContextWindowActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<OrchestrationThreadActivity> {
  const latestIndexByTurn = new Map<string | null, number>();
  for (let index = 0; index < activities.length; index += 1) {
    if (isResolvableContextWindowActivity(activities[index]!)) {
      latestIndexByTurn.set(activities[index]!.turnId, index);
    }
  }
  if (latestIndexByTurn.size === 0) {
    return activities;
  }
  return activities.filter(
    (activity, index) =>
      !isResolvableContextWindowActivity(activity) ||
      latestIndexByTurn.get(activity.turnId) === index,
  );
}

export function projectThreadDetailSnapshot(
  snapshot: OrchestrationThreadDetailSnapshot,
): OrchestrationThreadDetailSnapshot {
  return {
    ...snapshot,
    thread: {
      ...snapshot.thread,
      activities: dropStaleContextWindowActivities(snapshot.thread.activities).map(
        projectActivityPayload,
      ),
    },
  };
}

export function projectActivityEvent(event: OrchestrationEvent): OrchestrationEvent {
  if (event.type !== "thread.activity-appended") {
    return event;
  }
  return {
    ...event,
    payload: {
      ...event.payload,
      activity: projectActivityPayload(event.payload.activity),
    },
  };
}
