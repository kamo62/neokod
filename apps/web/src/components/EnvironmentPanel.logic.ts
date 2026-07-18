import type { GitStackedAction, VcsStatusResult } from "@neokod/contracts";

import { getMenuActionDisabledReason, type GitActionMenuItem } from "./GitActionsControl.logic";
import type { ChangeRequestTerminology } from "../sourceControlPresentation";

/**
 * Pure derivations for the unified Environment right-panel. These read the
 * same `VcsStatusResult` and `GitActionMenuItem[]` already produced by
 * `useGitActionsController` (which itself wraps `GitActionsControl.logic`),
 * so the panel never re-derives push/commit/PR availability on its own —
 * only the "Commit & push" combined action, which has no existing
 * equivalent, gets new logic here.
 */

export interface EnvironmentChangeStats {
  readonly additions: number;
  readonly deletions: number;
  readonly changedFileCount: number;
}

export function resolveEnvironmentChangeStats(
  gitStatus: VcsStatusResult | null,
): EnvironmentChangeStats {
  if (!gitStatus) {
    return { additions: 0, deletions: 0, changedFileCount: 0 };
  }
  return {
    additions: gitStatus.workingTree.insertions,
    deletions: gitStatus.workingTree.deletions,
    changedFileCount: gitStatus.workingTree.files.length,
  };
}

export interface EnvironmentAheadBehind {
  readonly ahead: number;
  readonly behind: number;
}

export function resolveEnvironmentAheadBehind(
  gitStatus: VcsStatusResult | null,
): EnvironmentAheadBehind {
  return {
    ahead: gitStatus?.aheadCount ?? 0,
    behind: gitStatus?.behindCount ?? 0,
  };
}

/**
 * "Base branch" for display purposes: an open PR's declared base wins
 * (it's the ground truth for where the change will land); otherwise fall
 * back to whatever base ref the Diff panel would resolve automatically for
 * this branch (already-fetched by the caller, no new query introduced
 * here).
 */
export function resolveEnvironmentBaseBranchLabel(input: {
  gitStatus: VcsStatusResult | null;
  autoResolvedBaseRef: string | null;
}): string | null {
  if (input.gitStatus?.pr) {
    return input.gitStatus.pr.baseRef;
  }
  return input.autoResolvedBaseRef;
}

export interface CompareWithBaseAvailability {
  readonly disabled: boolean;
  readonly disabledReason: string | null;
  /**
   * The exact base ref to write into the Diff panel's selection. Never
   * `null` when `disabled` is `false` -- "automatic" resolution is resolved
   * here, once, so the ref the panel opens the Diff surface with always
   * matches the one it just displayed (a PR targeting "release" must not
   * silently open a diff against an automatically-resolved "main").
   */
  readonly baseRef: string | null;
}

/**
 * Gates the "Compare with base" action. Mirrors the same
 * `isServerThread && isRepo` condition `RightPanelTabs`/`ChatView` already
 * use to gate the Diff surface itself (drafts have no diff surface to open
 * yet), plus a panel-specific check: never open a diff range against a base
 * we couldn't actually resolve.
 */
export function resolveCompareWithBaseAvailability(input: {
  isServerThread: boolean;
  isRepo: boolean;
  baseBranchLabel: string | null;
}): CompareWithBaseAvailability {
  if (!input.isServerThread || !input.isRepo) {
    return {
      disabled: true,
      // Mirrors RightPanelTabs' SURFACE_DISABLED_REASONS.diff wording so the
      // two surfaces never disagree about why Diff is unavailable.
      disabledReason: "Diff is only available for server threads in Git repositories.",
      baseRef: null,
    };
  }
  if (!input.baseBranchLabel) {
    return {
      disabled: true,
      disabledReason: "No base branch could be resolved to compare against.",
      baseRef: null,
    };
  }
  return { disabled: false, disabledReason: null, baseRef: input.baseBranchLabel };
}

export type EnvironmentActionId = "commit" | "commit_push" | "push" | "pr";
export type EnvironmentActionKind = "open_commit_dialog" | "run_action" | "open_pr";

export interface EnvironmentContextualAction {
  readonly id: EnvironmentActionId;
  readonly label: string;
  readonly disabled: boolean;
  readonly disabledReason: string | null;
  readonly kind: EnvironmentActionKind;
  readonly action?: GitStackedAction;
}

