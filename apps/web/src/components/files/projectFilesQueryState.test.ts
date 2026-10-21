import type { ProjectReadFileResult } from "@neokod/contracts";
import { EnvironmentId } from "@neokod/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  clearProjectFileQueryData,
  confirmProjectFileQueryData,
  getOptimisticProjectFileQueryData,
  recordProjectFileContentHash,
  resolveProjectFileQueryData,
  setProjectFileQueryData,
} from "./projectFilesQueryState";

const environmentId = EnvironmentId.make("environment-project-files-query-test");

describe("project files queries", () => {
  afterEach(() => {
    clearProjectFileQueryData(environmentId, "/repo", "convex.json");
    vi.unstubAllGlobals();
  });

  it("keeps the latest optimistic draft when an older write finishes", () => {
    vi.stubGlobal("window", {});
    const initial = {
      relativePath: "convex.json",
      contents: '{"nodeVersion":"20"}',
      byteLength: 20,
      truncated: false,
    } satisfies ProjectReadFileResult;
    setProjectFileQueryData(environmentId, "/repo", "convex.json", '{"nodeVersion":"220"}');
    setProjectFileQueryData(environmentId, "/repo", "convex.json", '{"nodeVersion":"22"}');

    expect(getOptimisticProjectFileQueryData(environmentId, "/repo", "convex.json")?.contents).toBe(
      '{"nodeVersion":"22"}',
    );

    expect(
      confirmProjectFileQueryData(environmentId, "/repo", "convex.json", '{"nodeVersion":"220"}'),
    ).toBe(false);

    expect(resolveProjectFileQueryData(environmentId, "/repo", "convex.json", initial)).toEqual({
      relativePath: "convex.json",
      contents: '{"nodeVersion":"22"}',
      byteLength: 20,
      truncated: false,
    });

    expect(
      confirmProjectFileQueryData(environmentId, "/repo", "convex.json", '{"nodeVersion":"22"}'),
    ).toBe(true);
  });

  it("keeps the confirmed hash across edits and adopts the next saved hash", () => {
    vi.stubGlobal("window", {});
    setProjectFileQueryData(
      environmentId,
      "/repo",
      "convex.json",
      '{"nodeVersion":"20"}',
      "hash-from-read",
    );
    expect(
      getOptimisticProjectFileQueryData(environmentId, "/repo", "convex.json")?.contentHash,
    ).toBe("hash-from-read");

    setProjectFileQueryData(environmentId, "/repo", "convex.json", '{"nodeVersion":"22"}');
    expect(
      getOptimisticProjectFileQueryData(environmentId, "/repo", "convex.json")?.contentHash,
    ).toBe("hash-from-read");

    recordProjectFileContentHash(environmentId, "/repo", "convex.json", "hash-from-save");
    expect(
      getOptimisticProjectFileQueryData(environmentId, "/repo", "convex.json")?.contentHash,
    ).toBe("hash-from-save");
  });
});
