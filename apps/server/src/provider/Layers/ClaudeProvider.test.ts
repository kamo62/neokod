import { assert, describe, it } from "@effect/vitest";

import {
  DEFAULT_CLAUDE_CAPABILITIES_PROBE_TIMEOUT_MS,
  DEFAULT_CLAUDE_VERSION_PROBE_TIMEOUT_MS,
  getClaudeModelCapabilities,
  parseClaudeProbeTimeoutMs,
  parseClaudeSupportedModels,
} from "./ClaudeProvider.ts";

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

describe("parseClaudeProbeTimeoutMs", () => {
  it("uses the per-probe default when the operator sets nothing", () => {
    assert.strictEqual(
      parseClaudeProbeTimeoutMs(undefined, DEFAULT_CLAUDE_VERSION_PROBE_TIMEOUT_MS),
      DEFAULT_CLAUDE_VERSION_PROBE_TIMEOUT_MS,
    );
    assert.strictEqual(
      parseClaudeProbeTimeoutMs(undefined, DEFAULT_CLAUDE_CAPABILITIES_PROBE_TIMEOUT_MS),
      DEFAULT_CLAUDE_CAPABILITIES_PROBE_TIMEOUT_MS,
    );
  });

  it("accepts a positive integer and tolerates surrounding whitespace", () => {
    assert.strictEqual(parseClaudeProbeTimeoutMs("60000", 15_000), 60_000);
    assert.strictEqual(parseClaudeProbeTimeoutMs("  60000  ", 15_000), 60_000);
  });

  it("raises both probe budgets when the override exceeds both defaults", () => {
    // The env var is a single knob; a value above both defaults lifts both.
    assert.strictEqual(
      parseClaudeProbeTimeoutMs("90000", DEFAULT_CLAUDE_VERSION_PROBE_TIMEOUT_MS),
      90_000,
    );
    assert.strictEqual(
      parseClaudeProbeTimeoutMs("90000", DEFAULT_CLAUDE_CAPABILITIES_PROBE_TIMEOUT_MS),
      90_000,
    );
  });

  it("never lowers a budget below its default", () => {
    // A value between the two defaults, such as 20s, must raise the 15s
    // version budget without cutting the 25s capabilities budget that
    // Bedrock initialization needs. The override is a floor, not a
    // replacement.
    assert.strictEqual(
      parseClaudeProbeTimeoutMs("20000", DEFAULT_CLAUDE_VERSION_PROBE_TIMEOUT_MS),
      20_000,
    );
    assert.strictEqual(
      parseClaudeProbeTimeoutMs("20000", DEFAULT_CLAUDE_CAPABILITIES_PROBE_TIMEOUT_MS),
      DEFAULT_CLAUDE_CAPABILITIES_PROBE_TIMEOUT_MS,
    );
  });

  it("ignores values that would make every probe fail immediately", () => {
    // A zero or negative budget expires before the CLI can spawn, so falling
    // back beats honouring it.
    for (const raw of ["0", "-1", "-60000"]) {
      assert.strictEqual(parseClaudeProbeTimeoutMs(raw, 15_000), 15_000);
    }
  });

  it("ignores values that are not safe integers", () => {
    for (const raw of ["", "   ", "abc", "15s", "1.5", "1e999", "9007199254740993"]) {
      assert.strictEqual(parseClaudeProbeTimeoutMs(raw, 15_000), 15_000);
    }
  });
});
