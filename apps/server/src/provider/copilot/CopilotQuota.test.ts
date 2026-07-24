import * as NodeAssert from "node:assert/strict";
import { it } from "@effect/vitest";
import type { CopilotClient } from "@github/copilot-sdk";
import * as Effect from "effect/Effect";
import { describe } from "vite-plus/test";

import {
  getCopilotQuota,
  mapCopilotQuotaSnapshot,
  mapCopilotQuotaSnapshots,
} from "./CopilotQuota.ts";

type Snapshot = Parameters<typeof mapCopilotQuotaSnapshot>[1];

const makeSnapshot = (overrides: Partial<Snapshot> = {}): Snapshot => ({
  isUnlimitedEntitlement: false,
  entitlementRequests: 100,
  usedRequests: 12,
  remainingPercentage: 88,
  overage: 0,
  ...overrides,
});

const makeClient = (
  getQuota: (params: { readonly gitHubToken?: string }) => Promise<unknown>,
): Pick<CopilotClient, "rpc"> =>
  ({ rpc: { account: { getQuota } } }) as unknown as Pick<CopilotClient, "rpc">;

describe("CopilotQuota", () => {
  it("maps -1 entitlement as unlimited without exposing the sentinel", () => {
    NodeAssert.deepEqual(
      mapCopilotQuotaSnapshot("premium_interactions", makeSnapshot({ entitlementRequests: -1 })),
      {
        bucketId: "premium_interactions",
        used: 12,
        entitlement: null,
        remainingPercentage: 88,
        unlimited: true,
        overage: 0,
      },
    );
  });

  it("defensively treats any negative entitlement as unlimited", () => {
    const window = mapCopilotQuotaSnapshot(
      "chat",
      makeSnapshot({ isUnlimitedEntitlement: false, entitlementRequests: -3 }),
    );

    NodeAssert.equal(window.unlimited, true);
    NodeAssert.equal(window.entitlement, null);
  });

  it("preserves exhausted usage and overage values", () => {
    const window = mapCopilotQuotaSnapshot(
      "completions",
      makeSnapshot({ usedRequests: 101, remainingPercentage: 0, overage: 7 }),
    );

    NodeAssert.equal(window.used, 101);
    NodeAssert.equal(window.remainingPercentage, 0);
    NodeAssert.equal(window.overage, 7);
  });

  it("omits a missing or blank reset date", () => {
    NodeAssert.equal("resetDate" in mapCopilotQuotaSnapshot("chat", makeSnapshot()), false);
    NodeAssert.equal(
      "resetDate" in mapCopilotQuotaSnapshot("chat", makeSnapshot({ resetDate: "   " })),
      false,
    );
  });

  it("retains all buckets in deterministic order without synthesizing missing buckets", () => {
    const usage = mapCopilotQuotaSnapshots({
      unknown_z: makeSnapshot(),
      premium_interactions: makeSnapshot(),
      completions: makeSnapshot(),
      chat: makeSnapshot(),
      unknown_a: makeSnapshot(),
    });

    NodeAssert.deepEqual(
      usage?.windows.map((window) => window.bucketId),
      ["premium_interactions", "chat", "completions", "unknown_a", "unknown_z"],
    );
    NodeAssert.equal(
      mapCopilotQuotaSnapshots({ chat: makeSnapshot() })?.windows.some(
        (window) => window.bucketId === "premium_interactions",
      ),
      false,
    );
  });

  it("returns undefined for empty or unusable snapshots", () => {
    NodeAssert.equal(mapCopilotQuotaSnapshots({}), undefined);
    NodeAssert.equal(
      mapCopilotQuotaSnapshots({ chat: undefined, "  ": makeSnapshot() }),
      undefined,
    );
  });

  it.effect("forwards the token and swallows RPC failures", () =>
    Effect.gen(function* () {
      let receivedToken: string | undefined;
      const client = makeClient(async (params) => {
        receivedToken = params.gitHubToken;
        throw new Error("quota unavailable");
      });

      const usage = yield* getCopilotQuota(client, "ghp_secret");

      NodeAssert.equal(receivedToken, "ghp_secret");
      NodeAssert.equal(usage, undefined);
    }),
  );

  it.effect("returns decoded usage for a valid quota result", () =>
    Effect.gen(function* () {
      const client = makeClient(async () => ({
        quotaSnapshots: {
          premium_interactions: makeSnapshot({ usedRequests: 40, remainingPercentage: 60 }),
        },
      }));

      const usage = yield* getCopilotQuota(client);

      NodeAssert.equal(usage?.windows.length, 1);
      NodeAssert.equal(usage?.windows[0]?.bucketId, "premium_interactions");
      NodeAssert.equal(usage?.windows[0]?.used, 40);
    }),
  );

  it.effect("degrades to undefined when the SDK reports a negative count", () =>
    Effect.gen(function* () {
      const client = makeClient(async () => ({
        quotaSnapshots: { premium_interactions: makeSnapshot({ usedRequests: -5 }) },
      }));

      NodeAssert.equal(yield* getCopilotQuota(client), undefined);
    }),
  );

  it.effect("degrades to undefined when the SDK reports a fractional count", () =>
    Effect.gen(function* () {
      const client = makeClient(async () => ({
        quotaSnapshots: { chat: makeSnapshot({ usedRequests: 1.5 }) },
      }));

      NodeAssert.equal(yield* getCopilotQuota(client), undefined);
    }),
  );
});
