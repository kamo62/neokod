/**
 * providerStopOutcome - Shared constructors for the canonical `ProviderStopOutcome`.
 *
 * Centralizes the mapping from an adapter's teardown result to the structured
 * stop contract defined in `packages/contracts/src/providerRuntime.ts`
 * (Issue #101, spec section 6.2). Adapters must never overclaim descendant stop
 * certainty: `stopped_confirmed` is only correct when the foreground turn has
 * settled AND the neokod-owned process tree is torn down with no unobservable
 * descendants (the case for the six process/SDK providers, which own a single
 * child and reap its tree on teardown). Where confirmation is unavailable an
 * adapter must return `orphan_possible` or `stop_failed` instead.
 *
 * @module providerStopOutcome
 */
import { ProviderStopOutcome } from "@neokod/contracts";
import type { ProviderStopFailedReason, ProviderStopReason } from "@neokod/contracts";
import * as Schema from "effect/Schema";

const isProviderStopOutcome = Schema.is(ProviderStopOutcome);

/**
 * Read the persisted stop outcome from a binding's runtime payload.
 * A malformed or absent value means "no stop evidence", not a stopped session.
 */
export function readPersistedStopOutcome(runtimePayload: unknown): ProviderStopOutcome | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const rawOutcome = "stopOutcome" in runtimePayload ? runtimePayload.stopOutcome : undefined;
  return isProviderStopOutcome(rawOutcome) ? rawOutcome : undefined;
}

/**
 * A `host_lost` orphan observation means the previous server process vanished.
 * It is not a locally owned stop operation: there is no teardown to complete,
 * and it must not fence the thread against a later explicit session or turn.
 */
export function isHostLostStopOutcome(
  outcome: ProviderStopOutcome | undefined,
): outcome is Extract<ProviderStopOutcome, { readonly status: "orphan_possible" }> {
  return outcome?.status === "orphan_possible" && outcome.reason === "host_lost";
}

/**
 * Confirmed stop: foreground settled and the owned process tree was torn down.
 * Valid only for providers with no unobservable/detached descendant model.
 */
export function stoppedConfirmed(stoppedAt: string): ProviderStopOutcome {
  return { status: "stopped_confirmed", stoppedAt };
}

/**
 * Uncertain stop: the neokod-owned side settled but descendants could not be
 * proven stopped. Reserve for cooperative-cancel-only paths and detached-work
 * providers (e.g. future Kiro Crew).
 */
export function orphanPossible(input: {
  readonly stoppedAt: string;
  readonly reason: ProviderStopReason;
  readonly providerSessionId?: string;
  readonly knownExternalRunIds?: ReadonlyArray<string>;
}): ProviderStopOutcome {
  return {
    status: "orphan_possible",
    stoppedAt: input.stoppedAt,
    reason: input.reason,
    ...(input.providerSessionId === undefined
      ? {}
      : { providerSessionId: input.providerSessionId }),
    knownExternalRunIds: input.knownExternalRunIds ?? [],
  };
}

/**
 * Hard failure of the stop operation itself (not "work may continue").
 */
export function stopFailed(reason: ProviderStopFailedReason, detail?: string): ProviderStopOutcome {
  return {
    status: "stop_failed",
    reason,
    ...(detail === undefined ? {} : { detail }),
  };
}
