import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const stateRule = createOxlintRuleHarness("neokod/no-client-authored-server-timestamp", {
  filename: "apps/web/src/state/threadCommands.ts",
});

const componentRule = createOxlintRuleHarness("neokod/no-client-authored-server-timestamp", {
  filename: "apps/web/src/components/ThreadCard.tsx",
});

describe("neokod/no-client-authored-server-timestamp", () => {
  stateRule.valid(
    "allows server timestamp omission and explicit local metadata",
    `
      const payload = { threadId };
      const localMetadata = { localObservedAt: new Date().toISOString() };
    `,
  );

  stateRule.valid(
    "allows deterministic conversion of an injected timestamp",
    `const payload = { observedAt: new Date(input.nowMs).toISOString() };`,
  );

  componentRule.valid(
    "allows local component clocks",
    `const optimisticCard = { createdAt: new Date().toISOString() };`,
  );

  stateRule.invalid(
    "reports ambient ISO timestamps in server payload modules",
    `const payload = { createdAt: new Date().toISOString() };`,
    (output) => {
      assert.match(output, /Do not author server-owned timestamps/);
    },
  );

  stateRule.invalid(
    "reports Date.now for server timestamp fields",
    `const payload = { updatedAt: Date.now() };`,
  );

  stateRule.invalid(
    "reports ambient Date.now wrapped in Date construction",
    `const payload = { completedAt: new Date(Date.now()).toISOString() };`,
  );
});
