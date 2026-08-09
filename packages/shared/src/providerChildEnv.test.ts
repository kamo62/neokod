import { describe, expect, it } from "@effect/vitest";

import { buildProviderChildEnv } from "./providerChildEnv.ts";

describe("buildProviderChildEnv", () => {
  const parentEnv = {
    // Process basics that must survive.
    PATH: "/usr/bin:/bin",
    HOME: "/home/dev",
    LANG: "en_US.UTF-8",
    TMPDIR: "/tmp",
    NODE_EXTRA_CA_CERTS: "/etc/ssl/certs/ca.pem",
    // Secrets that must be dropped.
    NEOKOD_SECRET: "neokod",
    T3CODE_LEGACY: "t3",
    VITE_ANALYTICS_KEY: "vite",
    GH_TOKEN: "gh",
    GITLAB_TOKEN: "gl",
    AWS_SECRET_ACCESS_KEY: "aws",
    OPENAI_API_KEY: "openai",
    DATABASE_URL: "postgres://secret",
    POSTHOG_API_KEY: "telemetry",
  } satisfies NodeJS.ProcessEnv;

  it("keeps only allowlisted process basics on posix", () => {
    const built = buildProviderChildEnv({ parentEnv, platform: "linux" });
    expect(built.extendEnv).toBe(false);
    expect(built.env).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/home/dev",
      LANG: "en_US.UTF-8",
      TMPDIR: "/tmp",
      NODE_EXTRA_CA_CERTS: "/etc/ssl/certs/ca.pem",
    });
  });

  it("drops every non-allowlisted secret by construction", () => {
    const built = buildProviderChildEnv({ parentEnv, platform: "linux" });
    for (const secret of [
      "NEOKOD_SECRET",
      "T3CODE_LEGACY",
      "VITE_ANALYTICS_KEY",
      "GH_TOKEN",
      "GITLAB_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
      "OPENAI_API_KEY",
      "DATABASE_URL",
      "POSTHOG_API_KEY",
    ]) {
      expect(built.env[secret]).toBeUndefined();
      expect(built.omittedNames).toContain(secret);
    }
  });

  it("includes explicit additions and reports them as allowed, not omitted", () => {
    const built = buildProviderChildEnv({
      parentEnv,
      additions: { CODEX_HOME: "/home/dev/.codex" },
      platform: "linux",
    });
    expect(built.env.CODEX_HOME).toBe("/home/dev/.codex");
    expect(built.allowedNames).toContain("CODEX_HOME");
    expect(built.omittedNames).not.toContain("CODEX_HOME");
  });

  it("lets an addition override a colliding allowlisted parent value", () => {
    const built = buildProviderChildEnv({
      parentEnv: { ...parentEnv, HOME: "/home/dev" },
      additions: { HOME: "/sandboxed/home" },
      platform: "linux",
    });
    expect(built.env.HOME).toBe("/sandboxed/home");
  });

  it("passes through caller-approved extra names", () => {
    const built = buildProviderChildEnv({
      parentEnv: { ...parentEnv, KIRO_CONFIG_DIR: "/home/dev/.kiro" },
      allow: ["KIRO_CONFIG_DIR"],
      platform: "linux",
    });
    expect(built.env.KIRO_CONFIG_DIR).toBe("/home/dev/.kiro");
  });

  it("matches allowlist names case-insensitively on windows", () => {
    const built = buildProviderChildEnv({
      parentEnv: { Path: "C:\\Windows", SystemRoot: "C:\\Windows", SECRET_TOKEN: "x" },
      platform: "win32",
    });
    expect(built.env.Path).toBe("C:\\Windows");
    expect(built.env.SystemRoot).toBe("C:\\Windows");
    expect(built.env.SECRET_TOKEN).toBeUndefined();
  });

  it("never mutates the parent environment", () => {
    const parent = { PATH: "/usr/bin", GH_TOKEN: "secret" };
    buildProviderChildEnv({ parentEnv: parent, platform: "linux" });
    expect(parent.GH_TOKEN).toBe("secret");
  });
});
