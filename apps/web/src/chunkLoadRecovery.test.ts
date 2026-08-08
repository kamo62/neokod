import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { isChunkLoadError, recoverByReload } from "./chunkLoadRecovery";

describe("isChunkLoadError", () => {
  it("matches a Vite dynamic-import failure", () => {
    expect(
      isChunkLoadError(
        new TypeError("Failed to fetch dynamically imported module: https://app/chunk-abc.js"),
      ),
    ).toBe(true);
  });

  it("matches a webpack-style ChunkLoadError name", () => {
    expect(isChunkLoadError({ name: "ChunkLoadError", message: "Loading chunk 4 failed." })).toBe(
      true,
    );
  });

  it("matches a module script import failure", () => {
    expect(isChunkLoadError(new Error("Importing a module script failed."))).toBe(true);
  });

  it("does not match an unrelated error", () => {
    expect(isChunkLoadError(new Error("Network request failed"))).toBe(false);
  });

  it("does not match null/undefined", () => {
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });
});

// The "unit" test project runs under Node, with no ambient `window`
// (uiStateStore.ts follows the same convention: guard, don't assume DOM).
// Stub a minimal window for recoverByReload's two dependencies instead of
// pulling in a full DOM environment for one small module.
function makeFakeWindow() {
  const store = new Map<string, string>();
  return {
    sessionStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => {
        store.clear();
      },
    },
    location: { reload: vi.fn() },
  };
}

describe("recoverByReload", () => {
  beforeEach(() => {
    vi.stubGlobal("window", makeFakeWindow());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reloads once and sets the session guard", () => {
    expect(recoverByReload()).toBe(true);
    expect(window.location.reload).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem("neokod:chunk-reloaded")).toBe("1");
  });

  it("does not reload again once the guard is set", () => {
    window.sessionStorage.setItem("neokod:chunk-reloaded", "1");
    expect(recoverByReload()).toBe(false);
    expect(window.location.reload).not.toHaveBeenCalled();
  });
});
