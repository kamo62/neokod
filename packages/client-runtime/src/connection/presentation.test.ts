import { EnvironmentId } from "@neokod/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import type { ConnectionCatalogEntry } from "./catalog.ts";
import {
  ConnectionTransientError,
  WslConnectionTarget,
  type SupervisorConnectionState,
} from "./model.ts";
import {
  connectionCatalogDisplayUrl,
  connectionPhaseMessage,
  connectionStatusText,
  presentEnvironmentConnection,
  presentConnectionState,
} from "./presentation.ts";

const TARGET = new WslConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "WSL environment",
  connectionId: "connection-1",
  httpBaseUrl: "http://172.27.0.2:3778",
  wsBaseUrl: "ws://172.27.0.2:3778",
});

const ENTRY: ConnectionCatalogEntry = {
  target: TARGET,
  wslBearerToken: Option.some("wsl-bearer-token"),
};

function supervisorState(overrides: Partial<SupervisorConnectionState>): SupervisorConnectionState {
  return {
    desired: true,
    network: "online",
    phase: "connecting",
    stage: "preparing",
    attempt: 1,
    generation: 0,
    lastFailure: null,
    retryAt: null,
    ...overrides,
  };
}

describe("connection presentation", () => {
  it("preserves profile display information without exposing credentials", () => {
    expect(connectionCatalogDisplayUrl(ENTRY)).toBe("http://172.27.0.2:3778");
  });

  it("distinguishes initial connection, reconnect, and retry errors", () => {
    expect(presentConnectionState(supervisorState({ phase: "connecting", attempt: 1 }))).toEqual({
      phase: "connecting",
      error: null,
      traceId: null,
    });
    expect(
      presentConnectionState(
        supervisorState({
          phase: "connecting",
          attempt: 2,
          lastFailure: new ConnectionTransientError({
            reason: "transport",
            detail: "Socket closed.",
            traceId: "trace-previous",
          }),
        }),
      ),
    ).toEqual({
      phase: "reconnecting",
      error: "Socket closed.",
      traceId: "trace-previous",
    });
    expect(
      presentConnectionState(
        supervisorState({
          phase: "backoff",
          attempt: 2,
          retryAt: 1,
          lastFailure: new ConnectionTransientError({
            reason: "transport",
            detail: "Disconnected.",
            traceId: "trace-1",
          }),
        }),
      ),
    ).toEqual({
      phase: "reconnecting",
      error: "Disconnected.",
      traceId: "trace-1",
    });
  });

  it("preserves the latest failure while the next attempt is active", () => {
    expect(
      presentEnvironmentConnection(
        supervisorState({
          phase: "connecting",
          stage: "opening",
          attempt: 2,
          lastFailure: new ConnectionTransientError({
            reason: "transport",
            detail: "Remote connection timed out.",
            traceId: "trace-retry",
          }),
        }),
      ),
    ).toEqual({
      phase: "reconnecting",
      error: "Remote connection timed out.",
      traceId: "trace-retry",
    });
  });

  it("gives offline status precedence in global messaging", () => {
    expect(connectionPhaseMessage("connected", TARGET.label, "offline")).toBe("You are offline");
  });

  it("combines reconnect progress with the latest failure", () => {
    expect(
      connectionStatusText({
        phase: "reconnecting",
        error: "Remote request timed out.",
        traceId: "trace-retry",
      }),
    ).toBe("Failed to connect. Reconnecting... Reason: Remote request timed out.");
  });

  it("presents the supervisor's offline state without consulting shell state", () => {
    expect(
      presentEnvironmentConnection(
        supervisorState({
          network: "offline",
          phase: "offline",
          stage: null,
        }),
      ),
    ).toEqual({
      phase: "offline",
      error: null,
      traceId: null,
    });
  });

  it("presents a connected supervisor snapshot as connected", () => {
    expect(
      presentEnvironmentConnection(
        supervisorState({
          phase: "connected",
          stage: null,
          generation: 1,
        }),
      ),
    ).toEqual({
      phase: "connected",
      error: null,
      traceId: null,
    });
  });

  it("preserves an explicitly available environment while offline", () => {
    expect(
      presentEnvironmentConnection(
        supervisorState({
          desired: false,
          network: "offline",
          phase: "available",
          stage: null,
          attempt: 0,
        }),
      ),
    ).toEqual({
      phase: "available",
      error: null,
      traceId: null,
    });
  });
});
