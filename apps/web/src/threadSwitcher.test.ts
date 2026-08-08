import { describe, expect, it } from "vite-plus/test";

import {
  INITIAL_THREAD_SWITCHER_STATE,
  advanceThreadSwitcher,
  buildThreadSwitcherMruOrder,
  cancelThreadSwitcher,
  commitThreadSwitcher,
  highlightedThreadId,
  openThreadSwitcher,
  reconcileThreadSwitcher,
  type ThreadSwitcherState,
} from "./threadSwitcher";

describe("openThreadSwitcher", () => {
  it("opens forward at index 1 (one step away from the current thread at index 0)", () => {
    const state = openThreadSwitcher(
      INITIAL_THREAD_SWITCHER_STATE,
      ["current", "previous", "older"],
      "forward",
    );
    expect(state.visible).toBe(true);
    expect(highlightedThreadId(state)).toBe("previous");
  });

  it("opens reverse at the last entry", () => {
    const state = openThreadSwitcher(
      INITIAL_THREAD_SWITCHER_STATE,
      ["current", "previous", "older"],
      "reverse",
    );
    expect(highlightedThreadId(state)).toBe("older");
  });

  it("does nothing with zero or one candidate", () => {
    expect(openThreadSwitcher(INITIAL_THREAD_SWITCHER_STATE, [], "forward").visible).toBe(false);
    expect(openThreadSwitcher(INITIAL_THREAD_SWITCHER_STATE, ["solo"], "forward").visible).toBe(
      false,
    );
  });
});

describe("advanceThreadSwitcher (cycle)", () => {
  const order = ["one", "two", "three"];

  it("wraps forward past the end", () => {
    let state = openThreadSwitcher(INITIAL_THREAD_SWITCHER_STATE, order, "reverse"); // index 2 ("three")
    state = advanceThreadSwitcher(state, "forward");
    expect(highlightedThreadId(state)).toBe("one");
  });

  it("wraps reverse past the start", () => {
    let state = openThreadSwitcher(INITIAL_THREAD_SWITCHER_STATE, order, "forward"); // index 1 ("two")
    state = advanceThreadSwitcher(state, "reverse");
    expect(highlightedThreadId(state)).toBe("one");
    state = advanceThreadSwitcher(state, "reverse");
    expect(highlightedThreadId(state)).toBe("three");
  });

  it("does not navigate: repeated advances only move the highlight", () => {
    let state = openThreadSwitcher(INITIAL_THREAD_SWITCHER_STATE, order, "forward");
    const commits: Array<string | null> = [];
    for (let i = 0; i < 5; i += 1) {
      state = advanceThreadSwitcher(state, "forward");
      commits.push(null); // no commit happens on advance
    }
    expect(commits.every((value) => value === null)).toBe(true);
    expect(state.visible).toBe(true);
  });

  it("is a no-op when closed", () => {
    expect(advanceThreadSwitcher(INITIAL_THREAD_SWITCHER_STATE, "forward")).toBe(
      INITIAL_THREAD_SWITCHER_STATE,
    );
  });
});

describe("commitThreadSwitcher", () => {
  it("reports the highlighted thread and closes", () => {
    const opened = openThreadSwitcher(
      INITIAL_THREAD_SWITCHER_STATE,
      ["current", "previous", "older"],
      "forward",
    );
    const result = commitThreadSwitcher(opened);
    expect(result.committedThreadId).toBe("previous");
    expect(result.state.visible).toBe(false);
  });

  it("reports null when nothing was ever opened", () => {
    const result = commitThreadSwitcher(INITIAL_THREAD_SWITCHER_STATE);
    expect(result.committedThreadId).toBeNull();
    expect(result.state.visible).toBe(false);
  });
});

