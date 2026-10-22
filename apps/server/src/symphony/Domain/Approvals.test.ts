import { describe, expect, it } from "@effect/vitest";

import { approvalRequestKind, approvalRequestKindForAction } from "./Approvals.ts";

describe("approvalRequestKind", () => {
  it("keeps an explicit request kind", () => {
    expect(approvalRequestKind({ kind: "user_input", action: "command_execution" })).toBe(
      "user_input",
    );
    expect(approvalRequestKind({ kind: "approval", action: "user_input" })).toBe("approval");
  });

  it("derives the kind from the action when the payload predates the field", () => {
    expect(approvalRequestKind({ action: "user_input" })).toBe("user_input");
    expect(approvalRequestKind({ action: "command_execution" })).toBe("approval");
    expect(approvalRequestKind({ action: "unknown" })).toBe("approval");
  });

  it("derives the kind from the request action vocabulary", () => {
    expect(approvalRequestKindForAction("file_change")).toBe("approval");
    expect(approvalRequestKindForAction("user_input")).toBe("user_input");
  });
});
