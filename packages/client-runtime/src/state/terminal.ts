import {
  type EnvironmentId,
  type TerminalMetadataStreamEvent,
  type TerminalSummary,
  WS_METHODS,
} from "@neokod/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Atom } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { subscribe, type EnvironmentRpcInput } from "../rpc/client.ts";
import {
  applyTerminalAttachStreamEvent,
  applyTerminalMetadataStreamEvent,
  createTerminalMetadataInputInvalidator,
  EMPTY_TERMINAL_BUFFER_STATE,
  withTerminalInputInvalidation,
} from "./terminalSession.ts";

/**
 * Project terminal metadata into the shared terminal session state while
 * invalidating retained input queues from authoritative events. Tapping before
 * the scan matters: a re-subscribe emits a fresh snapshot, not an empty reset,
 * so a still-running session keeps its queue.
 */
export function projectTerminalMetadata<E, R>(
  environmentId: EnvironmentId,
  stream: Stream.Stream<TerminalMetadataStreamEvent, E, R>,
): Stream.Stream<ReadonlyArray<TerminalSummary>, E, R> {
  const invalidate = createTerminalMetadataInputInvalidator(environmentId);
  return stream.pipe(
    Stream.tap((event) => {
      invalidate(event);
      return Effect.void;
    }),
    Stream.scan([] as ReadonlyArray<TerminalSummary>, applyTerminalMetadataStreamEvent),
  );
}

export function createTerminalEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const lifecycleScheduler = createAtomCommandScheduler();
  const resizeScheduler = createAtomCommandScheduler();
  const terminalThreadKey = ({
    environmentId,
    input,
  }: {
    readonly environmentId: string;
    readonly input: { readonly threadId: string; readonly terminalId?: string | undefined };
  }) => JSON.stringify([environmentId, input.threadId]);
  const terminalSessionKey = ({
    environmentId,
    input,
  }: {
    readonly environmentId: string;
    readonly input: { readonly threadId: string; readonly terminalId?: string | undefined };
  }) => JSON.stringify([environmentId, input.threadId, input.terminalId ?? null]);
  const lifecycleConcurrency = { mode: "serial" as const, key: terminalThreadKey };
  const restartCommand = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:terminal:restart",
    tag: WS_METHODS.terminalRestart,
    scheduler: lifecycleScheduler,
    concurrency: lifecycleConcurrency,
  });
  const closeCommand = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:terminal:close",
    tag: WS_METHODS.terminalClose,
    scheduler: lifecycleScheduler,
    concurrency: lifecycleConcurrency,
  });
  return {
    attach: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:terminal:attach",
      subscribe: (input: EnvironmentRpcInput<typeof WS_METHODS.terminalAttach>) =>
        subscribe(WS_METHODS.terminalAttach, input).pipe(
          Stream.scan(EMPTY_TERMINAL_BUFFER_STATE, applyTerminalAttachStreamEvent),
        ),
    }),
    events: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:terminal:events",
      tag: WS_METHODS.subscribeTerminalEvents,
    }),
    metadata: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:terminal:metadata",
      subscribe: (_input: null, environmentId) =>
        projectTerminalMetadata(environmentId, subscribe(WS_METHODS.subscribeTerminalMetadata, {})),
    }),
    open: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:open",
      tag: WS_METHODS.terminalOpen,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    write: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:write",
      tag: WS_METHODS.terminalWrite,
    }),
    resize: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:resize",
      tag: WS_METHODS.terminalResize,
      scheduler: resizeScheduler,
      concurrency: { mode: "latest", key: terminalSessionKey },
    }),
    clear: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:clear",
      tag: WS_METHODS.terminalClear,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    restart: withTerminalInputInvalidation(restartCommand),
    close: withTerminalInputInvalidation(closeCommand),
  };
}

export * from "./terminalSession.ts";
