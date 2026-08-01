// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?$/;

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
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`CHANGELOG.md's first heading is not a version: '${raw}'.`);
  }
  return version;
}

export interface GitRemote {
  readonly name: string;
  readonly url: string;
}

/** Parses the fetch entries printed by `git remote -v`. */
export function parseGitRemoteList(output: string): ReadonlyArray<GitRemote> {
  const remotes = new Map<string, GitRemote>();
  for (const line of output.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3 || fields[2] !== "(fetch)") continue;
    const name = fields[0];
    const url = fields[1];
    if (name === undefined || url === undefined) continue;
    remotes.set(`${name}\u0000${url}`, { name, url });
  }
  return [...remotes.values()];
}

/** Normalizes HTTPS, SSH and scp-style Git URLs for repository identity checks. */
export function canonicalRepositoryKey(remoteUrl: string): string | undefined {
  const trimmed = remoteUrl.trim();
  const scpStyle = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(trimmed);
  let host: string;
  let repositoryPath: string;

  if (!trimmed.includes("://") && scpStyle?.[1] !== undefined && scpStyle[2] !== undefined) {
    host = scpStyle[1];
    repositoryPath = scpStyle[2];
  } else {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return undefined;
    }
    host = parsed.hostname;
    repositoryPath = parsed.pathname;
  }

  const normalizedPath = repositoryPath.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  if (host.length === 0 || normalizedPath.length === 0) return undefined;
  return `${host.toLowerCase()}/${normalizedPath.toLowerCase()}`;
}

/**
 * Chooses the remote used for releases. A repository identity match is
 * required because choosing an unrelated remote would make the check pass
 * vacuously.
 */
export function resolveReleaseRemotes(
  remotes: ReadonlyArray<GitRemote>,
  releaseRepositoryUrl: string,
): ReadonlyArray<GitRemote> {
  if (remotes.length === 0) {
    throw new Error(
      "Cannot determine the release remote: this clone has no Git remotes configured.",
    );
  }

  const releaseRepositoryKey = canonicalRepositoryKey(releaseRepositoryUrl);
  if (releaseRepositoryKey === undefined) {
    throw new Error(
      `Cannot determine the release remote: invalid release repository URL '${releaseRepositoryUrl}'.`,
    );
  }

  const matchingRemotes = remotes.filter(
    (remote) => canonicalRepositoryKey(remote.url) === releaseRepositoryKey,
  );
  if (matchingRemotes.length > 0) return matchingRemotes;

  const configured = remotes.map((remote) => `${remote.name}=${remote.url}`).join(", ");
  throw new Error(
    [
      `Cannot determine the release remote for '${releaseRepositoryUrl}'.`,
      `No configured remote matches that repository, and more than one remote exists: ${configured}.`,
      "Configure a remote for the release repository before running this check.",
    ].join(" "),
  );
}

export function parsePublishedVersions(output: string): ReadonlySet<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (cause) {
    throw new Error("npm returned invalid JSON while listing published neokod versions.", {
      cause,
    });
  }

  const values = Array.isArray(parsed) ? parsed : [parsed];
  const versions = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const version = value.startsWith("v") ? value.slice(1) : value;
    if (VERSION_PATTERN.test(version)) versions.add(version);
  }
  return versions;
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

function readReleaseMetadata(): { readonly packageName: string; readonly repositoryUrl: string } {
  const packageJson = JSON.parse(
    NodeFS.readFileSync(NodePath.join(repoRoot, "apps/server/package.json"), "utf8"),
  ) as { name?: unknown; repository?: unknown };
  const packageName = packageJson.name;
  const repository = packageJson.repository;
  const repositoryUrl =
    typeof repository === "string"
      ? repository
      : typeof repository === "object" && repository !== null && "url" in repository
        ? (repository as { url?: unknown }).url
        : undefined;
  if (typeof packageName !== "string" || typeof repositoryUrl !== "string") {
    throw new Error("apps/server/package.json does not declare a release package and repository.");
  }
  return { packageName, repositoryUrl };
}

function releasedTagVersions(repositoryUrl: string): ReadonlySet<string> {
  let remoteOutput: string;
  try {
    remoteOutput = NodeChildProcess.execFileSync("git", ["remote", "-v"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
  } catch (cause) {
    throw new Error("Could not read Git remotes while determining the release remote.", { cause });
  }

  const remotes = resolveReleaseRemotes(parseGitRemoteList(remoteOutput), repositoryUrl);
  const versions = new Set<string>();
  for (const remote of remotes) {
    let output: string;
    try {
      // ls-remote rather than `git tag`: CI checks out shallow and without tags.
      output = NodeChildProcess.execFileSync("git", ["ls-remote", "--tags", remote.name], {
        cwd: repoRoot,
        encoding: "utf8",
      });
    } catch (cause) {
      throw new Error(`Could not read release tags from remote '${remote.name}'.`, { cause });
    }
    for (const line of output.split("\n")) {
      const match = line.match(/refs\/tags\/v?(\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?)(?:\^\{\})?$/);
      if (match?.[1] !== undefined) versions.add(match[1]);
    }
  }
  return versions;
}

function releasedVersions(): ReadonlySet<string> {
  const { packageName, repositoryUrl } = readReleaseMetadata();
  const versions = new Set(releasedTagVersions(repositoryUrl));

  let npmOutput: string;
  try {
    npmOutput = NodeChildProcess.execFileSync("npm", ["view", packageName, "versions", "--json"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
  } catch (cause) {
    throw new Error(`Could not read published versions for npm package '${packageName}'.`, {
      cause,
    });
  }
  for (const version of parsePublishedVersions(npmOutput)) versions.add(version);
  if (versions.size === 0) {
    throw new Error(
      `Release tags and npm package '${packageName}' returned no released versions; refusing to pass vacuously.`,
    );
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
