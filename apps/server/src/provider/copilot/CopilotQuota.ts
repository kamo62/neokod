import type { CopilotClient } from "@github/copilot-sdk";
import { ServerProviderUsage, type ServerProviderUsageWindow } from "@neokod/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

type AccountQuotaSnapshot = {
  readonly isUnlimitedEntitlement: boolean;
  readonly entitlementRequests: number;
  readonly usedRequests: number;
  readonly remainingPercentage: number;
  readonly overage: number;
  readonly resetDate?: string | undefined;
};

const KNOWN_BUCKET_ORDER = ["premium_interactions", "chat", "completions"] as const;

function bucketOrder(bucketId: string): number {
  const knownIndex = KNOWN_BUCKET_ORDER.indexOf(bucketId as (typeof KNOWN_BUCKET_ORDER)[number]);
  return knownIndex === -1 ? Number.POSITIVE_INFINITY : knownIndex;
}

export function mapCopilotQuotaSnapshot(
  bucketId: string,
  snapshot: AccountQuotaSnapshot,
): ServerProviderUsageWindow {
  const unlimited = snapshot.isUnlimitedEntitlement || snapshot.entitlementRequests < 0;
  const resetDate = snapshot.resetDate?.trim();

  return {
    bucketId: bucketId.trim(),
    used: snapshot.usedRequests,
    entitlement: unlimited ? null : snapshot.entitlementRequests,
    remainingPercentage: snapshot.remainingPercentage,
    ...(resetDate ? { resetDate } : {}),
    unlimited,
    overage: snapshot.overage,
  };
}

export function mapCopilotQuotaSnapshots(
  snapshots: Readonly<Record<string, AccountQuotaSnapshot | undefined>>,
): ServerProviderUsage | undefined {
  const entries = Object.entries(snapshots)
    .flatMap(([bucketId, snapshot]) =>
      snapshot === undefined ? [] : [{ bucketId: bucketId.trim(), snapshot }],
    )
    .filter((entry) => entry.bucketId.length > 0);

  entries.sort((left, right) => {
    const leftOrder = bucketOrder(left.bucketId);
    const rightOrder = bucketOrder(right.bucketId);
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return left.bucketId < right.bucketId ? -1 : left.bucketId > right.bucketId ? 1 : 0;
  });

  const windows = entries.map((entry) => mapCopilotQuotaSnapshot(entry.bucketId, entry.snapshot));
  return windows.length > 0 ? { windows } : undefined;
}

const decodeServerProviderUsage = Schema.decodeUnknownEffect(ServerProviderUsage);

export function getCopilotQuota(
  client: Pick<CopilotClient, "rpc">,
  gitHubToken?: string,
): Effect.Effect<ServerProviderUsage | undefined, never> {
  return Effect.tryPromise(() =>
    client.rpc.account
      .getQuota(gitHubToken ? { gitHubToken } : {})
      .then((result) => mapCopilotQuotaSnapshots(result.quotaSnapshots)),
  ).pipe(
    // Re-validate through the wire schema so malformed runtime values
    // (negative or fractional counts) degrade to `undefined` instead of
    // poisoning the provider snapshot encode/decode downstream.
    Effect.flatMap((usage) =>
      usage === undefined ? Effect.succeed(undefined) : decodeServerProviderUsage(usage),
    ),
    Effect.orElseSucceed(() => undefined),
  );
}
