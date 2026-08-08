// Pure state for the held-Ctrl-Tab MRU thread switcher (REVIEW-UI item 12).
// Cmd-Tab-style transient selection: the highlighted thread is never
// navigated to until the modifier is released or Enter is pressed, so
// Escape can cancel cleanly and repeated Ctrl-Tab presses just move the
// highlight. Ported from diri's crates/diri-app/src/switcher.rs
// (SessionSwitcherState), which documents the same semantics for its own
// Ctrl-Tab session switcher.

export type ThreadSwitcherCycleDirection = "forward" | "reverse";

export interface ThreadSwitcherState {
  readonly visible: boolean;
  // MRU-ordered thread identities. order[0] is the thread the switcher was
  // opened from ("forward" starts the highlight one step away from it, at
  // order[1], mirroring diri's `open()`).
  readonly order: ReadonlyArray<string>;
  readonly index: number;
}

export const INITIAL_THREAD_SWITCHER_STATE: ThreadSwitcherState = Object.freeze({
  visible: false,
  order: [],
  index: 0,
});

export function highlightedThreadId(state: ThreadSwitcherState): string | null {
  if (!state.visible) return null;
  return state.order[state.index] ?? null;
}

/**
 * Opens the switcher over `order`. Requires at least two entries — with zero
 * or one candidate there is nothing to switch to, so the state is returned
 * unchanged (mirrors diri's `open()` returning false for `order.len() <= 1`).
 */
export function openThreadSwitcher(
  state: ThreadSwitcherState,
  order: ReadonlyArray<string>,
  direction: ThreadSwitcherCycleDirection,
): ThreadSwitcherState {
  if (order.length <= 1) {
    return state;
  }
  return {
    visible: true,
    order: [...order],
    index: direction === "forward" ? 1 : order.length - 1,
  };
}

/** Moves the highlight while the switcher is already open. No-op when closed. */
export function advanceThreadSwitcher(
  state: ThreadSwitcherState,
  direction: ThreadSwitcherCycleDirection,
): ThreadSwitcherState {
  if (!state.visible || state.order.length === 0) {
    return state;
  }
  const length = state.order.length;
  const index =
    direction === "forward" ? (state.index + 1) % length : (state.index + length - 1) % length;
  return { ...state, index };
}

/** Escape: closes without committing. No-op when already closed. */
export function cancelThreadSwitcher(state: ThreadSwitcherState): ThreadSwitcherState {
  if (!state.visible) {
    return state;
  }
  return { ...state, visible: false };
}

export interface ThreadSwitcherCommitResult {
  readonly state: ThreadSwitcherState;
  readonly committedThreadId: string | null;
}

/** Modifier release or Enter: closes and reports the highlighted thread (if any) to navigate to. */
export function commitThreadSwitcher(state: ThreadSwitcherState): ThreadSwitcherCommitResult {
  return {
    state: { ...state, visible: false },
    committedThreadId: highlightedThreadId(state),
  };
}

/**
 * Reconciles the switcher's captured order against the threads that still
 * exist, without losing the highlighted identity when it is still live.
 * Threads that were removed (archived, deleted, or unarchived elsewhere)
 * while the overlay is open drop out of `order`; the highlight follows the
 * previously-highlighted thread if it survived, otherwise clamps to the new
 * length. Closes automatically once fewer than two candidates remain, same
 * as `open()`'s minimum. Mirrors diri's `reconcile()`.
 */
export function reconcileThreadSwitcher(
  state: ThreadSwitcherState,
  liveIds: ReadonlySet<string>,
): ThreadSwitcherState {
  if (state.order.length === 0) {
    return state;
  }
  const highlighted = highlightedThreadId(state);
  const nextOrder = state.order.filter((id) => liveIds.has(id));
  if (nextOrder.length <= 1) {
    return { visible: false, order: nextOrder, index: 0 };
  }
  const preservedIndex = highlighted !== null ? nextOrder.indexOf(highlighted) : -1;
  const index =
    preservedIndex !== -1 ? preservedIndex : Math.min(state.index, nextOrder.length - 1);
  return { ...state, order: nextOrder, index };
}

/**
 * Builds the MRU order the switcher opens with: non-archived threads sorted
 * by most-recently-visited first (uiStateStore threadLastVisitedAtById),
 * falling back to the thread's own updatedAt for threads never visited in
 * this browser profile. `currentThreadKey`, if it is present among the
 * candidates, is pinned to index 0 regardless of its recency so the first
 * Ctrl-Tab always steps away from the thread currently open.
 */
export function buildThreadSwitcherMruOrder(
  threads: ReadonlyArray<{
    readonly key: string;
    readonly archivedAt: string | null;
    readonly updatedAt: string;
  }>,
  visitedAtById: Readonly<Record<string, string>>,
  currentThreadKey: string | null,
): ReadonlyArray<string> {
  const recencyMs = (thread: (typeof threads)[number]): number => {
    const visitedAt = visitedAtById[thread.key];
    const parsed = Date.parse(visitedAt ?? thread.updatedAt);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const ordered = threads
    .filter((thread) => thread.archivedAt === null)
    .slice()
    .sort((a, b) => recencyMs(b) - recencyMs(a))
    .map((thread) => thread.key);

  if (currentThreadKey === null) {
    return ordered;
  }
  const currentIndex = ordered.indexOf(currentThreadKey);
  if (currentIndex <= 0) {
    return ordered;
  }
  const withoutCurrent = ordered.filter((key) => key !== currentThreadKey);
  return [currentThreadKey, ...withoutCurrent];
}
