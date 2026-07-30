import { describe, expect, it } from "@effect/vitest";

import { OpenCodeRuntimeError, parseOpenCodeServerTimeoutMs } from "./opencodeRuntime.ts";

const DEFAULT_TIMEOUT_MS = 15_000;

describe("parseOpenCodeServerTimeoutMs", () => {
  it("uses the default when the operator sets nothing", () => {
    expect(parseOpenCodeServerTimeoutMs(undefined)).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("accepts a positive integer and tolerates surrounding whitespace", () => {
    expect(parseOpenCodeServerTimeoutMs("45000")).toBe(45_000);
    expect(parseOpenCodeServerTimeoutMs("  45000  ")).toBe(45_000);
  });

  it("ignores values that would make every start fail immediately", () => {
    // A zero or negative budget times out before the process can announce
    // itself, so falling back beats honouring it.
    for (const raw of ["0", "-1", "-45000"]) {
      expect(parseOpenCodeServerTimeoutMs(raw)).toBe(DEFAULT_TIMEOUT_MS);
    }
  });

  it("ignores values that are not safe integers", () => {
    for (const raw of ["", "   ", "abc", "15s", "1.5", "1e999", "9007199254740993"]) {
      expect(parseOpenCodeServerTimeoutMs(raw)).toBe(DEFAULT_TIMEOUT_MS);
    }
  });
});

describe("OpenCodeRuntimeError", () => {
  it("reports its detail as the error message", () => {
    // Without this the error prints as a bare "OpenCodeRuntimeError:" and the
    // reason is lost unless an outer error happens to interpolate it.
    const error = new OpenCodeRuntimeError({
      operation: "startOpenCodeServerProcess",
      detail: "Timed out waiting for OpenCode server start after 15000ms.",
    });

    expect(error.message).toBe("Timed out waiting for OpenCode server start after 15000ms.");
    expect(String(error)).toContain("Timed out waiting for OpenCode server start after 15000ms.");
  });
});
