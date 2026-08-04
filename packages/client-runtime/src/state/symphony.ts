import { SYMPHONY_WS_METHODS } from "@neokod/contracts";
import { Atom } from "effect/unstable/reactivity";

import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

/**
 * Symphony Observe state atoms.
 *
 * Query atoms for the read-only Observe surface: overview, queue, runs,
 * workflows, and tracker health. Live subscriptions (queue/runs updates) are
 * added when the subscription RPCs are mounted; for now the views refresh on
 * mount and on an explicit refresh interval.
 */
export function createSymphonyEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    overview: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:symphony:overview",
      tag: SYMPHONY_WS_METHODS.getOverview,
      staleTimeMs: 10_000,
      refreshIntervalMs: 30_000,
    }),
    queue: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:symphony:queue",
      tag: SYMPHONY_WS_METHODS.listQueue,
      staleTimeMs: 10_000,
      refreshIntervalMs: 30_000,
    }),
    runs: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:symphony:runs",
      tag: SYMPHONY_WS_METHODS.listRuns,
      staleTimeMs: 10_000,
      refreshIntervalMs: 30_000,
    }),
    workflows: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:symphony:workflows",
      tag: SYMPHONY_WS_METHODS.listWorkflows,
      staleTimeMs: 10_000,
      refreshIntervalMs: 30_000,
    }),
  };
}
