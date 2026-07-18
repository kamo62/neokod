import * as Effect from "effect/Effect";

import * as DesktopIpc from "./DesktopIpc.ts";
import { getClientSettings, setClientSettings } from "./methods/clientSettings.ts";
import {
  clearConnectionCatalog,
  getConnectionCatalog,
  setConnectionCatalog,
} from "./methods/connectionCatalog.ts";
import {
  checkForUpdate,
  downloadUpdate,
  getUpdateState,
  installUpdate,
} from "./methods/updates.ts";
import {
  confirm,
  getAppBranding,
  getLocalEnvironmentBootstraps,
  openExternal,
  pickFolder,
  setTheme,
  showContextMenu,
} from "./methods/window.ts";
import * as PreviewIpc from "./methods/preview.ts";
import { getWslState, setWslBackendEnabled, setWslDistro, setWslOnly } from "./methods/wsl.ts";

export const installDesktopIpcHandlers = Effect.fn("desktop.ipc.installHandlers")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;
  yield* PreviewIpc.installPreviewEventForwarding();

  yield* ipc.handleSync(getAppBranding);
  yield* ipc.handleSync(getLocalEnvironmentBootstraps);

  yield* ipc.handle(getClientSettings);
  yield* ipc.handle(setClientSettings);
  yield* ipc.handle(getConnectionCatalog);
  yield* ipc.handle(setConnectionCatalog);
  yield* ipc.handle(clearConnectionCatalog);

  yield* ipc.handle(getWslState);
  yield* ipc.handle(setWslBackendEnabled);
  yield* ipc.handle(setWslDistro);
  yield* ipc.handle(setWslOnly);

  yield* ipc.handle(pickFolder);
  yield* ipc.handle(confirm);
  yield* ipc.handle(setTheme);
  yield* ipc.handle(showContextMenu);
  yield* ipc.handle(openExternal);
  yield* ipc.handle(getUpdateState);
  yield* ipc.handle(downloadUpdate);
  yield* ipc.handle(installUpdate);
  yield* ipc.handle(checkForUpdate);
  for (const previewMethod of PreviewIpc.methods) {
    yield* ipc.handle(previewMethod);
  }
});
