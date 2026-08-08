import type { EffectiveWorkflowConfig } from "@neokod/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { makeCodexAgentRuntime } from "./AgentRuntime.ts";
import { ApprovalService } from "./ApprovalService.ts";
import { LiveRequests } from "./LiveRequests.ts";
import { AgentRuntimeFactory } from "./Dispatcher.ts";
import { TrackerAdapterRegistry } from "../Trackers/Adapter.ts";

/**
 * Live per-config Codex agent runtime factory (Phase 2).
 *
 * Constructs the Codex agent runtime per workflow config: codex command from
 * the workflow, CODEX_HOME unset so Codex uses its own home, the server's
 * process environment, and the shared live-request registry. The dispatcher
 * builds one per dispatch inside a scope. Approval requests are recorded
 * durably through the ApprovalService (WS-J2) as well as answered live.
 * SPEC 15.3 env scrubbing: the tracker's secret environment names are
 * resolved per config and stripped from the agent child's environment.
 */
const makeAgentRuntimeFactory = Effect.gen(function* () {
  const liveRequests = yield* LiveRequests;
  const approvalService = yield* ApprovalService;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const registry = yield* TrackerAdapterRegistry;
  const make = (config: EffectiveWorkflowConfig) =>
    // Secret names from the configured tracker adapter (SPEC 15.3). Any
    // adapter that cannot be resolved contributes nothing rather than
    // failing the dispatch.
    registry
      .resolve(config.trackerKind, config.trackerProvider, {
        repositoryPath: config.repositoryPath,
      })
      .pipe(
        Effect.map((adapter) => adapter.secretEnvironmentNames()),
        Effect.catch(() => Effect.succeed([] as ReadonlyArray<string>)),
        Effect.flatMap((secretNames) =>
          makeCodexAgentRuntime({
            codexCommand: config.codexCommand ?? "codex app-server",
            codexHomePath: undefined,
            env: process.env,
            secretEnvironmentNames: secretNames,
            liveRequests,
            recordRequest: (input) =>
              approvalService
                .recordPending({
                  id: input.requestId,
                  requestId: input.requestId,
                  workItemId: input.workItemId,
                  runAttemptId: input.runAttemptId,
                  action: input.action,
                  scope: "once",
                  ...(input.command !== undefined ? { command: input.command } : {}),
                })
                .pipe(
                  Effect.asVoid,
                  Effect.catch(() => Effect.void),
                ),
          }).pipe(
            Effect.mapError(() => Effect.never as never),
            // Resolve the spawner at factory construction so the dispatcher's public
            // boundary does not leak ChildProcessSpawner into the RPC handler.
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          ),
        ),
      );
  return AgentRuntimeFactory.of({ make });
});

export const AgentRuntimeFactoryLive: Layer.Layer<
  AgentRuntimeFactory,
  never,
  | LiveRequests
  | ApprovalService
  | ChildProcessSpawner.ChildProcessSpawner
  | Scope.Scope
  | TrackerAdapterRegistry
> = Layer.effect(AgentRuntimeFactory, makeAgentRuntimeFactory);
