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
import type {
  ProviderStopFailedReason,
  ProviderStopOutcome,
  ProviderStopReason,
} from "@neokod/contracts";

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
