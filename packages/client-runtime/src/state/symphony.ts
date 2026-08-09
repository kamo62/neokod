import { SYMPHONY_WS_METHODS } from "@neokod/contracts";
import { Atom } from "effect/unstable/reactivity";

import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

/**
 * Symphony Observe state atoms.
 *
 * Query atoms for the read-only Observe surface: overview, queue, runs,
 * workflows, and tracker health. Command atoms for the FR-022 queue overrides
 * (exclude / include / local priority), which persist server-side and survive
 * restart. Live subscriptions (queue/runs updates) are added when the
 * subscription RPCs are mounted; for now the views refresh on mount and on an
 * explicit refresh interval.
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
    getRun: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:symphony:getRun",
      tag: SYMPHONY_WS_METHODS.getRun,
      staleTimeMs: 5_000,
      refreshIntervalMs: 10_000,
    }),
    projects: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:symphony:projects",
      tag: SYMPHONY_WS_METHODS.listProjects,
      staleTimeMs: 5_000,
      refreshIntervalMs: 15_000,
    }),
    project: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:symphony:project",
      tag: SYMPHONY_WS_METHODS.getProject,
      staleTimeMs: 5_000,
      refreshIntervalMs: 15_000,
    }),
    projectBoard: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:symphony:projectBoard",
      tag: SYMPHONY_WS_METHODS.getProjectBoard,
      staleTimeMs: 2_000,
      refreshIntervalMs: 5_000,
    }),
    createProject: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:symphony:createProject",
      tag: SYMPHONY_WS_METHODS.createProject,
    }),
    updateProject: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:symphony:updateProject",
      tag: SYMPHONY_WS_METHODS.updateProject,
    }),
    startProject: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:symphony:startProject",
      tag: SYMPHONY_WS_METHODS.startProject,
    }),
    pauseProject: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:symphony:pauseProject",
      tag: SYMPHONY_WS_METHODS.pauseProject,
    }),
    attention: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:symphony:attention",
      tag: SYMPHONY_WS_METHODS.listAttention,
      staleTimeMs: 5_000,
      refreshIntervalMs: 15_000,
    }),
    workflows: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:symphony:workflows",
      tag: SYMPHONY_WS_METHODS.listWorkflows,
      staleTimeMs: 10_000,
      refreshIntervalMs: 30_000,
    }),
    excludeWorkItem: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:symphony:excludeWorkItem",
      tag: SYMPHONY_WS_METHODS.excludeWorkItem,
    }),
    includeWorkItem: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:symphony:includeWorkItem",
      tag: SYMPHONY_WS_METHODS.includeWorkItem,
    }),
    setLocalPriority: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:symphony:setLocalPriority",
      tag: SYMPHONY_WS_METHODS.setLocalPriority,
    }),
    dispatchWorkItem: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:symphony:dispatchWorkItem",
      tag: SYMPHONY_WS_METHODS.dispatchWorkItem,
    }),
    cancelRun: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:symphony:cancelRun",
      tag: SYMPHONY_WS_METHODS.cancelRun,
    }),
    approve: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:symphony:approve",
      tag: SYMPHONY_WS_METHODS.approve,
    }),
    reject: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:symphony:reject",
      tag: SYMPHONY_WS_METHODS.reject,
    }),
  };
}
