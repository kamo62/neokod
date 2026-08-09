import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { WorkItemSchema } from "./symphony.ts";

const decodeWorkItem = Schema.decodeUnknownSync(WorkItemSchema);

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
