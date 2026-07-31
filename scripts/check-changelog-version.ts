// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";

/**
 * Fails when the changelog's top version has already been released.
 *
 * `release.yml` derives the version to release from the first `## ` heading in
 * CHANGELOG.md, and fires on every push to `main`. Two pull requests open at
 * once therefore write the same next version, and whichever merges second
 * either conflicts or aims the release at a tag that already exists. That
 * happened twice in one day: 3.5.6 and 3.5.7 were both taken out from under an
 * open branch.
 *
 * Running this on pull requests turns that into an early, obvious failure with
 * the next free version named, instead of a merge-time surprise.
 */

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

export function readChangelogVersion(changelog: string): string {
  const heading = changelog.split("\n").find((line) => line.startsWith("## "));
  if (heading === undefined) {
    throw new Error("CHANGELOG.md has no '## ' heading to derive a version from.");
  }
  // Matches release.yml: strip the marker, then cut at the first whitespace.
  const raw = heading.replace(/^##\s+/, "").split(/\s/)[0] ?? "";
  const version = raw.startsWith("v") ? raw.slice(1) : raw;
  if (!/^\d+\.\d+\.\d+([.-][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`CHANGELOG.md's first heading is not a version: '${raw}'.`);
  }
  return version;
}

export function nextFreeVersion(version: string, taken: ReadonlySet<string>): string {
  const parts = version.split(".");
  const major = Number(parts[0]);
  const minor = Number(parts[1]);
  let patch = Number(parts[2]);
  if (
    !Number.isSafeInteger(major) ||
    !Number.isSafeInteger(minor) ||
    !Number.isSafeInteger(patch)
  ) {
    return version;
  }
  let candidate = `${major}.${minor}.${patch}`;
  while (taken.has(candidate)) {
    patch += 1;
    candidate = `${major}.${minor}.${patch}`;
  }
  return candidate;
}

function releasedVersions(): ReadonlySet<string> {
  // ls-remote rather than `git tag`: CI checks out shallow and without tags,
  // so the local tag list is empty and every check would pass vacuously.
  const output = NodeChildProcess.execFileSync("git", ["ls-remote", "--tags", "origin"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const versions = new Set<string>();
  for (const line of output.split("\n")) {
    const match = line.match(/refs\/tags\/v?(\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?)(?:\^\{\})?$/);
    if (match?.[1] !== undefined) versions.add(match[1]);
  }
  return versions;
}

function main(): void {
  const version = readChangelogVersion(
    NodeFS.readFileSync(NodePath.join(repoRoot, "CHANGELOG.md"), "utf8"),
  );
  const taken = releasedVersions();

  if (taken.has(version)) {
    const suggestion = nextFreeVersion(version, taken);
    Effect.runSync(
      Console.error(
        [
          `CHANGELOG.md's top entry is ${version}, which is already released.`,
          "",
          "The release workflow takes its version from that heading, so merging this",
          `would aim a release at a tag that already exists. Rename the entry to ${suggestion}`,
          "and leave the released entries untouched, since they are shipped history.",
        ].join("\n"),
      ),
    );
    process.exit(1);
  }

  Effect.runSync(Console.log(`CHANGELOG.md's top version ${version} is unreleased.`));
}

// Only when invoked directly, so the pure helpers above can be unit tested
// without shelling out to git or reading the real changelog.
if (
  process.argv[1] !== undefined &&
  import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href
) {
  main();
}
