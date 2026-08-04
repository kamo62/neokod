import type { NormalizedIssue } from "@neokod/contracts";
import { NormalizedIssueSchema } from "@neokod/contracts";
import * as Schema from "effect/Schema";

import { trackerResponseError } from "./Errors.ts";
import type { TrackerAdapterError } from "./Errors.ts";

/**
 * Tracker normalization primitives (SPEC 11.3).
 *
 * State comparisons are `trim + lowercase` everywhere. Labels are trimmed,
 * lowercased, blanks dropped, duplicates removed. Malformed records are
 * handled differently per read path: state-list reads may drop a malformed
 * record (it was never safe to dispatch); ID-refresh reads must fail, because
 * omission is meaningful.
 */

export const normalizeState = (state: string): string => state.trim().toLowerCase();

export const normalizeLabel = (label: string): string => label.trim().toLowerCase();

export const normalizeLabels = (labels: ReadonlyArray<string>): string[] => {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const label of labels) {
    const value = normalizeLabel(label);
    if (value.length > 0 && !seen.has(value)) {
      seen.add(value);
      normalized.push(value);
    }
  }
  return normalized;
};

export const isStateIn = (state: string, states: ReadonlyArray<string>): boolean => {
  const normalized = normalizeState(state);
  return states.some((candidate) => normalizeState(candidate) === normalized);
};

/**
 * Decode an adapter payload into a `NormalizedIssue`, applying the SPEC 11.3
 * optional-field fallbacks: nullable fields fall back to `null`, collection
 * fields fall back to `[]`, `labels` are normalized. `id`, `identifier`,
 * `title`, `state` and explicit `dispatchable` are required; their absence
 * makes the record malformed.
 */
export const decodeNormalizedIssue = (
  payload: unknown,
): Schema.Schema.Type<typeof NormalizedIssueSchema> | null => {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const raw = payload as Record<string, unknown>;

  const id = typeof raw.id === "string" ? raw.id : undefined;
  const identifier = typeof raw.identifier === "string" ? raw.identifier : undefined;
  const title = typeof raw.title === "string" ? raw.title : undefined;
  const state = typeof raw.state === "string" ? raw.state : undefined;
  if (id === undefined || id.length === 0 || identifier === undefined || identifier.length === 0) {
    return null;
  }
  if (title === undefined || title.length === 0 || state === undefined || state.length === 0) {
    return null;
  }

  const dispatchable =
    typeof raw.dispatchable === "boolean"
      ? raw.dispatchable
      : raw.dispatchable === undefined
        ? false
        : undefined;
  if (dispatchable === undefined) {
    return null;
  }

  const priority =
    typeof raw.priority === "number" && Number.isInteger(raw.priority)
      ? raw.priority
      : raw.priority === null
        ? null
        : raw.priority === undefined
          ? null
          : undefined;
  if (priority === undefined) {
    return null;
  }

  return NormalizedIssueSchema.make({
    id,
    nativeRef:
      typeof raw.nativeRef === "object" && raw.nativeRef !== null
        ? (raw.nativeRef as Record<string, unknown>)
        : null,
    identifier,
    title,
    description: typeof raw.description === "string" ? raw.description : null,
    priority,
    state,
    branchName: typeof raw.branchName === "string" ? raw.branchName : null,
    url: typeof raw.url === "string" ? raw.url : null,
    assigneeId: typeof raw.assigneeId === "string" ? raw.assigneeId : null,
    labels: Array.isArray(raw.labels) ? normalizeLabels(raw.labels as string[]) : [],
    blockedBy: Array.isArray(raw.blockedBy) ? (raw.blockedBy as NormalizedIssue["blockedBy"]) : [],
    dispatchable,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : null,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
  });
};

/**
 * Decode a batch of adapter records from a state-list read, dropping
 * malformed records (SPEC 11.1: a malformed record was never safe to
 * dispatch). The caller SHOULD log the omission count.
 */
export const decodeCandidateIssues = (
  payload: unknown,
): { readonly issues: NormalizedIssue[]; readonly dropped: number } => {
  if (!Array.isArray(payload)) {
    return { issues: [], dropped: 0 };
  }
  const issues: NormalizedIssue[] = [];
  let dropped = 0;
  for (const entry of payload) {
    const issue = decodeNormalizedIssue(entry);
    if (issue === null) {
      dropped += 1;
    } else {
      issues.push(issue);
    }
  }
  return { issues, dropped };
};

/**
 * Decode a batch of adapter records from an ID-refresh read. Any malformed
 * requested record is an error, because omission is meaningful: the caller
 * asked for a specific issue and must not silently lose it (SPEC 11.1).
 */
export const decodeRefreshedIssues = (
  payload: unknown,
):
  | { readonly ok: true; readonly issues: NormalizedIssue[]; readonly dropped: 0 }
  | { readonly ok: false; readonly error: TrackerAdapterError } => {
  if (!Array.isArray(payload)) {
    return {
      ok: false,
      error: trackerResponseError("ID-refresh read did not return an array of issues"),
    };
  }
  const issues: NormalizedIssue[] = [];
  let dropped = 0;
  for (const entry of payload) {
    const issue = decodeNormalizedIssue(entry);
    if (issue === null) {
      dropped += 1;
    } else {
      issues.push(issue);
    }
  }
  if (dropped > 0) {
    return {
      ok: false,
      error: trackerResponseError(`ID-refresh read returned ${dropped} malformed record(s)`),
    };
  }
  return { ok: true, issues, dropped: 0 };
};
