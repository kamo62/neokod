import { SYMPHONY_WS_METHODS } from "@neokod/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@neokod/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * View-local Symphony atoms for RPCs that are not yet mounted on
 * `@neokod/client-runtime`'s `createSymphonyEnvironmentAtoms` (tracker
 * health, run history, workflow validate/activate/pause/resume, and the
 * global pause/resume/stop-all controls). Built the same way
 * `state/symphony.ts` builds the rest of the Symphony atoms: thin wrappers
 * over the shared `createEnvironmentRpc*` helpers, keyed to environment and
 * RPC input.
 */
export const symphonyExtras = {
  trackers: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:symphony:trackers",
    tag: SYMPHONY_WS_METHODS.listTrackers,
    staleTimeMs: 10_000,
    refreshIntervalMs: 30_000,
  }),
  history: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:symphony:history",
    tag: SYMPHONY_WS_METHODS.listHistory,
    staleTimeMs: 10_000,
    refreshIntervalMs: 30_000,
  }),
  validateWorkflow: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-command:symphony:validateWorkflow",
    tag: SYMPHONY_WS_METHODS.validateWorkflow,
  }),
  activateWorkflow: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-command:symphony:activateWorkflow",
    tag: SYMPHONY_WS_METHODS.activateWorkflow,
  }),
  pauseWorkflow: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-command:symphony:pauseWorkflow",
    tag: SYMPHONY_WS_METHODS.pauseWorkflow,
  }),
  resumeWorkflow: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-command:symphony:resumeWorkflow",
    tag: SYMPHONY_WS_METHODS.resumeWorkflow,
  }),
  pauseGlobal: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-command:symphony:pauseGlobal",
    tag: SYMPHONY_WS_METHODS.pauseGlobal,
  }),
  resumeGlobal: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-command:symphony:resumeGlobal",
    tag: SYMPHONY_WS_METHODS.resumeGlobal,
  }),
  stopAllRuns: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-command:symphony:stopAllRuns",
    tag: SYMPHONY_WS_METHODS.stopAllRuns,
  }),
};
