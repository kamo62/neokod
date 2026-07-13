// @effect-diagnostics nodeBuiltinImport:off - Tests exercise root env file precedence directly.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { loadRepoEnv } from "./public-config.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("loadRepoEnv", () => {
  it("returns an empty object for an unconfigured clone", () => {
    expect(loadRepoEnv({ baseEnv: {}, repoRoot: makeTemporaryDirectory() })).toEqual({});
  });

  it("applies process, root local, and root precedence in that order", () => {
    const repoRoot = makeTemporaryDirectory();
    NodeFS.writeFileSync(NodePath.join(repoRoot, ".env"), "EXAMPLE=root\nROOT_ONLY=yes\n");
    NodeFS.writeFileSync(NodePath.join(repoRoot, ".env.local"), "EXAMPLE=local\nLOCAL_ONLY=yes\n");

    expect(loadRepoEnv({ baseEnv: { EXAMPLE: "process" }, repoRoot })).toEqual({
      EXAMPLE: "process",
      ROOT_ONLY: "yes",
      LOCAL_ONLY: "yes",
    });
  });
});

function makeTemporaryDirectory() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-public-config-"));
  temporaryDirectories.push(directory);
  return directory;
}
