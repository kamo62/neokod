import type {
  VcsRef,
  SourceControlProviderInfo,
  VcsStatusLocalResult,
  VcsStatusRemoteResult,
  VcsStatusResult,
  VcsStatusStreamEvent,
} from "@neokod/contracts";
import * as Arr from "effect/Array";
import * as Result from "effect/Result";
import { detectSourceControlProviderFromRemoteUrl } from "./sourceControl.ts";

export const WORKTREE_BRANCH_PREFIX = "neokod";
const TEMP_WORKTREE_BRANCH_PATTERN = new RegExp(`^${WORKTREE_BRANCH_PREFIX}\\/[0-9a-f]{8}$`);

// Git 2.24 added `--end-of-options`; all other invocations rely on these pure
// validators plus `--`, which work on every git version the driver supports.
const FORBIDDEN_REF_CHARACTERS = [" ", "~", "^", ":", "?", "*", "[", "\\"];

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Returns a human readable problem, or null when `value` is safe to pass as a git ref or remote name. */
export function validateGitRefName(value: string, label = "Ref name"): string | null {
  if (value.length === 0) return `${label} is required.`;
  if (value.length > 255) return `${label} is longer than 255 characters.`;
  if (value.startsWith("-")) return `${label} must not start with '-'.`;
  if (hasControlCharacter(value)) return `${label} contains a control character.`;
  if (FORBIDDEN_REF_CHARACTERS.some((character) => value.includes(character))) {
    return `${label} contains an unsupported character.`;
  }
  if (value.includes("..")) return `${label} must not contain '..'.`;
  if (value.includes("@{")) return `${label} must not contain '@{'.`;
  if (value === "@") return `${label} must not be '@'.`;
  if (value.startsWith("/") || value.endsWith("/")) {
    return `${label} must not start or end with '/'.`;
  }
  if (value.includes("//")) return `${label} must not contain '//'.`;
  if (value.endsWith(".")) return `${label} must not end with '.'.`;
  if (
    value.split("/").some((component) => component.startsWith(".") || component.endsWith(".lock"))
  ) {
    return `${label} contains an invalid path component.`;
  }
  return null;
}

/** For revisions, URLs and similar free text that go on a git command line (no ref grammar). */
export function validateGitArgumentValue(value: string, label: string): string | null {
  if (value.length === 0) return `${label} is required.`;
  if (value.startsWith("-")) return `${label} must not start with '-'.`;
  if (hasControlCharacter(value)) return `${label} contains a control character.`;
  return null;
}

/**
 * Sanitize an arbitrary string into a valid, lowercase git refName fragment.
 * Strips quotes, collapses separators, limits to 64 chars.
 */
export function sanitizeBranchFragment(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/['"`]/g, "")
    .replace(/^[./\s_-]+|[./\s_-]+$/g, "");

  const branchFragment = normalized
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");

  return branchFragment.length > 0 ? branchFragment : "update";
}

/**
 * Sanitize a string into a `feature/…` refName name.
 * Preserves an existing `feature/` prefix or slash-separated namespace.
 */
export function sanitizeFeatureBranchName(raw: string): string {
  const sanitized = sanitizeBranchFragment(raw);
  if (sanitized.includes("/")) {
    return sanitized.startsWith("feature/") ? sanitized : `feature/${sanitized}`;
  }
  return `feature/${sanitized}`;
}

const AUTO_FEATURE_BRANCH_FALLBACK = "feature/update";

/**
 * Resolve a unique `feature/…` refName name that doesn't collide with
 * any existing refName. Appends a numeric suffix when needed.
 */
export function resolveAutoFeatureBranchName(
  existingBranchNames: readonly string[],
  preferredBranch?: string,
): string {
  const preferred = preferredBranch?.trim();
  const resolvedBase = sanitizeFeatureBranchName(
    preferred && preferred.length > 0 ? preferred : AUTO_FEATURE_BRANCH_FALLBACK,
  );
  const existingNames = new Set(existingBranchNames.map((refName) => refName.toLowerCase()));

  if (!existingNames.has(resolvedBase)) {
    return resolvedBase;
  }

  let suffix = 2;
  while (existingNames.has(`${resolvedBase}-${suffix}`)) {
    suffix += 1;
  }

  return `${resolvedBase}-${suffix}`;
}

/**
 * Strip the remote prefix from a remote ref such as `origin/feature/demo`.
 */
export function deriveLocalBranchNameFromRemoteRef(branchName: string): string {
  const firstSeparatorIndex = branchName.indexOf("/");
  if (firstSeparatorIndex <= 0 || firstSeparatorIndex === branchName.length - 1) {
    return branchName;
  }
  return branchName.slice(firstSeparatorIndex + 1);
}

export function buildTemporaryWorktreeBranchName(
  randomHex: (byteLength: number) => string,
): string {
  const token = randomHex(4).toLowerCase();
  return `${WORKTREE_BRANCH_PREFIX}/${token}`;
}

export function isTemporaryWorktreeBranch(refName: string): boolean {
  return TEMP_WORKTREE_BRANCH_PATTERN.test(refName.trim().toLowerCase());
}

/**
 * Normalize a git remote URL into a stable comparison key.
 */
export function normalizeGitRemoteUrl(value: string): string {
  const normalized = value
    .trim()
    .replace(/\/+$/g, "")
    .replace(/\.git$/i, "")
    .toLowerCase();

  if (/^(?:ssh|https?|git):\/\//i.test(normalized)) {
    try {
      const url = new URL(normalized);
      const repositoryPath = url.pathname
        .split("/")
        .filter((segment) => segment.length > 0)
        .join("/");
      if (url.hostname && repositoryPath.includes("/")) {
        return `${url.hostname}/${repositoryPath}`;
      }
    } catch {
      return normalized;
    }
  }

  const scpStyleHostAndPath = /^git@([^:/\s]+)[:/]([^/\s]+(?:\/[^/\s]+)+)$/i.exec(normalized);
  if (scpStyleHostAndPath?.[1] && scpStyleHostAndPath[2]) {
    return `${scpStyleHostAndPath[1]}/${scpStyleHostAndPath[2]}`;
  }

  return normalized;
}

/**
 * Best-effort parse of a GitHub `owner/repo` identifier from common remote URL shapes.
 */
export function parseGitHubRepositoryNameWithOwnerFromRemoteUrl(url: string | null): string | null {
  const trimmed = url?.trim() ?? "";
  if (trimmed.length === 0) {
    return null;
  }

  const match =
    /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/|git:\/\/github\.com\/)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(
      trimmed,
    );
  const repositoryNameWithOwner = match?.[1]?.trim() ?? "";
  return repositoryNameWithOwner.length > 0 ? repositoryNameWithOwner : null;
}

