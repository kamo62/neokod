import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderLimit,
} from "@neokod/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyClaudeLimit,
  claudeResultFailure,
  describeClaudeCliResultFailure,
  latestRejectedResetSeconds,
  providerLimitFromRejected,
  updateRejectedRateLimits,
  type RejectedRateLimits,
} from "./ClaudeUsageLimit.ts";

const baseProvider = (overrides: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId: ProviderInstanceId.make("claudeAgent"),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated", label: "Claude Pro Subscription" },
  checkedAt: "2026-10-04T20:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

const limit = (overrides: Partial<ServerProviderLimit> = {}): ServerProviderLimit => ({
  kind: "usage_limit",
  observedAt: "2026-10-04T20:00:00.000Z",
  ...overrides,
});

describe("claudeResultFailure", () => {
  it("returns undefined for a completed successful result", () => {
    expect(
      claudeResultFailure({ subtype: "success", is_error: false, terminal_reason: "completed" }),
    ).toBeUndefined();
  });

  it("keeps the CLI usage-limit text and derives the reset from the rate-limit event", () => {
    const failure = claudeResultFailure(
      {
        subtype: "success",
        is_error: true,
        api_error_status: 429,
        terminal_reason: "api_error",
        result: "You've hit your session limit · resets 10:30pm (Africa/Johannesburg)",
      },
      { resetsAtEpochSeconds: 1791145800 },
    );

    expect(failure).toEqual({
      kind: "usage_limit",
      message: "You've hit your session limit · resets 10:30pm (Africa/Johannesburg)",
      resetsAt: "2026-10-04T20:30:00.000Z",
      apiErrorStatus: 429,
      terminalReason: "api_error",
    });
  });

  it("appends the reset to a limit message that does not name it", () => {
    const failure = claudeResultFailure(
      {
        subtype: "success",
        is_error: true,
        api_error_status: 429,
        result: "Rate limited",
      },
      { resetsAtEpochSeconds: 1791145800 },
    );

    expect(failure?.message).toBe("Rate limited Resets 2026-10-04 20:30 UTC.");
  });

  it("does not invent a reset from a generic 429 result", () => {
    const failure = claudeResultFailure({
      subtype: "success",
      is_error: true,
      api_error_status: 429,
      result: "Rate limited",
    });

    expect(failure?.kind).toBe("usage_limit");
    expect(failure?.resetsAt).toBeUndefined();
  });

  it("classifies a 401 as authentication failure", () => {
    expect(
      claudeResultFailure({
        subtype: "success",
        is_error: true,
        api_error_status: 401,
        result: "OAuth token has expired",
      }),
    ).toMatchObject({
      kind: "auth",
      message: "OAuth token has expired",
      apiErrorStatus: 401,
    });
  });

  it("classifies a 529 as overloaded", () => {
    expect(
      claudeResultFailure({ subtype: "success", is_error: true, api_error_status: 529 }),
    ).toMatchObject({
      kind: "overloaded",
      message: "Claude is overloaded (529). Try again shortly.",
      apiErrorStatus: 529,
    });
  });

  it("treats an explicit abort as no failure", () => {
    expect(
      claudeResultFailure({
        subtype: "success",
        is_error: true,
        terminal_reason: "aborted_tools",
      }),
    ).toBeUndefined();
  });

  it("treats blocking_limit as a usage limit even without is_error", () => {
    expect(
      claudeResultFailure({
        subtype: "success",
        is_error: false,
        terminal_reason: "blocking_limit",
      }),
    ).toMatchObject({
      kind: "usage_limit",
      message: "Claude usage limit reached.",
      terminalReason: "blocking_limit",
    });
  });

  it("uses the assistant error text ahead of the result text", () => {
    expect(
      claudeResultFailure(
        {
          subtype: "success",
          is_error: true,
          api_error_status: 429,
          result: "fallback",
        },
        { assistantError: { code: "rate_limit", text: "five hour limit reached" } },
      ),
    ).toMatchObject({
      kind: "usage_limit",
      message: "five hour limit reached",
    });
  });

  it("classifies an authentication assistant error without an HTTP status", () => {
    expect(
      claudeResultFailure(
        { subtype: "success", is_error: true, terminal_reason: "api_error" },
        { assistantError: { code: "authentication_failed", text: undefined } },
      ),
    ).toMatchObject({
      kind: "auth",
      message: "Claude authentication failed. Sign in again with the Claude CLI.",
    });
  });

  it("keeps non-success result subtypes on the existing path", () => {
    expect(
      claudeResultFailure({ subtype: "error_during_execution", is_error: true }),
    ).toBeUndefined();
  });
});

describe("describeClaudeCliResultFailure", () => {
  it("returns the failure message for a JSON result envelope", () => {
    expect(
      describeClaudeCliResultFailure(
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: true,
          api_error_status: 429,
          terminal_reason: "api_error",
          result: "You've hit your session limit · resets 10:30pm (Africa/Johannesburg)",
        }),
      ),
    ).toBe("You've hit your session limit · resets 10:30pm (Africa/Johannesburg)");
  });

  it("ignores non-JSON output and non-result envelopes", () => {
    expect(describeClaudeCliResultFailure("not json")).toBeUndefined();
    expect(
      describeClaudeCliResultFailure(
        JSON.stringify({ structured_output: { subject: "Add a thing" } }),
      ),
    ).toBeUndefined();
  });
});

