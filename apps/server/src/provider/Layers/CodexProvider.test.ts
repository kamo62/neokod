import { assert, describe, it } from "@effect/vitest";

import {
  codexVersionWarning,
  DEFAULT_CODEX_PROBE_TIMEOUT_MS,
  isCodexVersionBelowMinimum,
  mapCodexModelCapabilities,
  MINIMUM_SUPPORTED_CODEX_VERSION,
  parseCodexProbeTimeoutMs,
  parseCodexVersion,
} from "./CodexProvider.ts";

it("parses Codex CLI versions from app-server user agents", () => {
  assert.equal(parseCodexVersion("codex-cli/0.145.0"), "0.145.0");
  assert.equal(parseCodexVersion("codex-cli 0.144.1"), "0.144.1");
  assert.equal(parseCodexVersion("unknown"), undefined);
});

it("warns only for Codex versions below the binding target", () => {
  assert.equal(isCodexVersionBelowMinimum("0.144.9"), true);
  assert.equal(isCodexVersionBelowMinimum(MINIMUM_SUPPORTED_CODEX_VERSION), false);
  assert.equal(isCodexVersionBelowMinimum("0.146.0"), false);
  const belowWarning = codexVersionWarning("0.144.9");
  assert.ok(belowWarning !== undefined);
  assert.match(belowWarning, /older than the supported 0\.145\.0/);
  assert.equal(codexVersionWarning("0.146.0"), undefined);
  const unknownWarning = codexVersionWarning(undefined);
  assert.ok(unknownWarning !== undefined);
  assert.match(unknownWarning, /version could not be determined/);
});

it("maps current Codex model capability fields", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "super-high",
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    defaultServiceTier: "flex",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "Lower latency responses.",
      },
      {
        id: "flex",
        name: "Flex",
        description: "Lower-cost asynchronous routing.",
      },
    ],
    supportedReasoningEfforts: [
      {
        description: "Maximum reasoning",
        reasoningEffort: "super-high",
      },
    ],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [{ id: "super-high", label: "super-high", isDefault: true }],
      currentValue: "super-high",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard" },
        {
          id: "priority",
          label: "Fast",
          description: "Lower latency responses.",
        },
        {
          id: "flex",
          label: "Flex",
          description: "Lower-cost asynchronous routing.",
          isDefault: true,
        },
      ],
      currentValue: "flex",
    },
  ]);
});

it("uses standard routing when the catalog has no default service tier", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: ["fast"],
    defaultReasoningEffort: "medium",
    defaultServiceTier: null,
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "1.5x speed, increased usage",
      },
    ],
    supportedReasoningEfforts: [],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        {
          id: "priority",
          label: "Fast",
          description: "1.5x speed, increased usage",
        },
      ],
      currentValue: "default",
    },
  ]);
});

describe("parseCodexProbeTimeoutMs", () => {
  it("uses the default when the operator sets nothing", () => {
    assert.strictEqual(
      parseCodexProbeTimeoutMs(undefined, DEFAULT_CODEX_PROBE_TIMEOUT_MS),
      DEFAULT_CODEX_PROBE_TIMEOUT_MS,
    );
  });

  it("accepts a positive integer and tolerates surrounding whitespace", () => {
    assert.strictEqual(parseCodexProbeTimeoutMs("60000", DEFAULT_CODEX_PROBE_TIMEOUT_MS), 60_000);
    assert.strictEqual(
      parseCodexProbeTimeoutMs("  60000  ", DEFAULT_CODEX_PROBE_TIMEOUT_MS),
      60_000,
    );
  });

  it("never lowers the budget below its default", () => {
    // The override is a floor: a value below the 25s default must not
    // reintroduce the short budget this knob exists to escape.
    assert.strictEqual(
      parseCodexProbeTimeoutMs("10000", DEFAULT_CODEX_PROBE_TIMEOUT_MS),
      DEFAULT_CODEX_PROBE_TIMEOUT_MS,
    );
  });

  it("ignores values that would make every probe fail immediately", () => {
    // A zero or negative budget expires before the app-server can spawn, so
    // falling back beats honouring it.
    for (const raw of ["0", "-1", "-60000"]) {
      assert.strictEqual(
        parseCodexProbeTimeoutMs(raw, DEFAULT_CODEX_PROBE_TIMEOUT_MS),
        DEFAULT_CODEX_PROBE_TIMEOUT_MS,
      );
    }
  });

  it("ignores values that are not safe integers", () => {
    for (const raw of ["", "   ", "abc", "15s", "1.5", "1e999", "9007199254740993"]) {
      assert.strictEqual(
        parseCodexProbeTimeoutMs(raw, DEFAULT_CODEX_PROBE_TIMEOUT_MS),
        DEFAULT_CODEX_PROBE_TIMEOUT_MS,
      );
    }
  });
});