function resolveCommitPushAction(input: {
  gitStatus: VcsStatusResult | null;
  isBusy: boolean;
  hasPrimaryRemote: boolean;
}): EnvironmentContextualAction {
  const { gitStatus, isBusy, hasPrimaryRemote } = input;
  const base = {
    id: "commit_push" as const,
    label: "Commit & push",
    kind: "run_action" as const,
    action: "commit_push" as const,
  };

  if (isBusy) {
    return { ...base, disabled: true, disabledReason: "Git action in progress." };
  }
  if (!gitStatus) {
    return { ...base, disabled: true, disabledReason: "Git status is unavailable." };
  }

  const hasBranch = gitStatus.refName !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const isBehind = gitStatus.behindCount > 0;
  const canPushWithoutUpstream = hasPrimaryRemote && !gitStatus.hasUpstream;
  const canPush = gitStatus.hasUpstream || canPushWithoutUpstream;

  if (!hasChanges) {
    return {
      ...base,
      disabled: true,
      disabledReason: "Worktree is clean. Make changes before committing.",
    };
  }
  if (!hasBranch) {
    return {
      ...base,
      disabled: true,
      disabledReason: "Detached HEAD: checkout a refName before pushing.",
    };
  }
  if (isBehind) {
    return {
      ...base,
      disabled: true,
      disabledReason: "Branch is behind upstream. Pull/rebase before pushing.",
    };
  }
  if (!canPush) {
    return { ...base, disabled: true, disabledReason: 'Add an "origin" remote before pushing.' };
  }

  return { ...base, disabled: false, disabledReason: null };
}

/**
 * Builds the four contextual action rows shown in the Environment panel.
 * Commit/Push/PR reuse the exact same `GitActionMenuItem`s the header's
 * `GitActionsControl` already computed (via `buildMenuItems`); only
 * "Commit & push" is derived fresh since no existing surface exposes it as
 * a standalone action.
 */
export function resolveEnvironmentContextualActions(input: {
  gitStatus: VcsStatusResult | null;
  menuItems: ReadonlyArray<GitActionMenuItem>;
  isBusy: boolean;
  hasPrimaryRemote: boolean;
  terminology: ChangeRequestTerminology;
}): EnvironmentContextualAction[] {
  const { gitStatus, menuItems, isBusy, hasPrimaryRemote, terminology } = input;
  const commitItem = menuItems.find((item) => item.id === "commit");
  const pushItem = menuItems.find((item) => item.id === "push");
  const prItem = menuItems.find((item) => item.id === "pr");

  const commitAction: EnvironmentContextualAction = {
    id: "commit",
    label: "Commit",
    disabled: commitItem?.disabled ?? true,
    disabledReason: commitItem
      ? getMenuActionDisabledReason({ item: commitItem, gitStatus, isBusy, hasPrimaryRemote })
      : "Git status is unavailable.",
    kind: "open_commit_dialog",
  };

  const commitPushAction = resolveCommitPushAction({ gitStatus, isBusy, hasPrimaryRemote });

  const pushAction: EnvironmentContextualAction = {
    id: "push",
    label: "Push",
    disabled: pushItem?.disabled ?? true,
    disabledReason: pushItem
      ? getMenuActionDisabledReason({ item: pushItem, gitStatus, isBusy, hasPrimaryRemote })
      : gitStatus
        ? 'Add an "origin" remote before pushing.'
        : "Git status is unavailable.",
    kind: "run_action",
    action: "push",
  };

  const prAction: EnvironmentContextualAction = prItem
    ? {
        id: "pr",
        label: prItem.label,
        disabled: prItem.disabled,
        disabledReason: getMenuActionDisabledReason({
          item: prItem,
          gitStatus,
          isBusy,
          hasPrimaryRemote,
        }),
        kind: prItem.kind === "open_pr" ? "open_pr" : "run_action",
        ...(prItem.kind === "open_dialog" ? { action: "create_pr" as const } : {}),
      }
    : {
        id: "pr",
        label: `Create ${terminology.shortLabel}`,
        disabled: true,
        disabledReason: gitStatus
          ? `Add an "origin" remote before creating a ${terminology.singular}.`
          : "Git status is unavailable.",
        kind: "run_action",
        action: "create_pr",
      };

  return [commitAction, commitPushAction, pushAction, prAction];
}
