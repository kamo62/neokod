import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "@effect/vitest";

import { deriveWorkspaceKey, deriveWorkingBranch } from "./Keys.ts";

const hashOf = (value: string): string =>
  NodeCrypto.createHash("sha256").update(value).digest("hex").slice(0, 16);

const ALLOWED = /^[A-Za-z0-9._-]+$/;

describe("deriveWorkspaceKey", () => {
  it("keeps safe identifiers unchanged", () => {
    expect(deriveWorkspaceKey("ABC-123")).toBe("ABC-123");
    expect(deriveWorkspaceKey("neo_42")).toBe("neo_42");
    expect(deriveWorkspaceKey("a.b-c_d")).toBe("a.b-c_d");
  });

  it("replaces disallowed characters with underscores and appends a hash suffix", () => {
    expect(deriveWorkspaceKey("NEO-142 add session")).toBe(
      `NEO-142_add_session-${hashOf("NEO-142 add session")}`,
    );
    expect(deriveWorkspaceKey("foo/bar:baz")).toBe(`foo_bar_baz-${hashOf("foo/bar:baz")}`);
  });

  it("appends a stable hash suffix when sanitization changes the identifier", () => {
    const key = deriveWorkspaceKey("NEO-142 add session");
    expect(ALLOWED.test(key)).toBe(true);
    expect(key).toMatch(/^NEO-142_add_session-[0-9a-f]{16}$/);
  });

  it("produces the same key for the same identifier", () => {
    expect(deriveWorkspaceKey("NEO-142 add session")).toBe(
      deriveWorkspaceKey("NEO-142 add session"),
    );
  });

  it("is collision-resistant for identifiers that sanitize to the same text", () => {
    const a = deriveWorkspaceKey("a/b");
    const b = deriveWorkspaceKey("a b");
    expect(a).not.toBe(b);
    expect(a.startsWith("a_b-")).toBe(true);
    expect(b.startsWith("a_b-")).toBe(true);
  });

  it("handles hostile identifiers without throwing", () => {
    const hostile = ['"../etc/passwd"', "..", "a".repeat(500), "тест", "a\u0000b"];
    for (const identifier of hostile) {
      const key = deriveWorkspaceKey(identifier);
      expect(ALLOWED.test(key)).toBe(true);
      expect(key.length).toBeGreaterThan(0);
    }
  });
});

describe("deriveWorkingBranch", () => {
  it("namespaces the branch after the workspace key", () => {
    expect(deriveWorkingBranch(deriveWorkspaceKey("ABC-1"))).toBe("symphony/ABC-1");
    expect(deriveWorkingBranch(deriveWorkspaceKey("a b"))).toMatch(/^symphony\/a_b-[0-9a-f]{16}$/);
  });
});
