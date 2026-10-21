import { describe, expect, it } from "vite-plus/test";

import {
  applyEnvironmentRowPatch,
  environmentRowNeedsValue,
  makeEnvironmentDraftRow,
  publishableEnvironment,
} from "./providerEnvironmentDraft";

const storedSecret = () =>
  makeEnvironmentDraftRow({ name: "API_KEY", value: "", sensitive: true, valueRedacted: true }, 0);

describe("stored provider environment secrets", () => {
  it("unchecking Sensitive on a stored secret blocks publishing", () => {
    const row = storedSecret();
    const next = [applyEnvironmentRowPatch(row, { sensitive: false })];
    expect(environmentRowNeedsValue(next[0]!)).toBe(true);
    expect(publishableEnvironment(next)).toBeNull();
  });

  it("renaming a stored secret blocks publishing", () => {
    const row = storedSecret();
    const next = [applyEnvironmentRowPatch(row, { name: "OTHER_KEY" })];
    expect(environmentRowNeedsValue(next[0]!)).toBe(true);
    expect(publishableEnvironment(next)).toBeNull();
  });

  it("a replacement value unblocks and drops the link", () => {
    const detached = applyEnvironmentRowPatch(storedSecret(), { sensitive: false });
    const replaced = applyEnvironmentRowPatch(detached, { value: "plain" });
    expect(environmentRowNeedsValue(replaced)).toBe(false);
    const published = publishableEnvironment([replaced]);
    expect(published).toEqual([
      { name: "API_KEY", value: "plain", sensitive: false, valueRedacted: false },
    ]);
    expect(published?.[0]).not.toHaveProperty("stored");
  });

  it("restoring name and Sensitive re-links the secret", () => {
    const renamed = applyEnvironmentRowPatch(storedSecret(), { name: "OTHER_KEY" });
    const restored = applyEnvironmentRowPatch(renamed, { name: "API_KEY" });
    expect(restored.valueRedacted).toBe(true);
    expect(publishableEnvironment([restored])).toEqual([
      { name: "API_KEY", value: "", sensitive: true, valueRedacted: true },
    ]);
  });

  it("typing a new secret value on an untouched stored row replaces it", () => {
    const replaced = applyEnvironmentRowPatch(storedSecret(), { value: "new" });
    expect(publishableEnvironment([replaced])).toEqual([
      { name: "API_KEY", value: "new", sensitive: true, valueRedacted: false },
    ]);
  });

  it("typing a replacement then clearing it restores the stored link", () => {
    const typed = applyEnvironmentRowPatch(storedSecret(), { value: "new" });
    const cleared = applyEnvironmentRowPatch(typed, { value: "" });
    expect(cleared.valueRedacted).toBe(true);
    expect(environmentRowNeedsValue(cleared)).toBe(false);
    expect(publishableEnvironment([cleared])).toEqual([
      { name: "API_KEY", value: "", sensitive: true, valueRedacted: true },
    ]);
  });

  it("a new empty sensitive row is published as today", () => {
    const row = makeEnvironmentDraftRow({ name: "", value: "", sensitive: true }, 0);
    expect(publishableEnvironment([row])).toEqual([]);
  });
});
