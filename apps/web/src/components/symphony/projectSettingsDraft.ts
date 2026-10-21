import type { SymphonyProject, SymphonyProjectConfiguration } from "@neokod/contracts";
import * as Equal from "effect/Equal";

/**
 * One browser-session settings draft for a Symphony project.
 *
 * `baseRevision` is the project revision the draft can safely save against.
 * `serverBase` is the server configuration observed when the draft started, so
 * a status-only revision bump can be told apart from a configuration edit made
 * elsewhere. The draft resets its baseline when the save response arrives.
 */
export interface ProjectSettingsDraft {
  /** `project.revision` when the draft was taken (or last rebased). */
  readonly baseRevision: number;
  /** `project.configuration` at the time the draft was taken. */
  readonly serverBase: SymphonyProjectConfiguration | null;
  /** What the form first showed. */
  readonly initial: SymphonyProjectConfiguration;
  /** What the user has now. */
  readonly value: SymphonyProjectConfiguration;
}

export type DraftSync = "clean" | "dirty" | "changed_elsewhere";

/**
 * Start a draft from the project's configuration, or from the form fallback
 * when the project has no configuration yet. Returns null when neither exists.
 */
export function startDraft(
  project: SymphonyProject,
  fallback: SymphonyProjectConfiguration | null,
): ProjectSettingsDraft | null {
  const initial = project.configuration ?? fallback;
  if (initial === null) return null;
  return {
    baseRevision: project.revision,
    serverBase: project.configuration,
    initial,
    value: initial,
  };
}

export function isDraftDirty(draft: ProjectSettingsDraft): boolean {
  return !Equal.equals(draft.value, draft.initial);
}

export function editDraft(
  draft: ProjectSettingsDraft,
  value: SymphonyProjectConfiguration,
): ProjectSettingsDraft {
  return { ...draft, value };
}

/**
 * Reconcile a stored draft with the latest server copy.
 *
 * A clean draft follows the server. A dirty draft survives status-only
 * revision bumps and rebases onto the new revision. When the configuration
 * itself changed elsewhere the buffer is kept and the caller must ask the
 * user before overwriting it.
 */
export function reconcileDraft(
  draft: ProjectSettingsDraft,
  project: SymphonyProject,
  fallback: SymphonyProjectConfiguration | null,
): { draft: ProjectSettingsDraft; sync: DraftSync } {
  const dirty = isDraftDirty(draft);
  // A save response can be newer than the project prop until the board query
  // refreshes. Never regress a draft onto an older known revision.
  if (project.revision < draft.baseRevision) {
    return { draft, sync: dirty ? "dirty" : "clean" };
  }
  if (!dirty) {
    if (project.revision !== draft.baseRevision) {
      return { draft: startDraft(project, fallback) ?? draft, sync: "clean" };
    }
    return { draft, sync: "clean" };
  }
  if (project.revision === draft.baseRevision) {
    return { draft, sync: "dirty" };
  }
  if (Equal.equals(project.configuration, draft.serverBase)) {
    return { draft: { ...draft, baseRevision: project.revision }, sync: "dirty" };
  }
  return { draft, sync: "changed_elsewhere" };
}

/** A pristine draft matching the server copy returned by a successful save. */
export function savedDraft(project: SymphonyProject): ProjectSettingsDraft | null {
  if (project.configuration === null) return null;
  return {
    baseRevision: project.revision,
    serverBase: project.configuration,
    initial: project.configuration,
    value: project.configuration,
  };
}

/**
 * Apply a save response as the new authoritative baseline.
 *
 * The user may edit while the save is in flight; those edits are newer than
 * the response, so keep them and mark the draft dirty against the saved
 * configuration instead of replacing the buffer.
 */
export function applySavedDraft(
  current: ProjectSettingsDraft | null | undefined,
  project: SymphonyProject,
): ProjectSettingsDraft | null {
  const saved = savedDraft(project);
  if (saved === null) return current ?? null;
  if (current === null || current === undefined) return saved;
  return Equal.equals(current.value, saved.value) ? saved : { ...saved, value: current.value };
}
