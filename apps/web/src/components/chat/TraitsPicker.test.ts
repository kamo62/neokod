import type { ProviderOptionDescriptor } from "@neokod/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildTraitsTriggerDisplay } from "./TraitsPicker";

function selectDescriptor(
  id: string,
  options: ReadonlyArray<{ id: string; label: string }>,
  currentValue: string,
): Extract<ProviderOptionDescriptor, { type: "select" }> {
  return { id, label: id, type: "select", options: [...options], currentValue };
}

function fastModeDescriptor(
  currentValue: boolean,
): Extract<ProviderOptionDescriptor, { type: "boolean" }> {
  return { id: "fastMode", label: "Fast Mode", type: "boolean", currentValue };
}

const EFFORT = selectDescriptor(
  "effort",
  [
    { id: "high", label: "High" },
    { id: "max", label: "Max" },
  ],
  "high",
);

const CONTEXT_WINDOW = selectDescriptor(
  "contextWindow",
  [
    { id: "200k", label: "200k" },
    { id: "1m", label: "1M" },
  ],
  "1m",
);

function display(descriptors: ReadonlyArray<ProviderOptionDescriptor>, fastModeEnabled: boolean) {
  return buildTraitsTriggerDisplay({
    descriptors,
    primarySelectDescriptorId: "effort",
    ultrathinkPromptControlled: false,
    fastModeEnabled,
  });
}

describe("buildTraitsTriggerDisplay", () => {
  it("shows the bolt instead of a Fast label when fast mode is on", () => {
    expect(display([EFFORT, fastModeDescriptor(true)], true)).toEqual({
      label: "High",
      showFastModeIcon: true,
    });
  });

  it("shows nothing for fast mode when it is off", () => {
    // "Normal" is the near-universal case and would waste trigger space.
    expect(display([EFFORT, fastModeDescriptor(false)], false)).toEqual({
      label: "High",
      showFastModeIcon: false,
    });
  });

  it("keeps the other traits joined and unaffected", () => {
    expect(display([EFFORT, CONTEXT_WINDOW, fastModeDescriptor(true)], true)).toEqual({
      label: "High · 1M",
      showFastModeIcon: true,
    });
  });

  it("falls back to text when fast mode is the only trait", () => {
    // A bare bolt beside a chevron would leave the trigger unreadable.
    expect(display([fastModeDescriptor(true)], true)).toEqual({
      label: "Fast",
      showFastModeIcon: false,
    });
    expect(display([fastModeDescriptor(false)], false)).toEqual({
      label: "Normal",
      showFastModeIcon: false,
    });
  });

  it("does not print a bogus Normal for a model with no fast mode at all", () => {
    // Keying the fallback off an empty label list alone would regress this.
    expect(display([], false)).toEqual({ label: "", showFastModeIcon: false });
  });

  it("still honours the ultrathink override on the primary select", () => {
    expect(
      buildTraitsTriggerDisplay({
        descriptors: [EFFORT, fastModeDescriptor(true)],
        primarySelectDescriptorId: "effort",
        ultrathinkPromptControlled: true,
        fastModeEnabled: true,
      }),
    ).toEqual({ label: "Ultrathink", showFastModeIcon: true });
  });
});
