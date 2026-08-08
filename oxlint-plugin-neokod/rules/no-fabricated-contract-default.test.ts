import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const clientRule = createOxlintRuleHarness("neokod/no-fabricated-contract-default", {
  filename: "apps/web/src/components/Overview.tsx",
});

const serverRule = createOxlintRuleHarness("neokod/no-fabricated-contract-default", {
  filename: "apps/server/src/overview.ts",
});

describe("neokod/no-fabricated-contract-default", () => {
  clientRule.valid(
    "allows preserving unavailable data",
    `
      const overview = overviewQuery.data;
      const state = overview === null ? "unavailable" : "known";
    `,
  );

  clientRule.valid(
    "does not ban list presentation fallbacks",
    `const visibleRows = rowsQuery.data ?? [];`,
  );

  serverRule.valid(
    "does not apply to server implementation details",
    `const overview = overviewQuery.data ?? EMPTY_OVERVIEW;`,
  );

  clientRule.invalid(
    "reports named empty contract sentinels",
    `const overview = overviewQuery.data ?? EMPTY_OVERVIEW;`,
    (output) => {
      assert.match(output, /Preserve missing contract data as unavailable/);
    },
  );

  clientRule.invalid(
    "reports inline object defaults",
    `const overview = overviewQuery.data || { running: 0, queued: 0 };`,
  );
});
