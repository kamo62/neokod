import { assert, it } from "@effect/vitest";

import { getClaudeModelCapabilities, parseClaudeSupportedModels } from "./ClaudeProvider.ts";

it("keeps the statically described capabilities for a known discovered slug", () => {
  const models = parseClaudeSupportedModels([
    { value: "claude-haiku-4-5", displayName: "Claude Haiku 4.5" },
  ]);

  assert.strictEqual(models.length, 1);
  assert.strictEqual(models[0]?.slug, "claude-haiku-4-5");
  // Discovery must not narrow an existing model's options. Haiku's Thinking
  // toggle is not expressible in the SDK payload, so it can only survive by
  // reusing the same lookup the adapter uses at execution time.
  assert.deepStrictEqual(models[0]?.capabilities, getClaudeModelCapabilities("claude-haiku-4-5"));
  assert.strictEqual(
    models[0]?.capabilities?.optionDescriptors?.some((descriptor) => descriptor.id === "thinking"),
    true,
  );
});

it("gives an unknown discovered slug default capabilities rather than invented ones", () => {
  const models = parseClaudeSupportedModels([
    { value: "claude-future-9", displayName: "Claude Future 9" },
  ]);

  assert.strictEqual(models[0]?.slug, "claude-future-9");
  assert.strictEqual(models[0]?.name, "Claude Future 9");
  // The picker must not offer options the execution path would silently drop.
  assert.deepStrictEqual(models[0]?.capabilities?.optionDescriptors ?? [], []);
});

it("falls back to the slug when no usable display name is reported", () => {
  const models = parseClaudeSupportedModels([
    { value: "claude-future-9" },
    { value: "claude-future-8", displayName: "   " },
  ]);

  assert.deepStrictEqual(
    models.map((model) => model.name),
    ["claude-future-9", "claude-future-8"],
  );
});

it("skips malformed entries instead of throwing or emitting junk models", () => {
  const models = parseClaudeSupportedModels([
    null,
    undefined,
    "claude-not-an-object",
    42,
    {},
    { value: "" },
    { value: "   " },
    { value: 7 },
    { value: "claude-real-1" },
  ]);

  assert.deepStrictEqual(
    models.map((model) => model.slug),
    ["claude-real-1"],
  );
});

it("collapses duplicate slugs to the first occurrence", () => {
  const models = parseClaudeSupportedModels([
    { value: "claude-dupe", displayName: "First" },
    { value: "claude-dupe", displayName: "Second" },
  ]);

  assert.strictEqual(models.length, 1);
  assert.strictEqual(models[0]?.name, "First");
});

it("returns an empty list for missing or empty input", () => {
  assert.deepStrictEqual(parseClaudeSupportedModels(undefined), []);
  assert.deepStrictEqual(parseClaudeSupportedModels([]), []);
});
