import * as NodeFS from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ApprovalSettingsNote } from "./SymphonyProjectConfigurationForm.tsx";

describe("ApprovalSettingsNote", () => {
  it("renders the approval note and no approval checkboxes", () => {
    const html = renderToStaticMarkup(<ApprovalSettingsNote />);
    expect(html).toContain("not gated by an approval setting");
    expect(html).toContain("never merges on its own");
  });

  it("removes the three approval checkbox labels from the form source", () => {
    const source = NodeFS.readFileSync(
      new URL("./SymphonyProjectConfigurationForm.tsx", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("Approve before push");
    expect(source).not.toContain("Approve before PR");
    expect(source).not.toContain("Approve before merge");
  });
});
