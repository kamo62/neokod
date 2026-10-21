export const isMarkdownPreviewFile = (path: string): boolean => /\.(?:md|mdx)$/i.test(path);

export function setMarkdownTaskChecked(
  markdown: string,
  markerOffset: number,
  checked: boolean,
): string {
  if (
    markerOffset < 0 ||
    markdown[markerOffset] !== "[" ||
    !/[ xX]/.test(markdown[markerOffset + 1] ?? "") ||
    markdown[markerOffset + 2] !== "]"
  ) {
    return markdown;
  }

  return `${markdown.slice(0, markerOffset + 1)}${checked ? "x" : " "}${markdown.slice(markerOffset + 2)}`;
}

export type MarkdownTaskToggleDecision =
  | { readonly kind: "blocked_truncated" }
  | { readonly kind: "unchanged" }
  | { readonly kind: "write"; readonly contents: string };

export function decideMarkdownTaskToggle(input: {
  readonly truncated: boolean;
  readonly currentContents: string;
  readonly markerOffset: number;
  readonly checked: boolean;
}): MarkdownTaskToggleDecision {
  if (input.truncated) return { kind: "blocked_truncated" };
  const contents = setMarkdownTaskChecked(input.currentContents, input.markerOffset, input.checked);
  return contents === input.currentContents ? { kind: "unchanged" } : { kind: "write", contents };
}
