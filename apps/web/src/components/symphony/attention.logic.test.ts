import type { AttentionItem } from "@neokod/contracts";
import { describe, expect, it } from "vite-plus/test";

import { approvalRequestMode, attentionMode } from "./attention.logic";

const attentionItem = (availableActions: ReadonlyArray<string>) =>
  ({ availableActions }) as Pick<AttentionItem, "availableActions">;

describe("attentionMode", () => {
  it("treats an answerable item as a question", () => {
    expect(attentionMode(attentionItem(["answer"]))).toBe("question");
  });

  it("treats an approve/reject item as an approval", () => {
    expect(attentionMode(attentionItem(["approve", "reject"]))).toBe("approval");
  });

  it("treats an item with no request controls as info", () => {
    expect(attentionMode(attentionItem(["re-dispatch", "take-over", "abandon"]))).toBe("info");
  });
});

describe("approvalRequestMode", () => {
  it("recognises the persisted user-input action as a question", () => {
    expect(approvalRequestMode({ action: "user_input" as never })).toBe("question");
  });

  it("treats a command approval as an approval", () => {
    expect(approvalRequestMode({ action: "command_execution" })).toBe("approval");
  });
});
