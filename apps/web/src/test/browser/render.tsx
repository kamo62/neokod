import type { ReactElement } from "react";
import { render } from "vitest-browser-react";

export async function renderBrowserHarness(ui: ReactElement) {
  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(ui, { container: host });

  return {
    async unmount() {
      await screen.unmount();
      host.remove();
    },
  };
}
