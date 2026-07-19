import * as NodeAssert from "node:assert/strict";
import { describe, it } from "vite-plus/test";

import {
  getCopilotPlatformPackageNames,
  resolveBundledCopilotRuntime,
  rewriteAsarPath,
} from "./CopilotRuntime.ts";

const makeChainResolver = (platformEntries: Record<string, string>) => {
  const calls: Array<{ from: string; request: string }> = [];
  const resolveFrom = (from: string, request: string): string => {
    calls.push({ from, request });
    if (request === "@github/copilot-sdk") {
      return "/store/copilot-sdk/dist/cjs/index.js";
    }
    if (request === "@github/copilot/package.json") {
      NodeAssert.equal(from, "/store/copilot-sdk/dist/cjs/index.js");
      return "/store/copilot/package.json";
    }
    const entry = platformEntries[request];
    if (entry !== undefined) {
      NodeAssert.equal(from, "/store/copilot/package.json");
      return entry;
    }
    throw new Error(`not installed: ${request}`);
  };
  return { calls, resolveFrom };
};

describe("CopilotRuntime", () => {
  it("mirrors the SDK platform package order", () => {
    NodeAssert.deepEqual(getCopilotPlatformPackageNames("darwin", "arm64"), [
      "@github/copilot-darwin-arm64",
    ]);
    NodeAssert.deepEqual(getCopilotPlatformPackageNames("win32", "x64"), [
      "@github/copilot-win32-x64",
    ]);
    NodeAssert.deepEqual(getCopilotPlatformPackageNames("linux", "x64"), [
      "@github/copilot-linux-x64",
      "@github/copilot-linuxmusl-x64",
    ]);
  });

  it("resolves through the sdk and copilot package contexts to the native binary", () => {
    const { calls, resolveFrom } = makeChainResolver({
      "@github/copilot-darwin-arm64": "/store/copilot-darwin-arm64/copilot",
    });

    const runtime = resolveBundledCopilotRuntime({
      platform: "darwin",
      architecture: "arm64",
      resolveFrom,
    });

    NodeAssert.equal(runtime, "/store/copilot-darwin-arm64/copilot");
    NodeAssert.deepEqual(
      calls.map((call) => call.request),
      ["@github/copilot-sdk", "@github/copilot/package.json", "@github/copilot-darwin-arm64"],
    );
  });

  it("falls back from linux to linuxmusl", () => {
    const { calls, resolveFrom } = makeChainResolver({
      "@github/copilot-linuxmusl-x64": "/store/copilot-linuxmusl-x64/copilot",
    });

    const runtime = resolveBundledCopilotRuntime({
      platform: "linux",
      architecture: "x64",
      resolveFrom,
    });

    NodeAssert.equal(runtime, "/store/copilot-linuxmusl-x64/copilot");
    NodeAssert.deepEqual(calls.map((call) => call.request).slice(2), [
      "@github/copilot-linux-x64",
      "@github/copilot-linuxmusl-x64",
    ]);
  });

  it("rewrites asar paths so the spawned file is a real executable", () => {
    const { resolveFrom } = makeChainResolver({
      "@github/copilot-darwin-arm64":
        "/Applications/Neokod.app/Contents/Resources/app.asar/node_modules/@github/copilot-darwin-arm64/copilot",
    });

    NodeAssert.equal(
      resolveBundledCopilotRuntime({ platform: "darwin", architecture: "arm64", resolveFrom }),
      "/Applications/Neokod.app/Contents/Resources/app.asar.unpacked/node_modules/@github/copilot-darwin-arm64/copilot",
    );
    NodeAssert.equal(
      rewriteAsarPath("C:\\Neokod\\resources\\app.asar\\node_modules\\copilot.exe"),
      "C:\\Neokod\\resources\\app.asar.unpacked\\node_modules\\copilot.exe",
    );
  });

  it("returns undefined when no platform package is installed", () => {
    const { resolveFrom } = makeChainResolver({});
    NodeAssert.equal(
      resolveBundledCopilotRuntime({ platform: "win32", architecture: "x64", resolveFrom }),
      undefined,
    );
  });

  it("returns undefined when the sdk itself cannot be resolved", () => {
    NodeAssert.equal(
      resolveBundledCopilotRuntime({
        platform: "darwin",
        architecture: "arm64",
        resolveFrom: () => {
          throw new Error("no sdk");
        },
      }),
      undefined,
    );
  });

  it("resolves the real bundled runtime in this workspace", () => {
    const runtime = resolveBundledCopilotRuntime();
    NodeAssert.ok(runtime, "expected the workspace dependency chain to resolve");
    NodeAssert.ok(
      /copilot(\.exe)?$/.test(runtime),
      `expected a native copilot binary path, got ${runtime}`,
    );
  });
});
