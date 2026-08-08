import { RouterProvider } from "@tanstack/react-router";

import { ElectronBrowserHost } from "./browser/ElectronBrowserHost";
import { PreviewAutomationHosts } from "./components/preview/PreviewAutomationHosts";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";
import { useUiStateStore } from "./uiStateStore";

// Appearance master knobs (--ui-scale, --radius-base): applied to the
// document root the same way useTheme.ts applies the dark/light class —
// synchronously at module load, before the first paint, so there's no flash
// from a default value swapping in after hydration. uiStateStore.ts already
// reads the persisted values synchronously when it's imported, so the store
// is ready by the time this module runs. The subscription keeps the root in
// sync whenever Appearance settings changes either knob.
function applyUiKnobsToDocumentRoot(knobs: {
  readonly uiScale: number;
  readonly radiusBase: number;
}) {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty("--ui-scale", String(knobs.uiScale));
  document.documentElement.style.setProperty("--radius-base", `${knobs.radiusBase}px`);
}

applyUiKnobsToDocumentRoot(useUiStateStore.getState());
useUiStateStore.subscribe((state, previousState) => {
  if (state.uiScale === previousState.uiScale && state.radiusBase === previousState.radiusBase) {
    return;
  }
  applyUiKnobsToDocumentRoot(state);
});

/**
 * Owns renderer-wide providers. The Electron browser host intentionally sits
 * outside the router so its webviews survive route transitions, but it must
 * share the same atom registry as routed UI.
 */
export function AppRoot({ router }: { readonly router: AppRouter }) {
  return (
    <AppAtomRegistryProvider>
      <RouterProvider router={router} />
      <PreviewAutomationHosts />
      <ElectronBrowserHost />
    </AppAtomRegistryProvider>
  );
}
