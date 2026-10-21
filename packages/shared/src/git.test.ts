import type { VcsStatusRemoteResult, VcsStatusResult } from "@neokod/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyGitStatusStreamEvent,
  buildTemporaryWorktreeBranchName,
  isTemporaryWorktreeBranch,
  normalizeGitRemoteUrl,
  parseGitHubRepositoryNameWithOwnerFromRemoteUrl,
  validateGitArgumentValue,
  validateGitRefName,
  WORKTREE_BRANCH_PREFIX,
} from "./git.ts";

describe("normalizeGitRemoteUrl", () => {
  it("canonicalizes equivalent GitHub remotes across protocol variants", () => {
    expect(normalizeGitRemoteUrl("git@github.com:Kamo62/neokod.git")).toBe(
      "github.com/kamo62/neokod",
    );
    expect(normalizeGitRemoteUrl("https://github.com/Kamo62/neokod.git")).toBe(
      "github.com/kamo62/neokod",
    );
    expect(normalizeGitRemoteUrl("ssh://git@github.com/Kamo62/neokod")).toBe(
      "github.com/kamo62/neokod",
    );
  });

  it("preserves nested group paths for providers like GitLab", () => {
    expect(normalizeGitRemoteUrl("git@gitlab.com:Kamo62/platform/neokod.git")).toBe(
      "gitlab.com/kamo62/platform/neokod",
    );
    expect(normalizeGitRemoteUrl("https://gitlab.com/Kamo62/platform/neokod.git")).toBe(
      "gitlab.com/kamo62/platform/neokod",
    );
  });

  it("drops explicit ports from URL-shaped remotes", () => {
    expect(normalizeGitRemoteUrl("https://gitlab.company.com:8443/team/project.git")).toBe(
      "gitlab.company.com/team/project",
    );
    expect(normalizeGitRemoteUrl("ssh://git@gitlab.company.com:2222/team/project.git")).toBe(
      "gitlab.company.com/team/project",
    );
  });
});

describe("parseGitHubRepositoryNameWithOwnerFromRemoteUrl", () => {
  it("extracts the owner and repository from common GitHub remote shapes", () => {
    expect(
      parseGitHubRepositoryNameWithOwnerFromRemoteUrl("git@github.com:Kamo62/neokod.git"),
    ).toBe("Kamo62/neokod");
    expect(
      parseGitHubRepositoryNameWithOwnerFromRemoteUrl("https://github.com/Kamo62/neokod.git"),
    ).toBe("Kamo62/neokod");
  });
});

describe("isTemporaryWorktreeBranch", () => {
  it("matches the generated temporary worktree refName format", () => {
    expect(
      isTemporaryWorktreeBranch(
        buildTemporaryWorktreeBranchName((byteLength) => {
          expect(byteLength).toBe(4);
          return "DEADBEEF";
        }),
      ),
    ).toBe(true);
  });

  it("matches generated temporary worktree refs", () => {
    expect(isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}/deadbeef`)).toBe(true);
    expect(isTemporaryWorktreeBranch(` ${WORKTREE_BRANCH_PREFIX}/deadbeef `)).toBe(true);
    expect(isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}/DEADBEEF`)).toBe(true);
  });

  it("rejects non-temporary refName names", () => {
    expect(isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}/feature/demo`)).toBe(false);
    expect(isTemporaryWorktreeBranch("main")).toBe(false);
    expect(isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}/deadbeef-extra`)).toBe(false);
  });
});

describe("validateGitRefName", () => {
  it("accepts ordinary names", () => {
    for (const name of [
      "main",
      "feature/x",
      "release-1.2",
      "origin/main",
      "neokod/abcd1234",
      "é",
      "feature/ünï",
      "a@b",
    ]) {
      expect(validateGitRefName(name)).toBeNull();
    }
  });

  it("rejects option-like and malformed names", () => {
    const rejected = [
      "-f",
      "--upload-pack=x",
      "-",
      "a..b",
      "a b",
      "a\tb",
      "a~1",
      "a^",
      "a:b",
      "a?",
      "a*",
      "a[",
      "a\\b",
      "a@{b",
      "@",
      "a.lock",
      "a/.hidden",
      "a/",
      "/a",
      "a//b",
      "a.",
      "",
      "a".repeat(256),
      "\u0000",
      "\u007f",
    ];
    for (const name of rejected) {
      expect(validateGitRefName(name), name).not.toBeNull();
    }
    expect(validateGitRefName("-f")).toContain("'-'");
  });
});

describe("validateGitArgumentValue", () => {
  it("allows revisions and urls", () => {
    for (const value of ["origin/main", "HEAD~3", "https://x/y.git"]) {
      expect(validateGitArgumentValue(value, "Value")).toBeNull();
    }
  });

  it("rejects options and embedded newlines", () => {
    expect(validateGitArgumentValue("--output=/tmp/x", "Value")).not.toBeNull();
    expect(validateGitArgumentValue("a\nb", "Value")).not.toBeNull();
  });
});

describe("applyGitStatusStreamEvent", () => {
  it("treats a remote-only update as a repository when local state is missing", () => {
    const remote: VcsStatusRemoteResult = {
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 1,
      pr: null,
    };

    expect(applyGitStatusStreamEvent(null, { _tag: "remoteUpdated", remote })).toEqual({
      isRepo: true,
      hasPrimaryRemote: false,
      isDefaultRef: false,
      refName: null,
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 1,
      pr: null,
    });
  });

  it("preserves local-only fields when applying a remote update", () => {
    const current: VcsStatusResult = {
      isRepo: true,
      sourceControlProvider: {
        kind: "github",
        name: "GitHub",
        baseUrl: "https://github.com",
      },
      hasPrimaryRemote: true,
      isDefaultRef: false,
      refName: "feature/demo",
      hasWorkingTreeChanges: true,
      workingTree: {
        files: [{ path: "src/demo.ts", insertions: 1, deletions: 0 }],
        insertions: 1,
        deletions: 0,
      },
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    };

    const remote: VcsStatusRemoteResult = {
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 1,
      pr: null,
    };

    expect(applyGitStatusStreamEvent(current, { _tag: "remoteUpdated", remote })).toEqual({
      ...current,
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 1,
      pr: null,
    });
  });

  it("keeps conflict fields across a remoteUpdated event", () => {
    const current: VcsStatusResult = {
      isRepo: true,
      hasPrimaryRemote: true,
      isDefaultRef: false,
      refName: "feature/demo",
      hasWorkingTreeChanges: true,
      workingTree: {
        files: [{ path: "a.txt", insertions: 0, deletions: 0 }],
        insertions: 0,
        deletions: 0,
      },
      operationInProgress: "merge",
      unmergedPaths: ["a.txt"],
      hasUpstream: true,
      aheadCount: 1,
      behindCount: 0,
      pr: null,
    };

    const remote: VcsStatusRemoteResult = {
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 0,
      pr: null,
    };

    expect(applyGitStatusStreamEvent(current, { _tag: "remoteUpdated", remote })).toEqual({
      ...current,
      aheadCount: 2,
    });
  });
});
