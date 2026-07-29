#!/usr/bin/env node

/**
 * Builds the manifest published to npm as `neokod`.
 *
 * The workspace manifest cannot be published as-is. Six runtime dependencies
 * use pnpm's `catalog:` protocol and five dev dependencies use `workspace:*`;
 * `npm pack` copies both through verbatim, producing a tarball that cannot be
 * installed. This resolves the catalog, drops what the bundle already inlines,
 * and strips build-only fields.
 */

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/unstable/cli";
import * as YAML from "yaml";

import { fromJsonStringPretty } from "@neokod/shared/schemaJson";

/** Prefixes bundled into `dist/bin.mjs`, mirroring the server's vite config. */
export const BUNDLED_DEPENDENCY_PREFIXES = [
  "@pierre/diffs",
  "@neokod/",
  "effect-acp",
  "effect-codex-app-server",
] as const;

/** Fields carried into the published manifest. Anything else is build-only. */
const PUBLISHED_FIELDS = [
  "name",
  "version",
  "description",
  "license",
  "repository",
  "homepage",
  "bugs",
  "keywords",
  "type",
  "bin",
  "files",
  "engines",
] as const;

export interface PackageManifest {
  readonly [key: string]: unknown;
  readonly name?: string;
  readonly dependencies?: Record<string, string>;
}

export class UnresolvedSpecifierError extends Error {
  // Declared as a field rather than a parameter property: these scripts run
  // under `node <file>.ts`, whose strip-only mode rejects parameter properties.
  readonly specifiers: ReadonlyArray<readonly [string, string]>;

  constructor(specifiers: ReadonlyArray<readonly [string, string]>) {
    super(
      `Cannot publish with unresolved specifiers: ${specifiers
        .map(([name, range]) => `${name}@${range}`)
        .join(", ")}`,
    );
    this.name = "UnresolvedSpecifierError";
    this.specifiers = specifiers;
  }
}

function isBundled(name: string): boolean {
  return BUNDLED_DEPENDENCY_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * A dependency the bundle inlines is not just redundant in the published
 * manifest, it is harmful: `@pierre/diffs` is patched in this workspace, so
 * installing it from the registry would fetch a copy without the patch and
 * shadow nothing, purely adding weight and confusion.
 */
export function buildPublishManifest(input: {
  readonly source: PackageManifest;
  readonly catalog: Record<string, string>;
  readonly version: string;
}): PackageManifest {
  const published: Record<string, unknown> = {};
  for (const field of PUBLISHED_FIELDS) {
    if (input.source[field] !== undefined) {
      published[field] = input.source[field];
    }
  }
  published.version = input.version;

  const dependencies: Record<string, string> = {};
  const unresolved: Array<readonly [string, string]> = [];
  for (const [name, range] of Object.entries(input.source.dependencies ?? {})) {
    if (isBundled(name)) {
      continue;
    }
    if (range === "catalog:") {
      const resolved = input.catalog[name];
      if (resolved === undefined) {
        unresolved.push([name, range]);
        continue;
      }
      dependencies[name] = resolved;
      continue;
    }
    if (range.startsWith("catalog:") || range.startsWith("workspace:")) {
      unresolved.push([name, range]);
      continue;
    }
    dependencies[name] = range;
  }

  if (unresolved.length > 0) {
    throw new UnresolvedSpecifierError(unresolved);
  }

  published.dependencies = Object.fromEntries(
    Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b)),
  );
  return published as PackageManifest;
}

/** Mirrors `release.yml`, so npm and the desktop release cannot disagree. */
export function readVersionFromChangelog(changelog: string): string {
  const heading = changelog.split("\n").find((line) => line.startsWith("## "));
  if (heading === undefined) {
    throw new Error("Could not read a release version from CHANGELOG.md");
  }
  const raw = heading.replace(/^##\s+/, "").split(/\s/)[0] ?? "";
  const version = raw.startsWith("v") ? raw.slice(1) : raw;
  if (!/^\d+\.\d+\.\d+([.-][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid release version: ${raw}`);
  }
  return version;
}

export function parseCatalog(workspaceYaml: string): Record<string, string> {
  const parsed = YAML.parse(workspaceYaml) as { catalog?: Record<string, string> } | null;
  return parsed?.catalog ?? {};
}

const PackageJsonSchema = Schema.Record(Schema.String, Schema.Unknown);
const PackageJsonPrettyJson = fromJsonStringPretty(PackageJsonSchema);
const decodePackageJson = Schema.decodeUnknownEffect(PackageJsonPrettyJson);
const encodePackageJson = Schema.encodeEffect(PackageJsonPrettyJson);

const rootFlag = Flag.string("root").pipe(
  Flag.withDefault("."),
  Flag.withDescription("Workspace root used to resolve the manifest, catalog and changelog."),
);

const command = Command.make(
  "build-npm-publish-manifest",
  {
    output: Argument.string("output").pipe(
      Argument.withDescription("Path the published manifest is written to."),
    ),
    root: rootFlag,
  },
  ({ output, root }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const source = yield* decodePackageJson(
        yield* fs.readFileString(path.join(root, "apps/server/package.json")),
      );
      const catalog = parseCatalog(
        yield* fs.readFileString(path.join(root, "pnpm-workspace.yaml")),
      );
      const version = readVersionFromChangelog(
        yield* fs.readFileString(path.join(root, "CHANGELOG.md")),
      );

      const manifest = buildPublishManifest({ source, catalog, version });
      yield* fs.writeFileString(output, yield* encodePackageJson(manifest));
      yield* Console.log(`Wrote ${manifest.name}@${version} publish manifest to ${output}`);
    }),
).pipe(Command.withDescription("Build the npm publish manifest for the server package."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
