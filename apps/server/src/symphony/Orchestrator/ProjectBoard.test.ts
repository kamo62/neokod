import { describe, expect, it } from "@effect/vitest";
import type { WorkLifecycle } from "@neokod/contracts";

import { boardColumnForLifecycle } from "./ProjectBoard.ts";

describe("boardColumnForLifecycle", () => {
  it("maps every lifecycle into the five server-owned columns", () => {
    const expected: Record<WorkLifecycle, ReturnType<typeof boardColumnForLifecycle>> = {
      draft: "not_started",
      eligible: "not_started",
      queued: "not_started",
      preparing: "in_progress",
      running: "in_progress",
      blocked: "in_progress",
      waiting_for_approval: "in_progress",
      retry_scheduled: "in_progress",
      changes_requested: "in_progress",
      testing: "testing",
      validation_failed: "testing",
      ready_for_review: "human_review",
      ready_to_merge: "human_review",
      completed: "done",
      cancelled: "done",
      failed: "done",
    };

    for (const [lifecycle, column] of Object.entries(expected)) {
      expect(boardColumnForLifecycle(lifecycle as WorkLifecycle)).toBe(column);
    }
  });
});
