import { TriangleAlertIcon } from "lucide-react";

import { environmentCatalog } from "../connection/catalog";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { Button } from "./ui/button";
import { isSessionExpiredConnectionState } from "./SessionExpiredBanner.logic";

/**
 * Root-mounted, non-dismissable banner for the "session expired" failure
 * mode: the dev loopback token rotates on server restart, so an already-open
 * tab's reconnect attempts fail authentication and the app otherwise goes
 * quiet with no error surface (see SessionExpiredBanner.logic.ts). There is
 * no way to self-heal from inside the tab (the fresh token lives in a new
 * URL the server prints on startup), so the banner never offers a dismiss
 * action — only a reload, which is also the affordance a user reaches for
 * first and, on the desktop shell, re-triggers the bootstrap that can mint a
 * fresh credential.
 */
export function SessionExpiredBanner() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const connectionState = useEnvironmentQuery(
    primaryEnvironmentId !== null ? environmentCatalog.stateAtom(primaryEnvironmentId) : null,
  );

  if (!isSessionExpiredConnectionState(connectionState.data)) {
    return null;
  }

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="fixed inset-x-0 top-0 z-100 flex items-center justify-center gap-3 border-b border-destructive/40 bg-destructive px-4 py-2 text-center text-sm text-text-inverse shadow-lg"
    >
      <TriangleAlertIcon className="size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0">
        Session expired — the server restarted. Reload with a fresh link.
      </span>
      <Button
        size="sm"
        variant="outline"
        className="shrink-0 border-text-inverse/40 bg-transparent text-text-inverse hover:bg-text-inverse/10"
        onClick={() => window.location.reload()}
      >
        Reload
      </Button>
    </div>
  );
}
