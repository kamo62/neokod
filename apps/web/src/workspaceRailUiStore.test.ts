import { describe, expect, it } from "vite-plus/test";

import { bumpOpenNonce, type RailPopover } from "./workspaceRailUiStore";

describe("bumpOpenNonce", () => {
  it("starts a popover nonce at 1 and increments on repeat requests", () => {
    const first = bumpOpenNonce({}, "env:thread", "goal");
    expect(first["env:thread"]?.goal).toBe(1);

    const second = bumpOpenNonce(first, "env:thread", "goal");
    expect(second["env:thread"]?.goal).toBe(2);
  });

  it("tracks popovers and threads independently", () => {
    let state: Record<string, Partial<Record<RailPopover, number>>> = {};
    state = bumpOpenNonce(state, "env:a", "goal");
    state = bumpOpenNonce(state, "env:a", "fleet");
    state = bumpOpenNonce(state, "env:b", "goal");

    expect(state["env:a"]).toEqual({ goal: 1, fleet: 1 });
    expect(state["env:b"]).toEqual({ goal: 1 });
  });
});