describe("rejected rate limits", () => {
  it("tracks and clears each rate-limit window independently", () => {
    let rejected: RejectedRateLimits = new Map();
    rejected = updateRejectedRateLimits(rejected, {
      status: "rejected",
      rateLimitType: "five_hour",
      resetsAt: 1791145800,
    });
    rejected = updateRejectedRateLimits(rejected, {
      status: "rejected",
      rateLimitType: "seven_day",
      resetsAt: 1793737800,
    });
    rejected = updateRejectedRateLimits(rejected, {
      status: "allowed",
      rateLimitType: "five_hour",
    });

    expect([...rejected]).toEqual([["seven_day", 1793737800]]);
  });

  it("uses the latest reset that is still in the future", () => {
    const rejected: RejectedRateLimits = new Map([
      ["five_hour", 2000],
      ["seven_day", 3000],
      ["stale", 1000],
    ]);

    expect(latestRejectedResetSeconds(rejected, 1500)).toBe(3000);
    expect(latestRejectedResetSeconds(rejected, 2500)).toBe(3000);
    expect(latestRejectedResetSeconds(rejected, 3500)).toBeUndefined();
  });

  it("builds a provider limit from rejected windows", () => {
    const rejected: RejectedRateLimits = new Map([
      ["five_hour", 2000],
      ["seven_day", 3000],
    ]);

    expect(providerLimitFromRejected(rejected, 1500 * 1000)).toEqual({
      kind: "usage_limit",
      window: "seven_day",
      resetsAt: "1970-01-01T00:50:00.000Z",
      observedAt: "1970-01-01T00:25:00.000Z",
    });
  });

  it("keeps a rejected window with an unknown reset but does not invent one", () => {
    const rejected: RejectedRateLimits = new Map([["five_hour", undefined]]);

    expect(providerLimitFromRejected(rejected, 1500 * 1000)).toEqual({
      kind: "usage_limit",
      window: "five_hour",
      observedAt: "1970-01-01T00:25:00.000Z",
    });
  });

  it("returns null once every rejected reset is in the past", () => {
    const rejected: RejectedRateLimits = new Map([["five_hour", 1000]]);

    expect(providerLimitFromRejected(rejected, 1500 * 1000)).toBeNull();
  });
});

describe("applyClaudeLimit", () => {
  const nowMs = 1791144000 * 1000;

  it("marks a ready provider as a warning with the reset time", () => {
    const snapshot = baseProvider();
    const applied = applyClaudeLimit(
      snapshot,
      limit({ resetsAt: "2026-10-04T20:30:00.000Z" }),
      nowMs,
    );

    expect(applied.status).toBe("warning");
    expect(applied.message).toBe("Usage limit reached. Resets 2026-10-04 20:30 UTC.");
    expect(applied.limit).toEqual(limit({ resetsAt: "2026-10-04T20:30:00.000Z" }));
    expect(applied.auth).toEqual(snapshot.auth);
  });

  it("keeps a non-ready status and appends the server message", () => {
    const applied = applyClaudeLimit(
      baseProvider({ status: "error", message: "Probe failed." }),
      limit({ resetsAt: "2026-10-04T20:30:00.000Z" }),
      nowMs,
    );

    expect(applied.status).toBe("error");
    expect(applied.message).toBe("Usage limit reached. Resets 2026-10-04 20:30 UTC. Probe failed.");
  });

  it("returns the identical snapshot when there is no limit", () => {
    const snapshot = baseProvider();

    expect(applyClaudeLimit(snapshot, null, nowMs)).toBe(snapshot);
    expect(applyClaudeLimit(snapshot, undefined, nowMs)).toBe(snapshot);
  });

  it("returns the identical snapshot when the limit already expired", () => {
    const snapshot = baseProvider();

    expect(applyClaudeLimit(snapshot, limit({ resetsAt: "2026-10-04T20:00:00.000Z" }), nowMs)).toBe(
      snapshot,
    );
  });
});
