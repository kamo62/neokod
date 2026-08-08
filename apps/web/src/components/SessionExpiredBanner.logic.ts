import type { SupervisorConnectionState } from "@neokod/client-runtime/connection";

/**
 * Session-expired detection, computed entirely web-side from the connection
 * state machinery packages/client-runtime already publishes per environment
 * (apps/web/src/connection/, state/environments.ts). No new signal is
 * invented and client-runtime is not modified.
 *
 * The dev loopback token rotates on every server restart (plan WS-A2). An
 * open tab keeps the stale token, so the next reconnect attempt (on socket
 * drop, on a wakeup such as focus/visibility) fails the WebSocket upgrade
 * with a 401. That failure is already mapped, inside client-runtime, to
 * `ConnectionBlockedError({ reason: "authentication" })`
 * (packages/client-runtime/src/connection/errors.ts), which parks the
 * connection supervisor in `phase: "blocked"` until something reconnects it
 * (packages/client-runtime/src/connection/supervisor.ts). Nothing today
 * reads that state for UI, so the app just goes quiet: empty sidebar,
 * zeroed views, repeated 401s in the console on every wakeup.
 */
export function isSessionExpiredConnectionState(
  state: SupervisorConnectionState | null | undefined,
): boolean {
  if (!state || state.phase !== "blocked" || state.lastFailure === null) {
    return false;
  }

  return (
    state.lastFailure._tag === "ConnectionBlockedError" &&
    state.lastFailure.reason === "authentication"
  );
}
