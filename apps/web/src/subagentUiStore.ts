/**
 * Persisted, thread-scoped UI state for the subagent panel.
 */
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

const SUBAGENT_UI_STORAGE_KEY = "t3code:subagent-ui-state:v1";
export const HIDDEN_SUBAGENT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
export const MAX_HIDDEN_SUBAGENT_THREAD_ENTRIES = 100;

export interface HiddenSubagentTaskIdsEntry {
  taskIds: string[];
  updatedAt: number;
}

export type HiddenSubagentTaskIdsByThreadKey = Record<string, HiddenSubagentTaskIdsEntry>;
const EMPTY_HIDDEN_SUBAGENT_TASK_IDS: readonly string[] = [];

interface PersistedSubagentUiState {
  hiddenTaskIdsByThreadKey?: HiddenSubagentTaskIdsByThreadKey;
}

function createSubagentUiStateStorage() {
  return resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined);
}

/**
 * Drops malformed, old, and least-recently-used entries so local UI state does
 * not accumulate forever. Pure.
 */
export function pruneHiddenSubagentTaskIds(
  entries: HiddenSubagentTaskIdsByThreadKey,
  now: number = Date.now(),
): HiddenSubagentTaskIdsByThreadKey {
  return Object.fromEntries(
    Object.entries(entries)
      .filter(
        ([threadKey, entry]) =>
          parseScopedThreadKey(threadKey) !== null &&
          Array.isArray(entry.taskIds) &&
          Number.isFinite(entry.updatedAt) &&
          now - entry.updatedAt <= HIDDEN_SUBAGENT_MAX_AGE_MS,
      )
      .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_HIDDEN_SUBAGENT_THREAD_ENTRIES),
  );
}

export function migratePersistedSubagentUiState(
  persistedState: unknown,
  _version: number,
): PersistedSubagentUiState {
  if (!persistedState || typeof persistedState !== "object") {
    return { hiddenTaskIdsByThreadKey: {} };
  }
  const candidate = persistedState as PersistedSubagentUiState;
  return {
    hiddenTaskIdsByThreadKey: pruneHiddenSubagentTaskIds(candidate.hiddenTaskIdsByThreadKey ?? {}),
  };
}

export function selectHiddenSubagentTaskIds(
  entries: HiddenSubagentTaskIdsByThreadKey,
  threadRef: ScopedThreadRef | null | undefined,
): readonly string[] {
  if (!threadRef) return EMPTY_HIDDEN_SUBAGENT_TASK_IDS;
  return entries[scopedThreadKey(threadRef)]?.taskIds ?? EMPTY_HIDDEN_SUBAGENT_TASK_IDS;
}

interface SubagentUiStoreState {
  hiddenTaskIdsByThreadKey: HiddenSubagentTaskIdsByThreadKey;
  hideSubagent: (threadRef: ScopedThreadRef, taskId: string) => void;
}

export const useSubagentUiStore = create<SubagentUiStoreState>()(
  persist(
    (set) => ({
      hiddenTaskIdsByThreadKey: {},
      hideSubagent: (threadRef, taskId) =>
        set((state) => {
          const now = Date.now();
          const threadKey = scopedThreadKey(threadRef);
          const current = state.hiddenTaskIdsByThreadKey[threadKey];
          if (current?.taskIds.includes(taskId)) {
            return {
              hiddenTaskIdsByThreadKey: pruneHiddenSubagentTaskIds(
                state.hiddenTaskIdsByThreadKey,
                now,
              ),
            };
          }
          // Prune AFTER inserting so the cap counts the updated entry too;
          // the fresh `updatedAt` guarantees it survives the LRU slice.
          return {
            hiddenTaskIdsByThreadKey: pruneHiddenSubagentTaskIds(
              {
                ...state.hiddenTaskIdsByThreadKey,
                [threadKey]: {
                  taskIds: [...(current?.taskIds ?? []), taskId],
                  updatedAt: now,
                },
              },
              now,
            ),
          };
        }),
    }),
    {
      name: SUBAGENT_UI_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(createSubagentUiStateStorage),
      migrate: migratePersistedSubagentUiState,
      // `migrate` only runs on version bumps; `merge` runs on every rehydrate,
      // so expiry/cap pruning is enforced for current-version data too.
      merge: (persistedState, currentState) => ({
        ...currentState,
        hiddenTaskIdsByThreadKey: pruneHiddenSubagentTaskIds(
          migratePersistedSubagentUiState(persistedState, 1).hiddenTaskIdsByThreadKey ?? {},
        ),
      }),
      partialize: (state) => ({ hiddenTaskIdsByThreadKey: state.hiddenTaskIdsByThreadKey }),
    },
  ),
);
