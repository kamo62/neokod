import { describe, expect, it } from "vite-plus/test";

import {
  displayCommitOnBlurValue,
  endCommitOnBlurBuffer,
  focusCommitOnBlurBuffer,
  typeCommitOnBlurBuffer,
} from "./useCommitOnBlur";

describe("commit-on-blur buffer", () => {
  it("follows an authoritative update while a clean field is focused", () => {
    // Focus captures the old text; no keystroke has started an edit yet.
    const focused = focusCommitOnBlurBuffer("kamo62/neokod");

    expect(displayCommitOnBlurValue(focused, "kamo62/neokod-next")).toBe("kamo62/neokod-next");
    expect(endCommitOnBlurBuffer(focused, "kamo62/neokod-next")).toEqual({
      buffer: { draft: null, beganEdit: false },
      commit: null,
      discard: false,
    });
  });

  it("keeps a typed buffer across an authoritative update", () => {
    const typed = typeCommitOnBlurBuffer("kamo62/my-edit");

    expect(displayCommitOnBlurValue(typed, "kamo62/neokod-next")).toBe("kamo62/my-edit");
    expect(endCommitOnBlurBuffer(typed, "kamo62/neokod-next")).toEqual({
      buffer: { draft: null, beganEdit: false },
      commit: "kamo62/my-edit",
      discard: false,
    });
  });

  it("discards ownership when a typed buffer returns to the authoritative value", () => {
    const typed = typeCommitOnBlurBuffer("kamo62/neokod-next");

    expect(endCommitOnBlurBuffer(typed, "kamo62/neokod-next")).toEqual({
      buffer: { draft: null, beganEdit: false },
      commit: null,
      discard: true,
    });
  });
});