function deriveLocalBranchNameCandidatesFromRemoteRef(
  branchName: string,
  remoteName?: string,
): ReadonlyArray<string> {
  const candidates = new Set<string>();
  const firstSlashCandidate = deriveLocalBranchNameFromRemoteRef(branchName);
  if (firstSlashCandidate.length > 0) {
    candidates.add(firstSlashCandidate);
  }

  if (remoteName) {
    const remotePrefix = `${remoteName}/`;
    if (branchName.startsWith(remotePrefix) && branchName.length > remotePrefix.length) {
      candidates.add(branchName.slice(remotePrefix.length));
    }
  }

  return [...candidates];
}

/**
 * Hide `origin/*` remote refs when a matching local refName already exists.
 */
export function dedupeRemoteBranchesWithLocalMatches(
  refs: ReadonlyArray<VcsRef>,
): ReadonlyArray<VcsRef> {
  const localBranchNames = new Set(
    Arr.filterMap(refs, (refName) =>
      refName.isRemote ? Result.failVoid : Result.succeed(refName.name),
    ),
  );

  return refs.filter((refName) => {
    if (!refName.isRemote) {
      return true;
    }

    if (refName.remoteName !== "origin") {
      return true;
    }

    const localBranchCandidates = deriveLocalBranchNameCandidatesFromRemoteRef(
      refName.name,
      refName.remoteName,
    );
    return !localBranchCandidates.some((candidate) => localBranchNames.has(candidate));
  });
}

export function detectSourceControlProviderFromGitRemoteUrl(
  remoteUrl: string,
): SourceControlProviderInfo | null {
  return detectSourceControlProviderFromRemoteUrl(remoteUrl);
}

const EMPTY_GIT_STATUS_REMOTE: VcsStatusRemoteResult = {
  hasUpstream: false,
  aheadCount: 0,
  behindCount: 0,
  aheadOfDefaultCount: 0,
  pr: null,
};

export function mergeGitStatusParts(
  local: VcsStatusLocalResult,
  remote: VcsStatusRemoteResult | null,
): VcsStatusResult {
  return {
    ...local,
    ...(remote ?? EMPTY_GIT_STATUS_REMOTE),
  };
}

function toRemoteStatusPart(status: VcsStatusResult): VcsStatusRemoteResult {
  return {
    hasUpstream: status.hasUpstream,
    aheadCount: status.aheadCount,
    behindCount: status.behindCount,
    ...(status.aheadOfDefaultCount === undefined
      ? {}
      : { aheadOfDefaultCount: status.aheadOfDefaultCount }),
    pr: status.pr,
  };
}

function toLocalStatusPart(status: VcsStatusResult): VcsStatusLocalResult {
  return {
    isRepo: status.isRepo,
    ...(status.sourceControlProvider
      ? { sourceControlProvider: status.sourceControlProvider }
      : {}),
    hasPrimaryRemote: status.hasPrimaryRemote,
    isDefaultRef: status.isDefaultRef,
    refName: status.refName,
    hasWorkingTreeChanges: status.hasWorkingTreeChanges,
    workingTree: status.workingTree,
    ...(status.operationInProgress ? { operationInProgress: status.operationInProgress } : {}),
    ...(status.unmergedPaths && status.unmergedPaths.length > 0
      ? { unmergedPaths: status.unmergedPaths }
      : {}),
  };
}

export function applyGitStatusStreamEvent(
  current: VcsStatusResult | null,
  event: VcsStatusStreamEvent,
): VcsStatusResult {
  switch (event._tag) {
    case "snapshot":
      return mergeGitStatusParts(event.local, event.remote);
    case "localUpdated":
      return mergeGitStatusParts(event.local, current ? toRemoteStatusPart(current) : null);
    case "remoteUpdated":
      if (current === null) {
        return mergeGitStatusParts(
          {
            isRepo: true,
            hasPrimaryRemote: false,
            isDefaultRef: false,
            refName: null,
            hasWorkingTreeChanges: false,
            workingTree: { files: [], insertions: 0, deletions: 0 },
          },
          event.remote,
        );
      }
      return mergeGitStatusParts(toLocalStatusPart(current), event.remote);
  }
}
