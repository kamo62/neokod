import "~/index.css";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import type { PrimaryAccessTokenCheck } from "../environments/primary/accessToken";
import { renderBrowserHarness } from "../test/browser/render";
import { AccessTokenPrompt } from "./AccessTokenPrompt";

let mounted: Awaited<ReturnType<typeof renderBrowserHarness>> | undefined;

async function renderPrompt(props: {
  reason: "required" | "rejected";
  hasStoredToken: boolean;
  verify: (token: string) => Promise<PrimaryAccessTokenCheck>;
  onAccepted: (token: string) => void;
  onForget: () => void;
}) {
  await mounted?.unmount();
  mounted = await renderBrowserHarness(<AccessTokenPrompt {...props} />);
}

afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  document.body.replaceChildren();
});

describe("AccessTokenPrompt browser presentation", () => {
  it("shows an inline error and keeps the field when the token is rejected", async () => {
    const onAccepted = vi.fn();
    await renderPrompt({
      reason: "required",
      hasStoredToken: false,
      verify: async () => "rejected",
      onAccepted,
      onForget: () => {},
    });

    await page.getByLabelText("Access token").fill("abc");
    await page.getByRole("button", { name: "Connect" }).click();
    await expect.element(page.getByText("That token was not accepted.")).toBeVisible();
    expect(onAccepted).not.toHaveBeenCalled();
  });

  it("accepts a valid token", async () => {
    const onAccepted = vi.fn();
    await renderPrompt({
      reason: "required",
      hasStoredToken: false,
      verify: async () => "accepted",
      onAccepted,
      onForget: () => {},
    });

    await page.getByLabelText("Access token").fill("abc");
    await page.getByRole("button", { name: "Connect" }).click();
    await expect.poll(() => onAccepted.mock.calls.length).toBe(1);
    expect(onAccepted).toHaveBeenCalledWith("abc");
  });

  it("shows the reach error when the server cannot be reached", async () => {
    await renderPrompt({
      reason: "required",
      hasStoredToken: false,
      verify: async () => "unreachable",
      onAccepted: () => {},
      onForget: () => {},
    });

    await page.getByLabelText("Access token").fill("abc");
    await page.getByRole("button", { name: "Connect" }).click();
    await expect
      .element(page.getByText("Could not reach the server. Check the address and try again."))
      .toBeVisible();
  });

  it("offers to forget a stored token", async () => {
    const onForget = vi.fn();
    await renderPrompt({
      reason: "required",
      hasStoredToken: true,
      verify: async () => "rejected",
      onAccepted: () => {},
      onForget,
    });

    await page.getByRole("button", { name: "Forget saved token" }).click();
    expect(onForget).toHaveBeenCalledTimes(1);
  });

  it("explains a rejected stored token", async () => {
    await renderPrompt({
      reason: "rejected",
      hasStoredToken: true,
      verify: async () => "rejected",
      onAccepted: () => {},
      onForget: () => {},
    });

    await expect.element(page.getByText("The saved access token was not accepted.")).toBeVisible();
  });
});
