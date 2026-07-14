import { __resetPrimaryEnvironmentBootstrapForTests } from "~/environments/primary";
import { __resetClientSettingsPersistenceForTests } from "~/hooks/useSettings";
import { __resetLocalApiForTests } from "~/localApi";
import { useBrowserPointerStore } from "~/browser/browserPointerStore";
import { useBrowserSurfaceStore } from "~/browser/browserSurfaceStore";
import { useComposerDraftStore } from "~/composerDraftStore";
import { useDiffPanelStore } from "~/diffPanelStore";
import { useMissionControlUiStore } from "~/missionControlUiStore";
import { resetAppAtomRegistryForTests } from "~/rpc/atomRegistry";
import { useRightPanelStore } from "~/rightPanelStore";
import { useSubagentUiStore } from "~/subagentUiStore";
import { useTerminalUiStateStore } from "~/terminalUiStateStore";
import { useThreadSelectionStore } from "~/threadSelectionStore";
import { useUiStateStore } from "~/uiStateStore";
import { useWorkspaceRailUiStore } from "~/workspaceRailUiStore";

import type { MockEnvironmentServer } from "./mockEnvironmentServer";

type ResettableStore = {
  readonly getInitialState: () => unknown;
  readonly persist?: { readonly clearStorage: () => void };
  readonly setState: (state: never, replace: true) => unknown;
};

function resetStore(store: ResettableStore): void {
  store.setState(store.getInitialState() as never, true);
  store.persist?.clearStorage();
}

function deleteConnectionRuntimeDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase("t3code:connection-runtime");
    request.addEventListener("success", () => resolve(), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
    request.addEventListener(
      "blocked",
      () => reject(new Error("Connection runtime IndexedDB database remained open.")),
      { once: true },
    );
  });
}

export async function resetBrowserAppHarness(input: {
  readonly disposeRuntime?: () => Promise<void>;
  readonly server: MockEnvironmentServer;
  readonly unmount?: () => Promise<void>;
}): Promise<void> {
  await input.unmount?.();
  await input.disposeRuntime?.();
  resetAppAtomRegistryForTests();
  await input.server.assertNoLeaks();
  __resetPrimaryEnvironmentBootstrapForTests();
  await __resetLocalApiForTests();
  __resetClientSettingsPersistenceForTests();

  resetStore(useComposerDraftStore);
  resetStore(useRightPanelStore);
  resetStore(useTerminalUiStateStore);
  resetStore(useDiffPanelStore);
  resetStore(useSubagentUiStore);
  resetStore(useUiStateStore);
  resetStore(useThreadSelectionStore);
  resetStore(useBrowserPointerStore);
  resetStore(useBrowserSurfaceStore);
  resetStore(useMissionControlUiStore);
  resetStore(useWorkspaceRailUiStore);

  localStorage.clear();
  sessionStorage.clear();
  await deleteConnectionRuntimeDatabase();
  document.body.replaceChildren();
  await input.server.assertNoLeaks();
}
