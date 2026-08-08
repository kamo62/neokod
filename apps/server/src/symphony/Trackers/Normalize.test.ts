import { describe, expect, it } from "@effect/vitest";

import {
  decodeCandidateIssues,
  decodeNormalizedIssue,
  decodeRefreshedIssues,
  isStateIn,
  normalizeLabels,
  normalizeState,
} from "./Normalize.ts";

describe("normalizeState / normalizeLabels", () => {
  it("trims and lowercases state", () => {
    expect(normalizeState("  Ready  ")).toBe("ready");
    expect(normalizeState("In Progress")).toBe("in progress");
  });

  it("isStateIn compares case-insensitively", () => {
    expect(isStateIn("Ready", ["ready", "in progress"])).toBe(true);
    expect(isStateIn("DONE", ["done"])).toBe(true);
    expect(isStateIn("Blocked", ["ready"])).toBe(false);
  });

  it("normalizes labels: trim, lowercase, drop blanks, dedupe", () => {
    expect(normalizeLabels([" Agent-Ready ", "agent-ready", "", "  "])).toEqual(["agent-ready"]);
  });
});

describe("decodeNormalizedIssue", () => {
  it("decodes a valid issue and normalizes labels", () => {
    const issue = decodeNormalizedIssue({
      id: "42",
      identifier: "#42",
      title: "Fix bug",
      state: "Ready",
      dispatchable: true,
      labels: [" Agent-Ready ", "Agent-Ready"],
      priority: 2,
      url: "https://example.test/42",
    });
    expect(issue).not.toBeNull();
    expect(issue?.id).toBe("42");
    expect(issue?.state).toBe("Ready");
    expect(issue?.labels).toEqual(["agent-ready"]);
    expect(issue?.priority).toBe(2);
  });

  it("applies optional-field fallbacks to null and []", () => {
    const issue = decodeNormalizedIssue({
      id: "43",
      identifier: "#43",
      title: "No metadata",
      state: "Ready",
      dispatchable: true,
    });
    expect(issue?.description).toBeNull();
    expect(issue?.blockedBy).toEqual([]);
    expect(issue?.labels).toEqual([]);
    expect(issue?.createdAt).toBeNull();
  });

  it("returns null for a malformed record missing required fields", () => {
    expect(decodeNormalizedIssue({ id: "44", state: "Ready" })).toBeNull();
    expect(decodeNormalizedIssue({ identifier: "#45", title: "x", state: "Ready" })).toBeNull();
    expect(
      decodeNormalizedIssue({ id: "46", title: "x", state: "Ready", dispatchable: "yes" }),
    ).toBeNull();
    expect(decodeNormalizedIssue("not-an-object")).toBeNull();
    expect(decodeNormalizedIssue(null)).toBeNull();
  });
});

describe("decodeCandidateIssues vs decodeRefreshedIssues", () => {
  it("state-list reads drop malformed records", () => {
    const { issues, dropped } = decodeCandidateIssues([
      { id: "1", identifier: "#1", title: "ok", state: "Ready", dispatchable: true },
      { id: "2", state: "Ready" },
      { identifier: "#3", title: "x", state: "Ready", dispatchable: true },
    ]);
    expect(issues).toHaveLength(1);
    expect(dropped).toBe(2);
  });

  it("ID-refresh reads fail on malformed records", () => {
    const result = decodeRefreshedIssues([
      { id: "1", identifier: "#1", title: "ok", state: "Ready", dispatchable: true },
      { id: "2", state: "Ready" },
    ]);
    expect(result.ok).toBe(false);
  });

  it("ID-refresh reads succeed when all records are well-formed", () => {
    const result = decodeRefreshedIssues([
      { id: "1", identifier: "#1", title: "ok", state: "Ready", dispatchable: true },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.issues).toHaveLength(1);
      expect(result.dropped).toBe(0);
    }
  });
});
