import { parseSemver } from "@neokod/shared/semver";

/**
 * OpenCode 2 moved to a different CLI, transport and event model. Neokod's
 * runtime and its `@opencode-ai/sdk` adapter still speak the 1.x protocol, so
 * the major version is the capability boundary: a 1.x install is supported,
 * anything newer is rejected before Neokod starts its HTTP server.
 */
export const SUPPORTED_OPENCODE_MAJOR = 1;

export interface OpenCodeVersion {
  readonly version: string;
  readonly major: number;
  readonly supported: boolean;
}

const OPENCODE_VERSION_PATTERN = /(?:^|\s)v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/;

/**
 * Extract the version from `opencode --version`.
 *
 * OpenCode 1.x prints `opencode 1.18.15`; OpenCode 2 prints the same banner
 * with a `v` prefix (`opencode v2.0.32`). The generic provider parser only
 * understands the unprefixed form, and the prefix must not decide support.
 */
export function parseOpenCodeVersionOutput(output: string): string | null {
  const match = output.match(OPENCODE_VERSION_PATTERN);
  const rawVersion = match?.[1];
  if (!rawVersion) {
    return null;
  }
  return normalizeOpenCodeVersion(rawVersion);
}

export function classifyOpenCodeVersion(version: string): OpenCodeVersion | null {
  const parsed = parseSemver(version);
  if (!parsed) {
    return null;
  }
  const normalized = formatParsedVersion(parsed);
  return {
    version: normalized,
    major: parsed.major,
    supported: parsed.major === SUPPORTED_OPENCODE_MAJOR,
  };
}

export function formatOpenCodeUnsupportedVersionMessage(version: OpenCodeVersion): string {
  return `OpenCode v${version.version} is installed. OpenCode 2 is not supported yet; install OpenCode 1.x to use this provider.`;
}

function normalizeOpenCodeVersion(version: string): string | null {
  const parsed = parseSemver(version);
  return parsed ? formatParsedVersion(parsed) : null;
}

interface ParsedVersionParts {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: ReadonlyArray<string>;
}

function formatParsedVersion(parsed: ParsedVersionParts): string {
  const prerelease = parsed.prerelease.length > 0 ? `-${parsed.prerelease.join(".")}` : "";
  return `${parsed.major}.${parsed.minor}.${parsed.patch}${prerelease}`;
}
