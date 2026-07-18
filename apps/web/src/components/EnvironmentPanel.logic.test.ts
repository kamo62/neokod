import type { VcsStatusResult } from "@neokod/contracts";
import { assert, describe, it } from "vite-plus/test";

import { buildMenuItems } from "./GitActionsControl.logic";
import {
  resolveCompareWithBaseAvailability,
  resolveEnvironmentAheadBehind,
  resolveEnvironmentBaseBranchLabel,
  resolveEnvironmentChangeStats,
  resolveEnvironmentContextualActions,
} from "./EnvironmentPanel.logic";
import { DEFAULT_CHANGE_REQUEST_TERMINOLOGY } from "../sourceControlPresentation";

function status(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/test",
    hasWorkingTreeChanges: false,
    workingTree: {
      files: [],
      insertions: 0,
      deletions: 0,
    },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  };
}

describe("resolveEnvironmentChangeStats", () => {
  it("returns zeros when there is no status", () => {
    assert.deepEqual(resolveEnvironmentChangeStats(null), {
      additions: 0,
      deletions: 0,
      changedFileCount: 0,
    });
  });

  it("reads aggregate additions/deletions and file count from working tree", () => {
    assert.deepEqual(
      resolveEnvironmentChangeStats(
        status({
          workingTree: {
            files: [
              { path: "a.ts", insertions: 3, deletions: 1 },
              { path: "b.ts", insertions: 2, deletions: 0 },
            ],
            insertions: 5,
            deletions: 1,
          },
        }),
      ),
      { additions: 5, deletions: 1, changedFileCount: 2 },
    );
  });
});

describe("resolveEnvironmentAheadBehind", () => {
  it("defaults to zero when there is no status", () => {
    assert.deepEqual(resolveEnvironmentAheadBehind(null), { ahead: 0, behind: 0 });
  });

  it("reads ahead/behind counts from status", () => {
    assert.deepEqual(resolveEnvironmentAheadBehind(status({ aheadCount: 2, behindCount: 5 })), {
      ahead: 2,
      behind: 5,
    });
  });
});

describe("resolveEnvironmentBaseBranchLabel", () => {
  it("prefers the open PR's base branch over the automatically resolved one", () => {
    const label = resolveEnvironmentBaseBranchLabel({
      gitStatus: status({
        pr: {
          number: 1,
          title: "Open PR",
          url: "https://example.com/pr/1",
          baseRef: "release",
          headRef: "feature/test",
          state: "open",
        },
      }),
      autoResolvedBaseRef: "main",
    });
    assert.equal(label, "release");
  });

  it("falls back to the automatically resolved base ref without a PR", () => {
    assert.equal(
      resolveEnvironmentBaseBranchLabel({ gitStatus: status(), autoResolvedBaseRef: "main" }),
      "main",
    );
  });

  it("returns null when neither is available", () => {
    assert.equal(
      resolveEnvironmentBaseBranchLabel({ gitStatus: null, autoResolvedBaseRef: null }),
      null,
    );
  });
});

