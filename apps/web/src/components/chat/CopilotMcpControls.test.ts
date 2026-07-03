import { describe, expect, it } from "vite-plus/test";
import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";

import {
  describeMcpServer,
  isMcpServerEnabled,
  threadUsesCopilot,
  toggleCopilotMcpServerEnabled,
} from "./CopilotMcpControls";

const COPILOT = ProviderDriverKind.make("githubCopilot");
const CODEX = ProviderDriverKind.make("codex");

describe("threadUsesCopilot", () => {
  it("is false when there is no selected instance", () => {
    expect(threadUsesCopilot(undefined, undefined)).toBe(false);
  });

  it("recognizes the built-in Copilot default instance", () => {
    expect(threadUsesCopilot(defaultInstanceIdForDriver(COPILOT), undefined)).toBe(true);
  });

  it("is false for a different built-in provider", () => {
    expect(threadUsesCopilot(defaultInstanceIdForDriver(CODEX), undefined)).toBe(false);
  });

  it("resolves custom instances via providerInstances.driver", () => {
    const copilotCustom = ProviderInstanceId.make("copilot_work");
    const codexCustom = ProviderInstanceId.make("codex_remote");
    const providerInstances = {
      [copilotCustom]: { driver: COPILOT },
      [codexCustom]: { driver: CODEX },
    };
    expect(threadUsesCopilot(copilotCustom, providerInstances)).toBe(true);
    expect(threadUsesCopilot(codexCustom, providerInstances)).toBe(false);
  });
});

describe("isMcpServerEnabled", () => {
  it("treats an absent flag as enabled", () => {
    expect(isMcpServerEnabled({ type: "http", url: "https://x" })).toBe(true);
  });

  it("treats enabled:true as enabled and enabled:false as disabled", () => {
    expect(isMcpServerEnabled({ type: "http", url: "https://x", enabled: true })).toBe(true);
    expect(isMcpServerEnabled({ type: "http", url: "https://x", enabled: false })).toBe(false);
  });
});

describe("toggleCopilotMcpServerEnabled", () => {
  it("disables an implicitly-enabled server", () => {
    const next = toggleCopilotMcpServerEnabled({ a: { type: "http", url: "https://a" } }, "a");
    expect(next.a?.enabled).toBe(false);
  });

  it("re-enables a disabled server", () => {
    const next = toggleCopilotMcpServerEnabled(
      { a: { type: "http", url: "https://a", enabled: false } },
      "a",
    );
    expect(next.a?.enabled).toBe(true);
  });

  it("leaves other servers untouched and is a no-op for unknown names", () => {
    const servers = {
      a: { type: "http" as const, url: "https://a" },
      b: { command: "b-mcp" },
    };
    const next = toggleCopilotMcpServerEnabled(servers, "missing");
    expect(next).toBe(servers);
  });
});

describe("describeMcpServer", () => {
  it("summarizes remote servers by type and url", () => {
    expect(describeMcpServer({ type: "http", url: "https://x/mcp" })).toBe("http · https://x/mcp");
  });

  it("summarizes stdio servers by command and args", () => {
    expect(describeMcpServer({ command: "my-mcp", args: ["--stdio"] })).toBe(
      "stdio · my-mcp --stdio",
    );
  });
});
