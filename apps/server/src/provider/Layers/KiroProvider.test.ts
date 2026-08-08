// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { KiroSettings } from "@neokod/contracts";

import {
  buildInitialKiroProviderSnapshot,
  checkKiroProviderStatus,
  isKiroVersionSupported,
  MINIMUM_KIRO_CLI_VERSION,
} from "./KiroProvider.ts";

const decodeKiroSettings = Schema.decodeSync(KiroSettings);

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

async function makeVersionBinary(version: string, extraLines: ReadonlyArray<string> = []) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kiro-version-probe-"));
  const binaryPath = NodePath.join(dir, "kiro-cli");
  await NodeFSP.writeFile(
    binaryPath,
    ["#!/bin/sh", ...extraLines, `printf 'kiro-cli ${version}\\n'`, ""].join("\n"),
    "utf8",
  );
  await NodeFSP.chmod(binaryPath, 0o755);
  return binaryPath;
}

describe("isKiroVersionSupported", () => {
  it("accepts the minimum and newer versions", () => {
    expect(isKiroVersionSupported(MINIMUM_KIRO_CLI_VERSION)).toBe(true);
    expect(isKiroVersionSupported("2.16.3")).toBe(true);
    expect(isKiroVersionSupported("3.0.0")).toBe(true);
  });

  it("rejects missing, malformed-as-zero, and older versions", () => {
    expect(isKiroVersionSupported(undefined)).toBe(false);
    expect(isKiroVersionSupported(null)).toBe(false);
    expect(isKiroVersionSupported("not-a-version")).toBe(false);
    expect(isKiroVersionSupported("2.16.1")).toBe(false);
  });
});

describe("buildInitialKiroProviderSnapshot", () => {
  it.effect("is disabled by default and exposes only the auto model", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialKiroProviderSnapshot(decodeKiroSettings({}));
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.models.map((model) => model.slug)).toEqual(["auto"]);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("shows an early-access pending state only when explicitly enabled", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialKiroProviderSnapshot(
        decodeKiroSettings({ enabled: true }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.badgeLabel).toBe("Early Access");
      expect(snapshot.requiresNewThreadForModelChange).toBe(true);
      expect(snapshot.message).toContain("Crew and Symphony are disabled");
    }),
  );
});

it.layer(NodeServices.layer)("checkKiroProviderStatus", (it) => {
  it.effect("keeps the minimum CLI version limited until a managed turn succeeds", () =>
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() => makeVersionBinary("2.16.2"));
      const snapshot = yield* checkKiroProviderStatus(
        decodeKiroSettings({ enabled: true, binaryPath }),
      );
      expect(snapshot.installed).toBe(true);
      expect(snapshot.version).toBe("2.16.2");
      expect(snapshot.status).toBe("warning");
      expect(snapshot.auth.status).toBe("unknown");
      expect(snapshot.message).toContain("Managed-turn availability is verified per session");
    }),
  );

  it.effect("rejects a CLI below the minimum version", () =>
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() => makeVersionBinary("2.16.1"));
      const snapshot = yield* checkKiroProviderStatus(
        decodeKiroSettings({ enabled: true, binaryPath }),
      );
      expect(snapshot.installed).toBe(true);
      expect(snapshot.version).toBe("2.16.1");
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toContain(MINIMUM_KIRO_CLI_VERSION);
    }),
  );

  it.effect("does not leak parent secrets into the real version probe", () =>
    Effect.gen(function* () {
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kiro-health-env-")),
      );
      const childEnvPath = NodePath.join(tempDir, "environment.txt");
      const binaryPath = yield* Effect.promise(() =>
        makeVersionBinary("2.16.2", [`env > ${shellQuote(childEnvPath)}`]),
      );
      const snapshot = yield* checkKiroProviderStatus(
        decodeKiroSettings({ enabled: true, binaryPath }),
        {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          KIRO_HEALTH_SECRET: "must-not-reach-probe",
          GITHUB_TOKEN: "must-not-reach-probe",
        },
      );
      const childEnvironment = yield* Effect.promise(() => NodeFSP.readFile(childEnvPath, "utf8"));
      expect(snapshot.status).toBe("warning");
      expect(childEnvironment).not.toContain("KIRO_HEALTH_SECRET=");
      expect(childEnvironment).not.toContain("GITHUB_TOKEN=");
      if (process.env.HOME) expect(childEnvironment).toContain(`HOME=${process.env.HOME}`);
    }),
  );
});
