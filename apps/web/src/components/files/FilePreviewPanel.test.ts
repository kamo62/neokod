import { describe, expect, it } from "vite-plus/test";

import {
  formatFileCommentRange,
  normalizeFileCommentRange,
  remapFileCommentAnnotations,
} from "./fileCommentAnnotations";
import {
  decideMarkdownTaskToggle,
  isMarkdownPreviewFile,
  setMarkdownTaskChecked,
} from "./filePreviewMode";

describe("file comment annotations", () => {
  it("normalizes and formats selected line ranges", () => {
    expect(normalizeFileCommentRange({ start: 16, end: 7 })).toEqual({
      startLine: 7,
      endLine: 16,
    });
    expect(formatFileCommentRange(7, 7)).toBe("L7");
    expect(formatFileCommentRange(7, 16)).toBe("L7 to L16");
  });

  it("keeps an annotation range attached when Pierre remaps its anchor line", () => {
    expect(
      remapFileCommentAnnotations([
        {
          lineNumber: 20,
          metadata: {
            entries: [
              {
                id: "comment-1",
                kind: "comment",
                startLine: 7,
                endLine: 16,
                text: "Keep this guarded.",
              },
            ],
          },
        },
      ]),
    ).toEqual([
      {
        lineNumber: 20,
        metadata: {
          entries: [
            {
              id: "comment-1",
              kind: "comment",
              startLine: 11,
              endLine: 20,
              text: "Keep this guarded.",
            },
          ],
        },
      },
    ]);
  });
});

describe("isMarkdownPreviewFile", () => {
  it("recognizes markdown and MDX files case-insensitively", () => {
    expect(isMarkdownPreviewFile("README.md")).toBe(true);
    expect(isMarkdownPreviewFile("docs/guide.MDX")).toBe(true);
  });

  it("does not treat other text files as markdown", () => {
    expect(isMarkdownPreviewFile("docs/guide.txt")).toBe(false);
    expect(isMarkdownPreviewFile("docs/markdown.ts")).toBe(false);
  });
});

describe("setMarkdownTaskChecked", () => {
  const markdown = "- [ ] First\n- [x] Second\n";

  it("checks and unchecks the task marker at the supplied offset", () => {
    expect(setMarkdownTaskChecked(markdown, 2, true)).toBe("- [x] First\n- [x] Second\n");
    expect(setMarkdownTaskChecked(markdown, 14, false)).toBe("- [ ] First\n- [ ] Second\n");
    expect(setMarkdownTaskChecked("1. [X] Ordered\n", 3, false)).toBe("1. [ ] Ordered\n");
  });

  it("leaves the document unchanged for a stale or invalid marker offset", () => {
    expect(setMarkdownTaskChecked(markdown, 0, true)).toBe(markdown);
    expect(setMarkdownTaskChecked(markdown, 200, true)).toBe(markdown);
  });
});

describe("decideMarkdownTaskToggle", () => {
  it("blocks task toggles for truncated Markdown", () => {
    expect(
      decideMarkdownTaskToggle({
        truncated: true,
        currentContents: "- [ ] A\n",
        markerOffset: 2,
        checked: true,
      }),
    ).toEqual({ kind: "blocked_truncated" });
  });

  it("returns changed contents for a writable task toggle", () => {
    expect(
      decideMarkdownTaskToggle({
        truncated: false,
        currentContents: "- [ ] A\n",
        markerOffset: 2,
        checked: true,
      }),
    ).toEqual({ kind: "write", contents: "- [x] A\n" });
  });

  it("does not write when the marker offset is stale", () => {
    expect(
      decideMarkdownTaskToggle({
        truncated: false,
        currentContents: "- [ ] A\n",
        markerOffset: 0,
        checked: true,
      }),
    ).toEqual({ kind: "unchanged" });
  });

  it("never writes a truncated prefix from a file over 1 MB", () => {
    const currentContents = "- [ ] A\n" + "x".repeat(1_120_000);

    expect(
      decideMarkdownTaskToggle({
        truncated: true,
        currentContents,
        markerOffset: 2,
        checked: true,
      }),
    ).toEqual({ kind: "blocked_truncated" });
  });
});
