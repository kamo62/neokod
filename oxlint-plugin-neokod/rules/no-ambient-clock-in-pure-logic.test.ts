import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const pureLogicRule = createOxlintRuleHarness("neokod/no-ambient-clock-in-pure-logic", {
  filename: "apps/web/src/components/example.logic.ts",
});

const componentRule = createOxlintRuleHarness("neokod/no-ambient-clock-in-pure-logic", {
  filename: "apps/web/src/components/Example.tsx",
});

describe("neokod/no-ambient-clock-in-pure-logic", () => {
  pureLogicRule.valid(
    "allows injected clocks and deterministic date conversion",
    `
      export const elapsed = (startedAt: string, nowMs: number) =>
        new Date(nowMs).getTime() - new Date(startedAt).getTime();
    `,
  );

  componentRule.valid(
    "allows component boundary clocks",
    `
      export const captureNow = () => Date.now();
      export const captureIso = () => new Date().toISOString();
    `,
  );

  pureLogicRule.invalid(
    "reports Date.now in pure logic",
    `export const captureNow = () => Date.now();`,
    (output) => {
      assert.match(output, /Inject the current time/);
    },
  );

  pureLogicRule.invalid(
    "reports zero-argument Date construction in pure logic",
    `export const captureIso = () => new Date().toISOString();`,
  );

  pureLogicRule.invalid(
    "reports performance.now in pure logic",
    `export const captureHighResolutionNow = () => performance.now();`,
  );
});
