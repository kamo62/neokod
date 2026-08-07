import { describe, expect, it } from "@effect/vitest";

import { scrubEnvironment } from "./AgentRuntime.ts";

describe("scrubEnvironment (SPEC 15.3)", () => {
  it("strips secret names from the inherited environment", () => {
    const env = {
      PATH: "/usr/bin",
      HOME: "/home/user",
      GH_TOKEN: "super-secret",
      GITHUB_PAT: "another-secret",
      KEEP_ME: "value",
    };
    const scrubbed = scrubEnvironment(env, ["GH_TOKEN", "GITHUB_PAT"]);
    expect(scrubbed.PATH).toBe("/usr/bin");
    expect(scrubbed.HOME).toBe("/home/user");
    expect(scrubbed.KEEP_ME).toBe("value");
    expect(scrubbed.GH_TOKEN).toBeUndefined();
    expect(scrubbed.GITHUB_PAT).toBeUndefined();
  });

  it("never mutates the input environment", () => {
    const env = { GH_TOKEN: "secret" };
    scrubEnvironment(env, ["GH_TOKEN"]);
    expect(env.GH_TOKEN).toBe("secret");
  });

  it("handles an empty secret list as a passthrough", () => {
    const env = { A: "1", B: "2" };
    expect(scrubEnvironment(env, [])).toEqual({ A: "1", B: "2" });
  });
});
