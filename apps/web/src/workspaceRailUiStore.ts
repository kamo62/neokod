/**
 * Thread-scoped "open this rail popover" signal.
 *
 * The goal editor (`GoalChip`) and Copilot fleet/agent controls
 * (`CopilotThreadControls`) own their own popover open state near the thread
 * header. This store lets the composer's `/goal` and `/fleet` slash commands
 * (and any other caller) ask those components to open, without threading refs
 * or lifting their local state. Each request bumps a per-thread, per-popover
 * nonce that the target component watches; there is no durable state to persist.
 */
import { scopedThreadKey } from "@neokod/client-runtime/environment";
import type { ScopedThreadRef } from "@neokod/contracts";
import { create } from "zustand";

export type RailPopover = "goal" | "fleet" | "mcp";

interface WorkspaceRailUiState {
  /** threadKey → popover → monotonically increasing open-request nonce. */
  openNonceByThreadKey: Record<string, Partial<Record<RailPopover, number>>>;
  requestOpen: (ref: ScopedThreadRef, popover: RailPopover) => void;
}

export function bumpOpenNonce(
  current: Record<string, Partial<Record<RailPopover, number>>>,
  threadKey: string,
  popover: RailPopover,
): Record<string, Partial<Record<RailPopover, number>>> {
  const forThread = current[threadKey] ?? {};
  return {
    ...current,
    [threadKey]: { ...forThread, [popover]: (forThread[popover] ?? 0) + 1 },
  };
}

export const useWorkspaceRailUiStore = create<WorkspaceRailUiState>((set) => ({
  openNonceByThreadKey: {},
  requestOpen: (ref, popover) =>
    set((state) => ({
      openNonceByThreadKey: bumpOpenNonce(
        state.openNonceByThreadKey,
        scopedThreadKey(ref),
        popover,
      ),
    })),
}));

export function selectRailPopoverOpenNonce(
  state: WorkspaceRailUiState,
  ref: ScopedThreadRef,
  popover: RailPopover,
): number {
  return state.openNonceByThreadKey[scopedThreadKey(ref)]?.[popover] ?? 0;
}
