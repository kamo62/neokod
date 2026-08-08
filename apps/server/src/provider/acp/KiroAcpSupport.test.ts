import { Schema } from "effect";

import { KiroSettings } from "@neokod/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildKiroAcpSpawnInput } from "./KiroAcpSupport.ts";

const settings = Schema.decodeSync(KiroSettings)({ enabled: true });

describe("buildKiroAcpSpawnInput", () => {
  it("builds the default managed ACP launch without Crew or trust flags", () => {
    const spawn = buildKiroAcpSpawnInput(settings, "/workspace", { PATH: "/bin" }, "linux");

    expect(spawn.command).toBe("kiro-cli");
    expect(spawn.args).toEqual(["acp"]);
    expect(spawn.cwd).toBe("/workspace");
    expect(spawn.detached).toBe(true);
    expect(spawn.extendEnv).toBe(false);
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
