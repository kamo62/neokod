import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser/context";
import { render } from "vitest-browser-react";
import { useState } from "react";

import { ComposerCommandMenu, type ComposerCommandItem } from "./ComposerCommandMenu";

const modelItem: ComposerCommandItem = {
  id: "model",
  type: "slash-command",
  command: "model",
  label: "/model",
  description: "Choose a model",
};
const planItem: ComposerCommandItem = {
  id: "plan",
  type: "slash-command",
  command: "plan",
  label: "/plan",
  description: "Switch to plan mode",
};
const items: ComposerCommandItem[] = [modelItem, planItem];

const cleanups: Array<() => Promise<void>> = [];

function MenuHarness(props: {
  items: ComposerCommandItem[];
  onHighlightedItemChange: (itemId: string | null) => void;
  onSelect: (item: ComposerCommandItem) => void;
}) {
  const [activeItemId, setActiveItemId] = useState<string | null>(null);

  return (
    <ComposerCommandMenu
      items={props.items}
      resolvedTheme="light"
      isLoading={false}
      triggerKind="slash-command"
      activeItemId={activeItemId}
      onHighlightedItemChange={(itemId) => {
        props.onHighlightedItemChange(itemId);
        setActiveItemId(itemId);
      }}
      onSelect={props.onSelect}
    />
  );
}

async function mountMenu(menuItems = items) {
  const onHighlightedItemChange = vi.fn();
  const onSelect = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(
    <MenuHarness
      items={menuItems}
      onHighlightedItemChange={onHighlightedItemChange}
      onSelect={onSelect}
    />,
    { container: host },
  );

  cleanups.push(async () => {
    await screen.unmount();
    host.remove();
  });

  return { onHighlightedItemChange, onSelect };
}

describe("ComposerCommandMenu", () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("renders supplied command items", async () => {
    await mountMenu([planItem]);

    await expect.element(page.getByRole("option", { name: "/plan" })).toBeVisible();
    await expect.element(page.getByText("/model")).not.toBeInTheDocument();
  });

  // Keyboard navigation belongs to the routed composer test in M2.
  it("updates the controlled highlight on pointer movement", async () => {
    const menu = await mountMenu();
    const plan = page.getByRole("option", { name: "/plan" });

    await userEvent.hover(plan);

    expect(menu.onHighlightedItemChange).toHaveBeenLastCalledWith("plan");
    await expect.element(plan).toHaveClass("bg-accent!");
  });

  it("selects the clicked command once", async () => {
    const menu = await mountMenu();

    await page.getByRole("option", { name: "/plan" }).click();

    expect(menu.onSelect).toHaveBeenCalledTimes(1);
    expect(menu.onSelect).toHaveBeenCalledWith(planItem);
  });
});
