import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ProviderDriverKind, ProviderInstanceId, ProviderInstanceRef } from "@neokod/contracts";

import { resolveEffectiveConfig, WORKFLOW_DEFAULTS } from "./Config.ts";

const providerResolver = (_model?: string): ProviderInstanceRef =>
  ProviderInstanceRef.make({
    instanceId: ProviderInstanceId.make("codex_default"),
    driver: ProviderDriverKind.make("codex"),
  });

const resolve = (
  config: Record<string, unknown>,
  options?: { readonly env?: Record<string, string>; readonly dir?: string },
) =>
  resolveEffectiveConfig(config, {
    workflowDir: options?.dir ?? "/repo",
    repositoryPath: "/repo",
    workflowPath: "/repo/WORKFLOW.md",
    readEnv: (name) => options?.env?.[name],
    providerResolver,
  }).pipe(Effect.runSync);

describe("resolveEnvIndirection / resolveEffectiveConfig", () => {
  it("applies defaults for empty config", () => {
    const { config, errors } = resolve({});
    expect(errors.length).toBeGreaterThan(0); // active_states + tracker.kind required
    expect(config).toBeNull();
  });

  it("resolves a minimal valid config", () => {
    const { config, errors } = resolve({
      tracker: { kind: "github", active_states: ["Ready"], terminal_states: ["Done"] },
    });
    expect(errors).toEqual([]);
    expect(config).not.toBeNull();
    expect(config?.trackerKind).toBe("github");
    expect(config?.pollIntervalMs).toBe(WORKFLOW_DEFAULTS.pollIntervalMs);
    expect(config?.autonomy).toBe("execute");
    expect(config?.maxConcurrentAgents).toBe(WORKFLOW_DEFAULTS.maxConcurrentAgents);
    expect(config?.codexCommand).toBe("codex app-server");
  });

  it("YAML values take precedence over environment for non-indirected keys", () => {
    const { config, errors } = resolve(
      {
        tracker: { kind: "github", active_states: ["Ready"], terminal_states: ["Done"] },
        agent: { max_turns: 5 },
      },
      { env: { MAX_TURNS: "99" } },
    );
    expect(errors).toEqual([]);
    expect(config?.maxTurns).toBe(5);
  });

  it("resolves $VAR indirection only where explicitly referenced", () => {
    const { config } = resolve(
      {
        tracker: { kind: "github", active_states: ["Ready"], terminal_states: ["Done"] },
        workspace: { root: "$SYMPHONY_WORKSPACES" },
        agent: { max_turns: 5 },
      },
      { env: { SYMPHONY_WORKSPACES: "/var/ws" } },
    );
    expect(config?.workspaceRoot).toBe("/var/ws");
  });

  it("treats a missing referenced variable as unresolvable", () => {
    const { config } = resolve({
      tracker: { kind: "github", active_states: ["Ready"], terminal_states: ["Done"] },
      workspace: { root: "$MISSING_VAR" },
    });
    expect(config?.workspaceRoot).toBe("$MISSING_VAR");
  });

  it("expands ~ and resolves relative roots against the workflow directory", () => {
    const { config } = resolve(
      {
        tracker: { kind: "github", active_states: ["Ready"], terminal_states: ["Done"] },
        workspace: { root: "~/.neokod/workspaces" },
      },
      { env: { HOME: "/home/u" } },
    );
    expect(config?.workspaceRoot).toBe("/home/u/.neokod/workspaces");
  });

  it("validates poll interval bounds", () => {
    const { config, errors } = resolve({
      tracker: { kind: "github", active_states: ["Ready"], terminal_states: ["Done"] },
      polling: { interval_ms: 100 },
    });
    expect(config).toBeNull();
    expect(errors.some((e) => e.field === "polling.interval_ms")).toBe(true);
  });

  it("rejects an unsupported tracker kind", () => {
    const { config, errors } = resolve({
      tracker: { kind: "not-a-tracker", active_states: ["Active"], terminal_states: ["Done"] },
    });
    expect(config).toBeNull();
    expect(errors.some((e) => e.field === "tracker.kind")).toBe(true);
  });

  it("leaves unrelated environment variables alone", () => {
    const { config } = resolve(
      {
        tracker: { kind: "github", active_states: ["Ready"], terminal_states: ["Done"] },
      },
      { env: { FOO: "bar", HOME: "/home/u" } },
    );
    expect(config).not.toBeNull();
  });

  it("parses approval policy classes", () => {
    const { config, errors } = resolve({
      tracker: { kind: "github", active_states: ["Ready"], terminal_states: ["Done"] },
      approvals: {
        policies: [{ action: "merge", mode: "human", scope: "repository" }],
      },
    });
    expect(errors).toEqual([]);
    expect(config?.approvalsPolicies).toEqual([
      { action: "merge", mode: "human", scope: "repository" },
    ]);
  });

  it("coerces validation commands", () => {
    const { config } = resolve({
      tracker: { kind: "github", active_states: ["Ready"], terminal_states: ["Done"] },
      validation: { required: ["npm run typecheck", "npm test"] },
    });
    expect(config?.validationRequired).toEqual(["npm run typecheck", "npm test"]);
  });

  it("resolves liveRequests.wait_timeout_ms as the canonical live-request bound", () => {
    const { config, errors } = resolve({
      tracker: { kind: "github", active_states: ["Ready"], terminal_states: ["Done"] },
      liveRequests: { wait_timeout_ms: 900_000 },
    });
    expect(errors).toEqual([]);
    expect(config?.liveRequestsWaitTimeoutMs).toBe(900_000);
  });

  it("falls back to the legacy approvals.wait_timeout_ms key", () => {
    const { config, errors } = resolve({
      tracker: { kind: "github", active_states: ["Ready"], terminal_states: ["Done"] },
      approvals: { wait_timeout_ms: 7_200_000 },
    });
    expect(errors).toEqual([]);
    expect(config?.liveRequestsWaitTimeoutMs).toBe(7_200_000);
  });

  it("defaults liveRequestsWaitTimeoutMs when neither key is set", () => {
    const { config, errors } = resolve({
      tracker: { kind: "github", active_states: ["Ready"], terminal_states: ["Done"] },
    });
    expect(errors).toEqual([]);
    expect(config?.liveRequestsWaitTimeoutMs).toBe(WORKFLOW_DEFAULTS.liveRequestsWaitTimeoutMs);
  });

  it("defaults model review to an empty advisory set", () => {
    const { config, errors } = resolve({
      tracker: { kind: "github", active_states: ["Ready"], terminal_states: ["Done"] },
    });
    expect(errors).toEqual([]);
    expect(config?.reviewAgents).toEqual([]);
    expect(config?.reviewRequirement).toBe("advisory");
  });

  it("parses per-role reviewer models and an all-approve gate", () => {
    const { config, errors } = resolve({
      tracker: { kind: "github", active_states: ["Ready"], terminal_states: ["Done"] },
      agent: { model: "gpt-5.6-luna" },
      review: {
        agents: ["gpt-5.6-sol", "claude-fable-5"],
        require: "all-approve",
      },
    });
    expect(errors).toEqual([]);
    expect(config?.agentModel).toBe("gpt-5.6-luna");
    expect(config?.reviewAgents).toEqual(["gpt-5.6-sol", "claude-fable-5"]);
    expect(config?.reviewRequirement).toBe("all-approve");
  });

  it("rejects malformed, empty, and duplicate reviewer model entries", () => {
    const malformed = resolve({
      tracker: { kind: "github", active_states: ["Ready"], terminal_states: ["Done"] },
      review: { agents: "gpt-5.6-sol" },
    });
    expect(malformed.config).toBeNull();
    expect(malformed.errors.some((error) => error.field === "review.agents")).toBe(true);

    const invalidEntries = resolve({
      tracker: { kind: "github", active_states: ["Ready"], terminal_states: ["Done"] },
      review: { agents: ["gpt-5.6-sol", " ", "gpt-5.6-sol"] },
    });
    expect(invalidEntries.config).toBeNull();
    expect(invalidEntries.errors.map((error) => error.field)).toEqual([
      "review.agents.1",
      "review.agents.2",
    ]);
  });

  it("rejects unsupported or unsatisfiable reviewer gate policies", () => {
    const unsupported = resolve({
      tracker: { kind: "github", active_states: ["Ready"], terminal_states: ["Done"] },
      review: { agents: ["gpt-5.6-sol"], require: "majority" },
    });
    expect(unsupported.config).toBeNull();
    expect(unsupported.errors.some((error) => error.field === "review.require")).toBe(true);

    const noReviewers = resolve({
      tracker: { kind: "github", active_states: ["Ready"], terminal_states: ["Done"] },
      review: { require: "any-approve" },
    });
    expect(noReviewers.config).toBeNull();
    expect(noReviewers.errors.some((error) => error.field === "review.agents")).toBe(true);
  });
});
