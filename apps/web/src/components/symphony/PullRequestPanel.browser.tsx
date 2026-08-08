import { afterEach, describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";
import { render } from "vitest-browser-react";

import { makeModelReview } from "./PullRequestPanel.test-fixtures.ts";
import { ModelReviewStrip } from "./PullRequestPanel.tsx";

const cleanups: Array<() => Promise<void>> = [];

async function mountModelReviewStrip() {
  const host = document.createElement("div");
  host.className =
    "mx-auto mt-12 max-w-3xl rounded-xl border border-border bg-background px-6 pb-6 text-foreground shadow-sm";
  document.body.append(host);
  const screen = await render(<ModelReviewStrip modelReview={makeModelReview()} />, {
    container: host,
  });

  cleanups.push(async () => {
    await screen.unmount();
    host.remove();
  });
}

describe("ModelReviewStrip browser evidence", () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("renders the compact verdict strip and reveals a reviewer's findings inline", async () => {
    await mountModelReviewStrip();

    const strip = page.getByRole("region", { name: "Model review" });
    const changesChip = page.getByRole("button", { name: "claude-fable-5: Changes" });

    await expect.element(strip).toBeVisible();
    await expect.element(page.getByText("Review blocked · 1 of 2 approve")).toBeVisible();
    await expect.element(changesChip).toHaveAttribute("aria-expanded", "false");
    const restScreenshot = await page.screenshot({ element: strip, save: false });
    expect(restScreenshot.length).toBeGreaterThan(1_000);

    await changesChip.click();

    await expect.element(changesChip).toHaveAttribute("aria-expanded", "true");
    await expect.element(page.getByText("A blocking issue remains.")).toBeVisible();
    await expect.element(page.getByText("blocking", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Guard the fallback")).toBeVisible();
    await expect.element(page.getByText("src/gate.ts")).toBeVisible();
    await expect.element(page.getByText("The fallback bypasses the gate.")).toBeVisible();
    const expandedScreenshot = await page.screenshot({ element: strip, save: false });
    expect(expandedScreenshot.length).toBeGreaterThan(restScreenshot.length);
  });
});
