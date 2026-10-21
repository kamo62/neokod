import { create } from "zustand";

import type { ProjectSettingsDraft } from "./projectSettingsDraft";

/**
 * In-memory Symphony settings drafts, keyed by project id.
 *
 * Deliberately not persisted: project configuration is policy, and a stale
 * browser copy would be worse than asking the user to re-enter an edit. A
 * reload starts every project from its server copy.
 */
interface ProjectSettingsDraftStoreState {
  drafts: Readonly<Record<string, ProjectSettingsDraft>>;
  setDraft: (projectId: string, draft: ProjectSettingsDraft) => void;
  clearDraft: (projectId: string) => void;
}

export const useProjectSettingsDraftStore = create<ProjectSettingsDraftStoreState>((set) => ({
  drafts: {},
  setDraft: (projectId, draft) =>
    set((state) => ({ drafts: { ...state.drafts, [projectId]: draft } })),
  clearDraft: (projectId) =>
    set((state) => {
      if (state.drafts[projectId] === undefined) return state;
      const drafts = { ...state.drafts };
      delete drafts[projectId];
      return { drafts };
    }),
}));
