import { describe, expect, it } from "@effect/vitest";

import {
  classifyOpenCodeVersion,
  formatOpenCodeUnsupportedVersionMessage,
  parseOpenCodeVersionOutput,
} from "./openCodeVersion.ts";

describe("parseOpenCodeVersionOutput", () => {
  it("accepts the v-prefixed banner printed by OpenCode 2", () => {
    expect(parseOpenCodeVersionOutput("opencode v2.0.32\n")).toBe("2.0.32");
  });

  it("accepts the plain version printed by supported OpenCode 1.x", () => {
    expect(parseOpenCodeVersionOutput("opencode 1.18.15\n")).toBe("1.18.15");
  });

  it("does not treat unrelated text as a version", () => {
    expect(parseOpenCodeVersionOutput("opencode version unknown\n")).toBeNull();
  });
});

describe("classifyOpenCodeVersion", () => {
  it("classifies the major once and marks OpenCode 2 unsupported", () => {
    expect(classifyOpenCodeVersion("v2.0.32")).toEqual({
      version: "2.0.32",
      major: 2,
      supported: false,
    });
  });

  it("keeps OpenCode 1.x supported", () => {
    expect(classifyOpenCodeVersion("1.18.15")).toEqual({
      version: "1.18.15",
      major: 1,
      supported: true,
    });
  });

  it("returns null for a version it cannot parse", () => {
    expect(classifyOpenCodeVersion("unknown")).toBeNull();
  });
});

describe("formatOpenCodeUnsupportedVersionMessage", () => {
  it("names the installed version and the missing 1.x install", () => {
    const message = formatOpenCodeUnsupportedVersionMessage({
      version: "2.0.32",
      major: 2,
      supported: false,
    });

    expect(message).toContain("OpenCode v2.0.32");
    expect(message).toContain("OpenCode 2 is not supported yet");
    expect(message).toContain("install OpenCode 1.x");
  });
});
