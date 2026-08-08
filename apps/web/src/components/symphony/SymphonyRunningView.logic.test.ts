import type { RunAttemptStatus } from "@neokod/contracts";
import { describe, expect, it } from "vite-plus/test";

import { runAttemptStatusBadgeVariant } from "./SymphonyRunningView.logic";

const ALL_STATUSES = [
  "preparing_workspace",
  "building_prompt",
  "launching_agent",
  "initializing_session",
  "streaming_turn",
  "finishing",
  "succeeded",
  "failed",
  "timed_out",
  "stalled",
  "canceled_by_reconciliation",
  "user_cancelled",
  "tracker_cancelled",
  "process_failed",
  "validation_failed",
  "workflow_error",
  "provider_error",
  "interrupted",
  "retries_exhausted",
] as const satisfies readonly RunAttemptStatus[];

describe("runAttemptStatusBadgeVariant", () => {
  it("explicitly presents every run-attempt status", () => {
    expect(ALL_STATUSES.map(runAttemptStatusBadgeVariant)).toHaveLength(ALL_STATUSES.length);
  });

  it("does not render succeeded or failed attempts as neutral", () => {
    expect(runAttemptStatusBadgeVariant("succeeded")).toBe("success");
    expect(runAttemptStatusBadgeVariant("failed")).toBe("error");
    expect(runAttemptStatusBadgeVariant("provider_error")).toBe("error");
  });

  it("keeps cancellations neutral and active phases informational", () => {
    expect(runAttemptStatusBadgeVariant("user_cancelled")).toBe("secondary");
    expect(runAttemptStatusBadgeVariant("streaming_turn")).toBe("info");
  });
});
