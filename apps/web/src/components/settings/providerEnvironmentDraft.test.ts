import { describe, expect, it } from "vite-plus/test";

import {
  applyEnvironmentRowPatch,
  environmentRowNeedsValue,
  makeEnvironmentDraftRow,
  publishableEnvironment,
  reconcileEnvironmentRows,
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

  it("does not re-link a stored secret after it was replaced under another name", () => {
    const mounted = storedSecret();
    const renamed = applyEnvironmentRowPatch(mounted, { name: "OTHER_KEY" });
    const replaced = applyEnvironmentRowPatch(renamed, { value: "replacement" });
    expect(publishableEnvironment([replaced])).toEqual([
      { name: "OTHER_KEY", value: "replacement", sensitive: true, valueRedacted: false },
    ]);

    // Successful save acknowledgement: the server removed API_KEY and now
    // reports OTHER_KEY as the stored, redacted secret.
    const acknowledgedEnvironment = [
      { name: "OTHER_KEY", value: "", sensitive: true, valueRedacted: true },
    ] as const;
    const [acknowledged] = reconcileEnvironmentRows([replaced], acknowledgedEnvironment);
    expect(acknowledged?.stored).toEqual({ name: "OTHER_KEY" });

    const cleared = applyEnvironmentRowPatch(acknowledged!, { value: "" });
    expect(publishableEnvironment([cleared])).toEqual([
      { name: "OTHER_KEY", value: "", sensitive: true, valueRedacted: true },
    ]);

    const restored = applyEnvironmentRowPatch(cleared, { name: "API_KEY" });
    expect(environmentRowNeedsValue(restored)).toBe(true);
    expect(publishableEnvironment([restored])).toBeNull();
    expect(
      publishableEnvironment([restored])?.some(
        (variable) => variable.name === "API_KEY" && variable.valueRedacted === true,
      ) ?? false,
    ).toBe(false);
  });

  it("keeps failed-save secret ownership until the replacement is acknowledged", () => {
    const failedSave = applyEnvironmentRowPatch(
      applyEnvironmentRowPatch(storedSecret(), { name: "OTHER_KEY" }),
      { value: "replacement" },
    );
    const [stillStored] = reconcileEnvironmentRows(
      [failedSave],
      [{ name: "API_KEY", value: "", sensitive: true, valueRedacted: true }],
    );
    expect(stillStored?.stored).toEqual({ name: "API_KEY" });

    const cleared = applyEnvironmentRowPatch(stillStored!, { value: "" });
    const restored = applyEnvironmentRowPatch(cleared, { name: "API_KEY" });
    expect(environmentRowNeedsValue(restored)).toBe(false);
    expect(publishableEnvironment([restored])).toEqual([
      { name: "API_KEY", value: "", sensitive: true, valueRedacted: true },
    ]);
  });

  it("keeps an ordinary unchanged stored secret linked across other environment changes", () => {
    const row = storedSecret();
    const [reconciled] = reconcileEnvironmentRows(
      [row],
      [
        { name: "API_KEY", value: "", sensitive: true, valueRedacted: true },
        { name: "BASE_URL", value: "https://example.test", sensitive: false },
      ],
    );
    expect(reconciled).toBe(row);
  });

  it("drops stored ownership when the authoritative environment no longer has the secret", () => {
    const [detached] = reconcileEnvironmentRows(
      [storedSecret()],
      [{ name: "OTHER_KEY", value: "", sensitive: true, valueRedacted: true }],
    );
    expect(detached?.stored).toBeUndefined();
    expect(detached?.valueRedacted).toBe(false);
    expect(environmentRowNeedsValue(detached!)).toBe(true);
    expect(publishableEnvironment([detached!])).toBeNull();
  });

  it("blocks publishing a named sensitive row with neither a stored link nor a value", () => {
    const named = applyEnvironmentRowPatch(
      makeEnvironmentDraftRow({ name: "", value: "", sensitive: true }, 0),
      { name: "API_KEY" },
    );
    expect(environmentRowNeedsValue(named)).toBe(true);
    expect(publishableEnvironment([named])).toBeNull();
  });
});
