import type { RunAttemptStatus } from "@neokod/contracts";
import { describe, expect, it } from "vite-plus/test";

import { filterRuns } from "./symphonyRuns.logic";

const run = (id: string, status: RunAttemptStatus) => ({ id, status });

const runs = [
  run("active-streaming", "streaming_turn"),
  run("active-preparing", "preparing_workspace"),
  run("finished-succeeded", "succeeded"),
  run("finished-failed", "failed"),
  run("finished-cancelled", "user_cancelled"),
  run("finished-interrupted", "interrupted"),
];

describe("filterRuns", () => {
  it("keeps every run for the all filter", () => {
    expect(filterRuns(runs, "all")).toEqual(runs);
  });

  it("splits active statuses from finished statuses", () => {
    expect(filterRuns(runs, "active").map((entry) => entry.id)).toEqual([
      "active-streaming",
      "active-preparing",
    ]);
    expect(filterRuns(runs, "finished").map((entry) => entry.id)).toEqual([
      "finished-succeeded",
      "finished-failed",
      "finished-cancelled",
      "finished-interrupted",
    ]);
  });
});
