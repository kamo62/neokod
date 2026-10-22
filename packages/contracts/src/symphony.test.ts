import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ApprovalRequestSchema, WorkItemSchema } from "./symphony.ts";

const decodeWorkItem = Schema.decodeUnknownSync(WorkItemSchema);
const decodeApprovalRequest = Schema.decodeUnknownSync(ApprovalRequestSchema);

const workItem = {
  id: "work-item-1",
  mode: "symphony",
  objective: "Verify process identity",
  acceptanceCriteria: [],
  source: { kind: "manual" },
  lifecycle: "running",
  eligibilityReasons: [],
  evidence: null,
  createdAt: "2026-08-08T10:00:00.000Z",
  updatedAt: "2026-08-08T10:00:00.000Z",
} as const;

describe("WorkItemSchema process identity", () => {
  it("accepts a positive matching process identity tuple", () => {
    expect(
      decodeWorkItem({
        ...workItem,
        ownerPid: 42,
        ownerPgid: 42,
      }),
    ).toMatchObject({ ownerPid: 42, ownerPgid: 42 });
  });

  it.each([
    ["zero", { ownerPid: 0, ownerPgid: 0 }],
    ["negative", { ownerPid: -42, ownerPgid: -42 }],
    ["missing ownerPid", { ownerPgid: 42 }],
    ["mismatched ownerPid", { ownerPid: 41, ownerPgid: 42 }],
  ])("rejects a %s process identity tuple", (_name, identity) => {
    expect(() => decodeWorkItem({ ...workItem, ...identity })).toThrow();
  });

  it.each([
    ["absent", {}],
    ["unspawned", { ownerPid: null, ownerPgid: null }],
    ["unsupported group signalling", { ownerPid: 42, ownerPgid: null }],
  ])("accepts %s group signalling metadata", (_name, identity) => {
    expect(() => decodeWorkItem({ ...workItem, ...identity })).not.toThrow();
  });
});

const approvalRequest = {
  id: "sym-1",
  requestId: "req-1",
  workItemId: "work-item-1",
  action: "command_execution",
  scope: "once",
  state: "pending",
  affectedFiles: [],
  createdAt: "2026-08-08T10:00:00.000Z",
  decidedAt: null,
} as const;

describe("ApprovalRequestSchema request kind", () => {
  it("decodes a payload written before the request kind existed", () => {
    // Pre-kind payloads only carry the action. They are evidence, so they must
    // decode rather than be rejected; the consumer derives the kind.
    const decoded = decodeApprovalRequest(approvalRequest);
    expect(decoded.kind).toBeUndefined();
    expect(decoded.action).toBe("command_execution");
  });

  it("decodes a pre-kind user-input payload", () => {
    const decoded = decodeApprovalRequest({ ...approvalRequest, action: "user_input" });
    expect(decoded.kind).toBeUndefined();
    expect(decoded.action).toBe("user_input");
  });

  it("keeps an explicit request kind", () => {
    expect(decodeApprovalRequest({ ...approvalRequest, kind: "user_input" }).kind).toBe(
      "user_input",
    );
  });

  it("accepts an interrupted decision", () => {
    expect(
      decodeApprovalRequest({
        ...approvalRequest,
        kind: "approval",
        state: "interrupted",
        decision: "interrupted",
      }).decision,
    ).toBe("interrupted");
  });
});
