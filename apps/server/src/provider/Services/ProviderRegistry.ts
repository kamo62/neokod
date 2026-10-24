/**
 * ProviderRegistry - Provider snapshot service.
 *
 * Owns provider install/auth/version/model snapshots and exposes the latest
 * provider state to transport layers.
 *
 * @module ProviderRegistry
 */
import type {
  ProviderInstanceId,
  ProviderDriverKind,
  ServerProvider,
  ServerProviderUpdateState,
} from "@neokod/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";
import type { ProviderMaintenanceCapabilities } from "../providerMaintenance.ts";

export type ProviderMaintenanceActionKind = "update";

export interface ProviderRegistryShape {
  /**
   * Read the latest provider snapshots for every configured instance.
   * Multiple snapshots may share the same `provider` kind (multiple
   * instances of the same driver) and disambiguate via `instanceId`.
   */
  readonly getProviders: Effect.Effect<ReadonlyArray<ServerProvider>>;

  /**
   * Refresh all providers, or the default instance of the specified
   * kind when supplied.
   *
   * Retained for back-compat with legacy call sites (WS refresh RPC,
   * orchestration metrics). New code should prefer `refreshInstance`.
   *
   * @deprecated prefer `refreshInstance` for new call sites.
   */
  readonly refresh: (provider?: ProviderDriverKind) => Effect.Effect<ReadonlyArray<ServerProvider>>;

  /**
   * Refresh the specific configured instance. Returns the updated snapshot
   * list. When the instance id is unknown the call resolves with the
   * currently cached list (no error) — matching the legacy `refresh` shim
   * behaviour so transport layers don't have to special-case unknowns.
   */
  readonly refreshInstance: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ReadonlyArray<ServerProvider>>;

  /**
   * Resolve the maintenance capabilities owned by one live provider instance.
   * Falls back to manual-only capabilities when the instance is not live.
   */
  readonly getProviderMaintenanceCapabilitiesForInstance: (
    instanceId: ProviderInstanceId,
    provider: ProviderDriverKind,
  ) => Effect.Effect<ProviderMaintenanceCapabilities>;

  /**
   * Apply volatile maintenance-action state to one configured instance.
   * This state is never persisted to disk. Today only update actions are
   * projected onto `ServerProvider.updateState`; install/auth actions can
   * extend this action map without adding driver-scoped APIs.
   */
  readonly setProviderMaintenanceActionState: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly action: ProviderMaintenanceActionKind;
    readonly state: ServerProviderUpdateState | null;
  }) => Effect.Effect<ReadonlyArray<ServerProvider>>;

  /**
   * Stream of provider snapshot updates — one emission per aggregated
   * change. The array contains the full current state.
   *
   * `Stream.fromPubSub` defers `PubSub.subscribe` until the stream starts, so
   * consumers that fork a consumer loop can miss a publish in the scheduling
   * gap. Use `subscribeChanges` instead when the subscription must exist before
   * refresh or snapshot work begins.
   */
  readonly streamChanges: Stream.Stream<ReadonlyArray<ServerProvider>>;

  /**
   * Acquire the aggregated change subscription synchronously in the caller's
   * fiber, before returning a stream backed by that subscription. The
   * subscription is released when the caller's scope closes, so every publish
   * after this effect resolves is retained for the returned stream.
   */
  readonly subscribeChanges: Effect.Effect<
    Stream.Stream<ReadonlyArray<ServerProvider>>,
    never,
    Scope.Scope
  >;
}

export class ProviderRegistry extends Context.Service<ProviderRegistry, ProviderRegistryShape>()(
  "neokod/provider/Services/ProviderRegistry",
) {}
