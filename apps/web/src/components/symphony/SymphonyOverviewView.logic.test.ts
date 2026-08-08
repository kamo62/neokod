import type { SymphonyOverview } from "@neokod/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveSymphonyOverviewMetric,
  resolveSymphonyOverviewViewState,
} from "./SymphonyOverviewView.logic";

const knownMetric = (value: number): SymphonyOverview["running"] => ({ state: "known", value });

function overview(overrides: Partial<SymphonyOverview> = {}): SymphonyOverview {
  return {
    running: knownMetric(0),
    queued: knownMetric(0),
    needsAttention: knownMetric(0),
    readyForReview: knownMetric(0),
    retrying: knownMetric(0),
    failedToday: knownMetric(0),
    orchestratorPaused: false,
    activeWorkflowCount: knownMetric(0),
    providerHealth: {},
    trackerHealth: {},
    lastTrackerPollAt: null,
    activeAgentCount: knownMetric(0),
    generatedAt: "2026-08-08T10:00:00.000Z",
    ...overrides,
  };
}

describe("resolveSymphonyOverviewMetric", () => {
  it("renders a known zero as zero", () => {
    expect(resolveSymphonyOverviewMetric(knownMetric(0))).toEqual({
      state: "known",
      value: 0,
      label: "0",
    });
  });

  it("keeps unavailable evidence unavailable", () => {
    expect(
      resolveSymphonyOverviewMetric({ state: "unavailable", reason: "queue read failed" }),
    ).toEqual({
      state: "unavailable",
      reason: "queue read failed",
      label: "Unavailable",
    });
  });
});

describe("resolveSymphonyOverviewViewState", () => {
  it("keeps known zero metrics as ready evidence", () => {
    expect(
      resolveSymphonyOverviewViewState({
        hasEnvironment: true,
        data: overview(),
        isPending: false,
        error: null,
      }),
    ).toMatchObject({
      phase: "ready",
      overview: {
        running: { state: "known", value: 0 },
        queued: { state: "known", value: 0 },
        needsAttention: { state: "known", value: 0 },
      },
    });
  });

  it("does not fabricate zero metrics when data is missing", () => {
    const state = resolveSymphonyOverviewViewState({
      hasEnvironment: true,
      data: null,
      isPending: false,
      error: null,
    });

    expect(state).toEqual({
      phase: "unavailable",
      reason: "missing-data",
      message: "No Symphony overview data is available yet.",
    });
    expect(state).not.toHaveProperty("overview");
  });

  it("preserves request failure as unavailable evidence", () => {
    expect(
      resolveSymphonyOverviewViewState({
        hasEnvironment: true,
        data: null,
        isPending: false,
        error: "database unavailable",
      }),
    ).toEqual({
      phase: "unavailable",
      reason: "request-failed",
      message: "database unavailable",
    });
  });

  it("shows stale known data while retaining refresh failure", () => {
    const known = overview({ running: knownMetric(2) });
    expect(
      resolveSymphonyOverviewViewState({
        hasEnvironment: true,
        data: known,
        isPending: false,
        error: "refresh failed",
      }),
    ).toEqual({ phase: "ready", overview: known, refreshError: "refresh failed" });
  });

  it("distinguishes loading and missing environment states", () => {
    expect(
      resolveSymphonyOverviewViewState({
        hasEnvironment: true,
        data: null,
        isPending: true,
        error: null,
      }),
    ).toEqual({ phase: "loading" });
    expect(
      resolveSymphonyOverviewViewState({
        hasEnvironment: false,
        data: null,
        isPending: false,
        error: null,
      }),
    ).toMatchObject({ phase: "unavailable", reason: "no-environment" });
  });
});
