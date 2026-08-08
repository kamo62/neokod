import {
  ConnectionBlockedError,
  ConnectionTransientError,
  type SupervisorConnectionState,
} from "@neokod/client-runtime/connection";
import { describe, expect, it } from "vite-plus/test";

import { isSessionExpiredConnectionState } from "./SessionExpiredBanner.logic";

function stateWith(overrides: Partial<SupervisorConnectionState> = {}): SupervisorConnectionState {
  return {
    desired: true,
    network: "online",
    phase: "blocked",
    stage: null,
    attempt: 1,
    generation: 0,
    lastFailure: new ConnectionBlockedError({
      reason: "authentication",
      detail: "The environment rejected the bearer credential.",
    }),
    retryAt: null,
    ...overrides,
  };
}

describe("isSessionExpiredConnectionState", () => {
  it("is false for null/undefined state", () => {
    expect(isSessionExpiredConnectionState(null)).toBe(false);
    expect(isSessionExpiredConnectionState(undefined)).toBe(false);
  });

  it("is true when blocked on an authentication failure", () => {
    expect(isSessionExpiredConnectionState(stateWith())).toBe(true);
  });

  it("is false when connected", () => {
    expect(
      isSessionExpiredConnectionState(stateWith({ phase: "connected", lastFailure: null })),
    ).toBe(false);
  });

  it("is false when backing off from a transient failure, not blocked", () => {
    expect(
      isSessionExpiredConnectionState(
        stateWith({
          phase: "backoff",
          lastFailure: new ConnectionTransientError({
            reason: "network",
            detail: "offline",
          }),
        }),
      ),
    ).toBe(false);
  });

  it("is false when blocked for a non-authentication reason (e.g. configuration)", () => {
    expect(
      isSessionExpiredConnectionState(
        stateWith({
          lastFailure: new ConnectionBlockedError({
            reason: "configuration",
            detail: "The environment endpoint is misconfigured.",
          }),
        }),
      ),
    ).toBe(false);
  });

  it("is false when blocked with no recorded failure", () => {
    expect(isSessionExpiredConnectionState(stateWith({ lastFailure: null }))).toBe(false);
  });

  it("is false for the initial available state", () => {
    expect(
      isSessionExpiredConnectionState(
        stateWith({ desired: false, phase: "available", lastFailure: null }),
      ),
    ).toBe(false);
  });
});
