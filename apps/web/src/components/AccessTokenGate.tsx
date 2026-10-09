import { useSyncExternalStore } from "react";

import { environmentCatalog } from "../connection/catalog";
import {
  checkPrimaryAccessToken,
  clearPrimaryAccessToken,
  readPrimaryAccessGate,
  readPrimaryAccessToken,
  storePrimaryAccessToken,
  subscribePrimaryAccessGate,
} from "../environments/primary/accessToken";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { AccessTokenPrompt } from "./AccessTokenPrompt";
import { isSessionExpiredConnectionState } from "./SessionExpiredBanner.logic";

export function AccessTokenGate() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const connectionState = useEnvironmentQuery(
    primaryEnvironmentId !== null ? environmentCatalog.stateAtom(primaryEnvironmentId) : null,
  );
  const gate = useSyncExternalStore(subscribePrimaryAccessGate, readPrimaryAccessGate);

  if (typeof window !== "undefined" && window.desktopBridge !== undefined) return null;
  const verify = checkPrimaryAccessToken;
  const onAccepted = (token: string) => {
    storePrimaryAccessToken(token);
    window.location.reload();
  };
  const onForget = () => {
    clearPrimaryAccessToken();
    window.location.reload();
  };
  if (gate === "rejected" || isSessionExpiredConnectionState(connectionState.data)) {
    return (
      <AccessTokenPrompt
        reason="rejected"
        hasStoredToken={readPrimaryAccessToken() !== undefined}
        verify={verify}
        onAccepted={onAccepted}
        onForget={onForget}
      />
    );
  }
  if (gate === "required") {
    return (
      <AccessTokenPrompt
        reason="required"
        hasStoredToken={readPrimaryAccessToken() !== undefined}
        verify={verify}
        onAccepted={onAccepted}
        onForget={onForget}
      />
    );
  }
  return null;
}
