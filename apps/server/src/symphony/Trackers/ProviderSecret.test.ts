import { expect, it } from "@effect/vitest";

import { resolveProviderSecret } from "./ProviderSecret.ts";

it("resolves literals, explicit variables, and the documented fallback", () => {
  expect(resolveProviderSecret("literal", "DEFAULT_TOKEN", {})).toEqual({
    resolved: "literal",
    envName: undefined,
  });
  expect(
    resolveProviderSecret("$EXPLICIT_TOKEN", "DEFAULT_TOKEN", { EXPLICIT_TOKEN: "one" }),
  ).toEqual({
    resolved: "one",
    envName: "EXPLICIT_TOKEN",
  });
  expect(resolveProviderSecret(undefined, "DEFAULT_TOKEN", { DEFAULT_TOKEN: "two" })).toEqual({
    resolved: "two",
    envName: "DEFAULT_TOKEN",
  });
  expect(
    resolveProviderSecret("$MISSING_TOKEN", "DEFAULT_TOKEN", { DEFAULT_TOKEN: "ignored" }),
  ).toEqual({
    resolved: undefined,
    envName: "MISSING_TOKEN",
  });
});
