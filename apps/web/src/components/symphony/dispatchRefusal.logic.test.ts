import { describe, expect, it } from "vite-plus/test";

import { dispatchRefusalMessage } from "./dispatchRefusal.logic";

describe("dispatchRefusalMessage", () => {
  it("explains a lost leadership lock", () => {
    expect(dispatchRefusalMessage({ reason: "not_leader" })).toBe(
      "Another Neokod server is running Symphony. This server only observes.",
    );
  });

  it("explains a missing work item", () => {
    expect(dispatchRefusalMessage({ reason: "not_found" })).toBe(
      "This work item no longer exists.",
    );
  });

  it("explains a run already in progress", () => {
    expect(dispatchRefusalMessage({ reason: "already_running" })).toBe(
      "A run is already in progress for this item.",
    );
  });

  it("explains an item that cannot run from its current state", () => {
    expect(dispatchRefusalMessage({ reason: "not_dispatchable" })).toBe(
      "This item cannot be run from its current state.",
    );
  });

  it("explains a global pause", () => {
    expect(dispatchRefusalMessage({ reason: "paused", detail: "global" })).toBe(
      "Dispatch is paused for all projects.",
    );
  });

  it("explains a workflow pause", () => {
    expect(dispatchRefusalMessage({ reason: "paused", detail: "workflow" })).toBe(
      "Dispatch is paused for this project.",
    );
  });

  it("explains a repository pause", () => {
    expect(dispatchRefusalMessage({ reason: "paused", detail: "repository" })).toBe(
      "Dispatch is paused for this repository.",
    );
  });

  it("explains an excluded item", () => {
    expect(dispatchRefusalMessage({ reason: "excluded" })).toBe(
      "This item is excluded. Include it to run it.",
    );
  });

  it("explains an ineligible item with its reasons", () => {
    expect(
      dispatchRefusalMessage({ reason: "ineligible", detail: "missing_label:agent-ready" }),
    ).toBe("Not eligible: missing_label:agent-ready.");
  });

  it("explains a missing workflow", () => {
    expect(dispatchRefusalMessage({ reason: "no_workflow" })).toBe(
      "This project is not set up to run work. Check its settings.",
    );
  });

  it("explains observe-only autonomy", () => {
    expect(dispatchRefusalMessage({ reason: "observe_only" })).toBe(
      "Autonomy is set to observe. Change it to prepare, execute or deliver to run work.",
    );
  });

  it("explains the concurrency limit that was reached", () => {
    expect(dispatchRefusalMessage({ reason: "concurrency_cap", detail: "repository" })).toBe(
      "The repository concurrency limit is reached. Try again when a run finishes.",
    );
  });

  it("explains a tracker refresh failure", () => {
    expect(dispatchRefusalMessage({ reason: "tracker_refresh_failed" })).toBe(
      "Could not re-read this issue from the tracker. It may be closed, or the tracker is unreachable.",
    );
  });
});