describe("cancelThreadSwitcher", () => {
  it("closes without reporting a commit", () => {
    const opened = openThreadSwitcher(INITIAL_THREAD_SWITCHER_STATE, ["a", "b"], "forward");
    const cancelled = cancelThreadSwitcher(opened);
    expect(cancelled.visible).toBe(false);
    // The order/index are irrelevant once closed; highlightedThreadId reflects that.
    expect(highlightedThreadId(cancelled)).toBeNull();
  });

  it("is a no-op when already closed", () => {
    expect(cancelThreadSwitcher(INITIAL_THREAD_SWITCHER_STATE)).toBe(INITIAL_THREAD_SWITCHER_STATE);
  });
});

describe("reconcileThreadSwitcher", () => {
  it("drops removed entries but preserves the highlighted identity", () => {
    let state: ThreadSwitcherState = openThreadSwitcher(
      INITIAL_THREAD_SWITCHER_STATE,
      ["current", "previous", "older", "oldest"],
      "forward",
    ); // highlighted: "previous"
    state = advanceThreadSwitcher(state, "forward"); // highlighted: "older"

    const reconciled = reconcileThreadSwitcher(
      state,
      new Set(["current", "older", "oldest"]), // "previous" was archived elsewhere
    );
    expect(reconciled.order).toEqual(["current", "older", "oldest"]);
    expect(highlightedThreadId(reconciled)).toBe("older");
  });

  it("clamps the index when the highlighted thread itself was removed", () => {
    const state = openThreadSwitcher(
      INITIAL_THREAD_SWITCHER_STATE,
      ["current", "previous", "older"],
      "forward",
    ); // highlighted: "previous"

    const reconciled = reconcileThreadSwitcher(state, new Set(["current", "older"]));
    expect(reconciled.order).toEqual(["current", "older"]);
    // "previous" is gone; index clamps into range rather than pointing past the end.
    expect(reconciled.index).toBeLessThan(reconciled.order.length);
  });

  it("closes once fewer than two candidates remain", () => {
    const state = openThreadSwitcher(
      INITIAL_THREAD_SWITCHER_STATE,
      ["current", "previous", "older"],
      "forward",
    );
    const reconciled = reconcileThreadSwitcher(state, new Set(["current"]));
    expect(reconciled.visible).toBe(false);
    expect(reconciled.order).toEqual(["current"]);
  });

  it("is a no-op when the switcher was never opened", () => {
    expect(reconcileThreadSwitcher(INITIAL_THREAD_SWITCHER_STATE, new Set())).toBe(
      INITIAL_THREAD_SWITCHER_STATE,
    );
  });
});

describe("buildThreadSwitcherMruOrder", () => {
  const threads = [
    { key: "a", archivedAt: null, updatedAt: "2026-01-01T00:00:00.000Z" },
    { key: "b", archivedAt: null, updatedAt: "2026-01-02T00:00:00.000Z" },
    { key: "c", archivedAt: null, updatedAt: "2026-01-03T00:00:00.000Z" },
    {
      key: "archived",
      archivedAt: "2026-01-04T00:00:00.000Z",
      updatedAt: "2026-01-05T00:00:00.000Z",
    },
  ];

  it("orders by threadLastVisitedAtById, most recent first, excluding archived threads", () => {
    const order = buildThreadSwitcherMruOrder(
      threads,
      {
        a: "2026-02-01T00:00:00.000Z",
        b: "2026-03-01T00:00:00.000Z",
        c: "2026-01-15T00:00:00.000Z",
      },
      null,
    );
    expect(order).toEqual(["b", "a", "c"]);
  });

  it("falls back to updatedAt for threads with no visited timestamp", () => {
    const order = buildThreadSwitcherMruOrder(threads, {}, null);
    expect(order).toEqual(["c", "b", "a"]);
  });

  it("pins the current thread to index 0 regardless of its recency", () => {
    const order = buildThreadSwitcherMruOrder(
      threads,
      { a: "2026-02-01T00:00:00.000Z", b: "2026-03-01T00:00:00.000Z" },
      "c",
    );
    expect(order[0]).toBe("c");
    expect(order).toEqual(["c", "b", "a"]);
  });
});
