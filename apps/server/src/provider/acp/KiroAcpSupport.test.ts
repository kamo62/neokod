import { Schema } from "effect";

import { KiroSettings } from "@neokod/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildKiroAcpSpawnInput } from "./KiroAcpSupport.ts";

const settings = Schema.decodeSync(KiroSettings)({ enabled: true });

describe("buildKiroAcpSpawnInput", () => {
  it("builds the default managed ACP launch without Crew or trust flags", () => {
    const spawn = buildKiroAcpSpawnInput(settings, "/workspace", { PATH: "/bin" }, "linux");

    expect(spawn.command).toBe("kiro-cli");
    expect(spawn.args).toEqual(["acp", "--agent-engine", "v2"]);
    expect(spawn.cwd).toBe("/workspace");
    expect(spawn.detached).toBe(true);
    expect(spawn.extendEnv).toBe(false);
  });

  it("passes only KIRO_API_KEY to the v3 engine", () => {
    const spawn = buildKiroAcpSpawnInput(
      { ...settings, agentEngine: "v3" },
      "/workspace",
      {
        PATH: "/safe/bin",
        KIRO_API_KEY: "kiro-test-key",
        ANTHROPIC_API_KEY: "nope",
      },
      "linux",
      "/managed/kiro-v3-home",
    );

    expect(spawn.args).toEqual(["acp", "--agent-engine", "v3"]);
    expect(spawn.env).toMatchObject({
      PATH: "/safe/bin",
      HOME: "/managed/kiro-v3-home",
      KIRO_API_KEY: "kiro-test-key",
    });
    expect(spawn.env).not.toHaveProperty("ANTHROPIC_API_KEY");
  });

  it("drops parent secrets and never re-merges the parent environment", () => {
    const spawn = buildKiroAcpSpawnInput(
      settings,
      "/workspace",
      {
        PATH: "/safe/bin",
        HOME: "/safe/home",
        NEOKOD_SECRET: "nope",
        GITHUB_TOKEN: "nope",
        AWS_SECRET_ACCESS_KEY: "nope",
        ANTHROPIC_API_KEY: "nope",
      },
      "linux",
    );

    expect(spawn.env).toMatchObject({ PATH: "/safe/bin", HOME: "/safe/home" });
    expect(spawn.env).not.toHaveProperty("NEOKOD_SECRET");
    expect(spawn.env).not.toHaveProperty("GITHUB_TOKEN");
    expect(spawn.env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(spawn.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(spawn.extendEnv).toBe(false);
  });
});