describe("resolveEnvironmentContextualActions", () => {
  it("disables every action while a git action is running", () => {
    const gitStatus = status({ hasWorkingTreeChanges: true });
    const actions = resolveEnvironmentContextualActions({
      gitStatus,
      menuItems: buildMenuItems(gitStatus, true, true),
      isBusy: true,
      hasPrimaryRemote: true,
      terminology: DEFAULT_CHANGE_REQUEST_TERMINOLOGY,
    });
    assert.equal(actions.length, 4);
    assert.isTrue(actions.every((action) => action.disabled));
  });

  it("enables commit and commit & push with pending changes, even with nothing ahead yet", () => {
    // No commits ahead of upstream yet -- plain Push has nothing to send,
    // but Commit & Push can still create one and send it in one step.
    const gitStatus = status({ hasWorkingTreeChanges: true, aheadCount: 0 });
    const actions = resolveEnvironmentContextualActions({
      gitStatus,
      menuItems: buildMenuItems(gitStatus, false, true),
      isBusy: false,
      hasPrimaryRemote: true,
      terminology: DEFAULT_CHANGE_REQUEST_TERMINOLOGY,
    });
    const commit = actions.find((action) => action.id === "commit");
    const commitPush = actions.find((action) => action.id === "commit_push");
    const push = actions.find((action) => action.id === "push");
    assert.deepInclude(commit, { disabled: false, kind: "open_commit_dialog" });
    assert.deepInclude(commitPush, {
      disabled: false,
      kind: "run_action",
      action: "commit_push",
    });
    assert.equal(push?.disabled, true);
  });

  it("surfaces 'View PR' as an open_pr action when a PR is already open", () => {
    const gitStatus = status({
      pr: {
        number: 7,
        title: "Existing PR",
        url: "https://example.com/pr/7",
        baseRef: "main",
        headRef: "feature/test",
        state: "open",
      },
    });
    const actions = resolveEnvironmentContextualActions({
      gitStatus,
      menuItems: buildMenuItems(gitStatus, false, true),
      isBusy: false,
      hasPrimaryRemote: true,
      terminology: DEFAULT_CHANGE_REQUEST_TERMINOLOGY,
    });
    const pr = actions.find((action) => action.id === "pr");
    assert.deepInclude(pr, { label: "View PR", kind: "open_pr", disabled: false });
  });

  it("disables push/PR with a remote-setup reason when there is no primary remote", () => {
    const gitStatus = status({ hasPrimaryRemote: false, hasUpstream: false });
    const actions = resolveEnvironmentContextualActions({
      gitStatus,
      menuItems: buildMenuItems(gitStatus, false, false),
      isBusy: false,
      hasPrimaryRemote: false,
      terminology: DEFAULT_CHANGE_REQUEST_TERMINOLOGY,
    });
    const push = actions.find((action) => action.id === "push");
    const pr = actions.find((action) => action.id === "pr");
    assert.equal(push?.disabled, true);
    assert.match(push?.disabledReason ?? "", /origin/);
    assert.equal(pr?.disabled, true);
    assert.match(pr?.disabledReason ?? "", /origin/);
  });

  function commitPushAction(gitStatus: VcsStatusResult, hasPrimaryRemote = true) {
    const actions = resolveEnvironmentContextualActions({
      gitStatus,
      menuItems: buildMenuItems(gitStatus, false, hasPrimaryRemote),
      isBusy: false,
      hasPrimaryRemote,
      terminology: DEFAULT_CHANGE_REQUEST_TERMINOLOGY,
    });
    return actions.find((action) => action.id === "commit_push");
  }

  it("disables commit & push when the branch is behind upstream", () => {
    const commitPush = commitPushAction(status({ hasWorkingTreeChanges: true, behindCount: 1 }));
    assert.equal(commitPush?.disabled, true);
    assert.equal(
      commitPush?.disabledReason,
      "Branch is behind upstream. Pull/rebase before pushing.",
    );
  });

  it("disables commit & push on a detached HEAD", () => {
    const commitPush = commitPushAction(status({ hasWorkingTreeChanges: true, refName: null }));
    assert.equal(commitPush?.disabled, true);
    assert.equal(commitPush?.disabledReason, "Detached HEAD: checkout a refName before pushing.");
  });

  it("disables commit & push on a clean worktree", () => {
    const commitPush = commitPushAction(status({ hasWorkingTreeChanges: false }));
    assert.equal(commitPush?.disabled, true);
    assert.equal(commitPush?.disabledReason, "Worktree is clean. Make changes before committing.");
  });

  it("enables commit & push without an upstream when a primary remote can create one", () => {
    // First push of a new branch: no upstream yet, but a primary remote is
    // configured, so commit_push can still create + push it in one step.
    const commitPush = commitPushAction(
      status({ hasWorkingTreeChanges: true, hasUpstream: false, hasPrimaryRemote: true }),
      true,
    );
    assert.equal(commitPush?.disabled, false);
    assert.equal(commitPush?.disabledReason, null);
  });
});

describe("resolveCompareWithBaseAvailability", () => {
  it("passes through the panel's displayed base ref when everything is resolvable", () => {
    const availability = resolveCompareWithBaseAvailability({
      isServerThread: true,
      isRepo: true,
      baseBranchLabel: "release",
    });
    assert.deepEqual(availability, { disabled: false, disabledReason: null, baseRef: "release" });
  });

  it("disables Compare for draft (non-server) threads", () => {
    const availability = resolveCompareWithBaseAvailability({
      isServerThread: false,
      isRepo: true,
      baseBranchLabel: "main",
    });
    assert.equal(availability.disabled, true);
    assert.equal(availability.baseRef, null);
    assert.match(availability.disabledReason ?? "", /server threads/);
  });

  it("disables Compare when the workspace isn't a Git repo", () => {
    const availability = resolveCompareWithBaseAvailability({
      isServerThread: true,
      isRepo: false,
      baseBranchLabel: null,
    });
    assert.equal(availability.disabled, true);
    assert.equal(availability.baseRef, null);
  });

  it("disables Compare with a dedicated reason when no base can be resolved", () => {
    const availability = resolveCompareWithBaseAvailability({
      isServerThread: true,
      isRepo: true,
      baseBranchLabel: null,
    });
    assert.equal(availability.disabled, true);
    assert.equal(availability.baseRef, null);
    assert.equal(
      availability.disabledReason,
      "No base branch could be resolved to compare against.",
    );
  });
});
