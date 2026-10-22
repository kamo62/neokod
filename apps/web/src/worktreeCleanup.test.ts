import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@neokod/contracts";
import type { VcsInspectWorktreeResult } from "@neokod/contracts";
import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "./types";
import {
  finalizeThreadDeletion,
  formatWorktreePathForDisplay,
  getOrphanedWorktreePathForThread,
  planWorktreeCleanup,
  unknownWorktreeRemovalMessage,
} from "./worktreeCleanup";

const localEnvironmentId = EnvironmentId.make("environment-local");

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.make("thread-1"),
    environmentId: localEnvironmentId,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.3-codex",
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    checkpoints: [],
    activities: [],
    proposedPlans: [],
    createdAt: "2026-02-13T00:00:00.000Z",
    updatedAt: "2026-02-13T00:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  };
}

describe("getOrphanedWorktreePathForThread", () => {
  it("returns null when the target thread does not exist", () => {
    const result = getOrphanedWorktreePathForThread([], ThreadId.make("missing-thread"));
    expect(result).toBeNull();
  });

  it("returns null when the target thread has no worktree", () => {
    const threads = [makeThread()];
    const result = getOrphanedWorktreePathForThread(threads, ThreadId.make("thread-1"));
    expect(result).toBeNull();
  });

  it("returns the path when no other thread links to that worktree", () => {
    const threads = [makeThread({ worktreePath: "/tmp/repo/worktrees/feature-a" })];
    const result = getOrphanedWorktreePathForThread(threads, ThreadId.make("thread-1"));
    expect(result).toBe("/tmp/repo/worktrees/feature-a");
  });

  it("returns null when another thread links to the same worktree", () => {
    const threads = [
      makeThread({
        id: ThreadId.make("thread-1"),
        worktreePath: "/tmp/repo/worktrees/feature-a",
      }),
      makeThread({
        id: ThreadId.make("thread-2"),
        worktreePath: "/tmp/repo/worktrees/feature-a",
      }),
    ];
    const result = getOrphanedWorktreePathForThread(threads, ThreadId.make("thread-1"));
    expect(result).toBeNull();
  });

  it("ignores threads linked to different worktrees", () => {
    const threads = [
      makeThread({
        id: ThreadId.make("thread-1"),
        worktreePath: "/tmp/repo/worktrees/feature-a",
      }),
      makeThread({
        id: ThreadId.make("thread-2"),
        worktreePath: "/tmp/repo/worktrees/feature-b",
      }),
    ];
    const result = getOrphanedWorktreePathForThread(threads, ThreadId.make("thread-1"));
    expect(result).toBe("/tmp/repo/worktrees/feature-a");
  });
});

