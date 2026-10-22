import { describe, expect, it } from "vite-plus/test";

import { canRunNow, formatEligibilityReason, runActionLabel } from "./boardCard.logic";

describe("canRunNow", () => {
  it("allows queued, retry_scheduled, changes_requested, and validation_failed cards", () => {
    expect(canRunNow({ lifecycle: "queued", eligibilityReasons: [] })).toBe(true);
    expect(canRunNow({ lifecycle: "retry_scheduled", eligibilityReasons: [] })).toBe(true);
    expect(canRunNow({ lifecycle: "changes_requested", eligibilityReasons: [] })).toBe(true);
    expect(canRunNow({ lifecycle: "validation_failed", eligibilityReasons: [] })).toBe(true);
    expect(canRunNow({ lifecycle: "queued" })).toBe(true);
  });

  it("refuses ineligible, running, and queued cards with reasons", () => {
    expect(canRunNow({ lifecycle: "ineligible", eligibilityReasons: [] })).toBe(false);
    expect(canRunNow({ lifecycle: "running", eligibilityReasons: [] })).toBe(false);
    expect(
      canRunNow({ lifecycle: "queued", eligibilityReasons: ["missing_label:agent-ready"] }),
    ).toBe(false);
  });
});

describe("runActionLabel", () => {
  it("asks for a fresh run on review and validation follow-ups", () => {
    expect(runActionLabel("changes_requested")).toBe("Run again");
    expect(runActionLabel("validation_failed")).toBe("Run again");
    expect(runActionLabel("queued")).toBe("Run now");
  });
});

describe("formatEligibilityReason", () => {
  it("formats each known reason", () => {
    expect(formatEligibilityReason("missing_label:agent-ready")).toBe(
      'Missing label "agent-ready"',
    );
    expect(formatEligibilityReason("state_not_active:Blocked")).toBe(
      'State "Blocked" is not active',
    );
    expect(formatEligibilityReason("state_terminal:Done")).toBe('State "Done" is closed');
    expect(formatEligibilityReason("not_dispatchable")).toBe(
      "The tracker marks it not dispatchable",
    );
    expect(formatEligibilityReason("already_claimed")).toBe("Already claimed");
    expect(formatEligibilityReason("blank_required_label")).toBe("A required label is blank");
    expect(formatEligibilityReason("dispatch_paused")).toBe("Dispatch is paused");
  });

  it("returns unrecognised text unchanged", () => {
    expect(formatEligibilityReason("something_new")).toBe("something_new");
  });
});
