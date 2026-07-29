import { describe, expect, it } from "@effect/vitest";

import {
  buildPublishManifest,
  parseCatalog,
  readVersionFromChangelog,
  UnresolvedSpecifierError,
} from "./build-npm-publish-manifest.ts";

const catalog = {
  "@effect/platform-node": "4.0.0-beta.78",
  "@pierre/diffs": "1.3.0-beta.5",
  effect: "4.0.0-beta.78",
};

const source = {
  name: "neokod",
  version: "3.0.3",
  license: "MIT",
  type: "module",
  bin: { neokod: "./dist/bin.mjs" },
  files: ["dist"],
  engines: { node: "^22.16" },
  scripts: { dev: "node --watch src/bin.ts" },
  dependencies: {
    "@effect/platform-node": "catalog:",
    "@pierre/diffs": "catalog:",
    "@github/copilot-sdk": "1.0.5",
    effect: "catalog:",
    "node-pty": "^1.1.0",
  },
  devDependencies: {
    "@neokod/contracts": "workspace:*",
    "@types/node": "catalog:",
  },
};

describe("buildPublishManifest", () => {
  it("resolves catalog ranges so the tarball is installable", () => {
    const manifest = buildPublishManifest({ source, catalog, version: "3.5.3" });
    expect(manifest.dependencies).toEqual({
      "@effect/platform-node": "4.0.0-beta.78",
      "@github/copilot-sdk": "1.0.5",
      effect: "4.0.0-beta.78",
      "node-pty": "^1.1.0",
    });
  });

  it("drops dependencies the bundle already inlines", () => {
    const manifest = buildPublishManifest({ source, catalog, version: "3.5.3" });
    // Inlined into dist/bin.mjs, and patched in this workspace, so installing
    // it from the registry would add weight and an unpatched copy.
    expect(manifest.dependencies?.["@pierre/diffs"]).toBeUndefined();
  });

  it("strips build-only fields", () => {
    const manifest = buildPublishManifest({ source, catalog, version: "3.5.3" });
    expect(manifest.devDependencies).toBeUndefined();
    expect(manifest.scripts).toBeUndefined();
  });

  it("takes the version from the argument rather than the workspace manifest", () => {
    const manifest = buildPublishManifest({ source, catalog, version: "3.5.3" });
    expect(manifest.version).toBe("3.5.3");
    expect(manifest.name).toBe("neokod");
    expect(manifest.bin).toEqual({ neokod: "./dist/bin.mjs" });
  });

  it("refuses to publish a catalog range that is missing from the catalog", () => {
    expect(() =>
      buildPublishManifest({
        source: { ...source, dependencies: { missing: "catalog:" } },
        catalog,
        version: "3.5.3",
      }),
    ).toThrow(UnresolvedSpecifierError);
  });

  it("refuses to publish a workspace range left in dependencies", () => {
    expect(() =>
      buildPublishManifest({
        source: { ...source, dependencies: { "some-internal-pkg": "workspace:*" } },
        catalog,
        version: "3.5.3",
      }),
    ).toThrow(UnresolvedSpecifierError);
  });

  it("drops by the same prefix rule the bundler uses", () => {
    // `shouldBundleCliDependency` matches on `startsWith`, so the manifest must
    // drop on `startsWith` too. Diverging would publish a dependency the bundle
    // has already inlined, or omit one it left external.
    const manifest = buildPublishManifest({
      source: { ...source, dependencies: { "@neokod/shared": "workspace:*" } },
      catalog,
      version: "3.5.3",
    });
    expect(manifest.dependencies).toEqual({});
  });
});

describe("readVersionFromChangelog", () => {
  it("reads the first heading, matching release.yml", () => {
    expect(readVersionFromChangelog("## 3.5.3 - 2026-07-28 (Patch)\n\n- thing\n\n## 3.5.2\n")).toBe(
      "3.5.3",
    );
  });

  it("tolerates a leading v", () => {
    expect(readVersionFromChangelog("## v3.5.3 - 2026-07-28\n")).toBe("3.5.3");
  });

  it("rejects a heading that is not a version", () => {
    expect(() => readVersionFromChangelog("## Unreleased\n")).toThrow(/Invalid release version/);
  });

  it("rejects a changelog with no heading", () => {
    expect(() => readVersionFromChangelog("no headings here\n")).toThrow(/Could not read/);
  });
});

describe("parseCatalog", () => {
  it("reads the catalog block from pnpm-workspace.yaml", () => {
    expect(parseCatalog("packages:\n  - apps/*\ncatalog:\n  effect: 4.0.0-beta.78\n")).toEqual({
      effect: "4.0.0-beta.78",
    });
  });

  it("returns empty when no catalog is defined", () => {
    expect(parseCatalog("packages:\n  - apps/*\n")).toEqual({});
  });
});