describe("planWorktreeCleanup", () => {
  function makeInspect(
    overrides: Partial<VcsInspectWorktreeResult> = {},
  ): VcsInspectWorktreeResult {
    return {
      path: "/tmp/repo/worktrees/neokod-abcd1234",
      exists: true,
      refName: "neokod/abcd1234",
      headSha: "abcd1234abcd1234abcd1234abcd1234abcd1234",
      changedFileCount: 0,
      untrackedFileCount: 0,
      ignoredFileCount: 0,
      localOnlyCommitCount: 0,
      branchReclaimable: true,
      linkedThreads: [],
      ...overrides,
    };
  }

  it("keeps the worktree when another thread is linked", () => {
    const plan = planWorktreeCleanup(
      makeInspect({
        linkedThreads: [{ threadId: ThreadId.make("thread-2"), title: "Other thread" }],
      }),
    );
    expect(plan).toEqual({ kind: "keep" });
  });

  it("asks one confirm for a clean worktree and names the full path", () => {
    const plan = planWorktreeCleanup(makeInspect());
    expect(plan.kind).toBe("prompt");
    if (plan.kind !== "prompt") return;
    expect(plan.confirmMessage).toContain("/tmp/repo/worktrees/neokod-abcd1234");
    expect(plan.confirmMessage).toContain("Branch neokod/abcd1234 will be deleted too.");
    expect(plan.discardMessage).toBeNull();
  });

  it("requires a discard confirm when there are changed or untracked files", () => {
    const plan = planWorktreeCleanup(
      makeInspect({ changedFileCount: 2, untrackedFileCount: 1, branchReclaimable: true }),
    );
    expect(plan.kind).toBe("prompt");
    if (plan.kind !== "prompt") return;
    expect(plan.confirmMessage).toContain("2 changed files");
    expect(plan.confirmMessage).toContain("1 untracked file");
    expect(plan.discardMessage).not.toBeNull();
    expect(plan.discardMessage).toContain("/tmp/repo/worktrees/neokod-abcd1234");
    expect(plan.discardMessage).toContain("2 changed files");
    expect(plan.discardMessage).toContain("1 untracked file");
    expect(plan.discardMessage).toContain("This cannot be undone.");
  });

  it("requires a discard confirm when only ignored files would be deleted", () => {
    const plan = planWorktreeCleanup(makeInspect({ ignoredFileCount: 2, branchReclaimable: true }));
    expect(plan.kind).toBe("prompt");
    if (plan.kind !== "prompt") return;
    expect(plan.confirmMessage).toContain("2 ignored files");
    expect(plan.discardMessage).not.toBeNull();
    expect(plan.discardMessage).toContain("2 ignored files");
  });

  it("flags unreachable commits on a detached HEAD", () => {
    const plan = planWorktreeCleanup(
      makeInspect({ refName: null, localOnlyCommitCount: 3, branchReclaimable: false }),
    );
    expect(plan.kind).toBe("prompt");
    if (plan.kind !== "prompt") return;
    expect(plan.confirmMessage).toContain("Detached HEAD (3 commits exist only here).");
    expect(plan.discardMessage).not.toBeNull();
    expect(plan.discardMessage).toContain("3 commits not on any branch");
  });

  it("keeps the branch line when the branch has unique commits", () => {
    const plan = planWorktreeCleanup(
      makeInspect({ localOnlyCommitCount: 1, branchReclaimable: false }),
    );
    expect(plan.kind).toBe("prompt");
    if (plan.kind !== "prompt") return;
    expect(plan.confirmMessage).toContain(
      "Branch neokod/abcd1234 is kept (1 commit exist only on it).",
    );
    expect(plan.discardMessage).toBeNull();
  });

  it("reports a lost acknowledgement as an unknown removal outcome", () => {
    expect(unknownWorktreeRemovalMessage("/tmp/repo/worktrees/neokod-abcd1234")).toBe(
      "Thread deleted; could not confirm worktree removal. Check /tmp/repo/worktrees/neokod-abcd1234 before retrying.",
    );
    expect(unknownWorktreeRemovalMessage("/tmp/repo/worktrees/neokod-abcd1234")).not.toContain(
      "was kept",
    );
  });
});

describe("finalizeThreadDeletion", () => {
  it("keeps a successful thread deletion when worktree cleanup fails", async () => {
    const cleanupFailure = { message: "worktree kept" };
    let cleanupCalls = 0;

    const outcome = await finalizeThreadDeletion({
      deletion: { _tag: "Success" as const, value: "deleted" },
      deletionSucceeded: true,
      candidates: ["candidate"],
      cleanup: async () => {
        cleanupCalls += 1;
        return cleanupFailure;
      },
    });

    expect(outcome.deletion).toEqual({ _tag: "Success", value: "deleted" });
    expect(outcome.cleanupFailure).toBe(cleanupFailure);
    expect(cleanupCalls).toBe(1);
  });

  it("does not run worktree cleanup when the deletion failed", async () => {
    let cleanupCalls = 0;

    const outcome = await finalizeThreadDeletion({
      deletion: { _tag: "Failure" as const },
      deletionSucceeded: false,
      candidates: ["candidate"],
      cleanup: async () => {
        cleanupCalls += 1;
        return null;
      },
    });

    expect(outcome.deletion).toEqual({ _tag: "Failure" });
    expect(outcome.cleanupFailure).toBeNull();
    expect(cleanupCalls).toBe(0);
  });
});

describe("formatWorktreePathForDisplay", () => {
  it("shows only the last path segment for unix-like paths", () => {
    const result = formatWorktreePathForDisplay(
      "/Users/julius/.neokod/worktrees/neokod-mvp/neokod-4e609bb8",
    );
    expect(result).toBe("neokod-4e609bb8");
  });

  it("normalizes windows separators before selecting the final segment", () => {
    const result = formatWorktreePathForDisplay(
      "C:\\Users\\julius\\.neokod\\worktrees\\neokod-mvp\\neokod-4e609bb8",
    );
    expect(result).toBe("neokod-4e609bb8");
  });

  it("uses the final segment even when outside ~/.neokod/worktrees", () => {
    const result = formatWorktreePathForDisplay("/tmp/custom-worktrees/my-worktree");
    expect(result).toBe("my-worktree");
  });

  it("ignores trailing slashes", () => {
    const result = formatWorktreePathForDisplay("/tmp/custom-worktrees/my-worktree/");
    expect(result).toBe("my-worktree");
  });
});
