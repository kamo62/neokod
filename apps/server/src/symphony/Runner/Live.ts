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
import { resolveTrackerAdapter, TrackerEnablement } from "../Orchestrator/TrackerEnablement.ts";
import { codexCommandWarning } from "../Workflow/Config.ts";

/**
 * Live per-config Codex agent runtime factory (Phase 2).
 *
 * Constructs the Codex agent runtime per workflow config: codex command from
 * the workflow, CODEX_HOME unset so Codex uses its own home, the server's
 * process environment, and the shared live-request registry. The dispatcher
 * builds one per dispatch inside a scope. Approval requests are recorded
 * durably through the ApprovalService (WS-J2) as well as answered live.
 * SPEC 15.3 env scrubbing: the tracker's secret environment names are
 * resolved per config and stripped from the agent child's environment. A
 * tracker adapter that cannot be resolved fails the dispatch: starting with
 * an unscrubbed environment is not an option.
 */
const makeAgentRuntimeFactory = Effect.gen(function* () {
  const liveRequests = yield* LiveRequests;
  const approvalService = yield* ApprovalService;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const registry = yield* TrackerAdapterRegistry;
  const enablement = yield* TrackerEnablement;
  const make = (
    config: EffectiveWorkflowConfig,
    options?: { readonly onChildSpawned?: (pid: number) => Effect.Effect<void> },
  ) =>
    // Secret names from the configured tracker adapter (SPEC 15.3). An
    // adapter that cannot be resolved yields null, which makes the runtime
    // refuse to spawn rather than starting with an unscrubbed environment.
    resolveTrackerAdapter(registry, enablement, config).pipe(
      Effect.map((adapter): ReadonlyArray<string> | null => adapter.secretEnvironmentNames()),
      // Unknown is not "none": a null list makes the runtime refuse to spawn (fail closed).
      Effect.tapError((cause) =>
        Effect.logWarning("symphony.agent.secret_names_unresolved", { cause: String(cause) }),
      ),
      Effect.catch(() => Effect.succeed(null as ReadonlyArray<string> | null)),
      Effect.flatMap((secretNames) =>
        Effect.gen(function* () {
          const warning = codexCommandWarning(config.codexCommand);
          if (warning !== null) {
            yield* Effect.logWarning("symphony.agent.codex_command_contains_app_server", {
              warning,
            });
          }
          return yield* makeCodexAgentRuntime({
            codexCommand: config.codexCommand ?? "codex",
            codexHomePath: undefined,
            env: process.env,
            secretEnvironmentNames: secretNames,
            ...(options?.onChildSpawned !== undefined
              ? { onChildSpawned: options.onChildSpawned }
              : {}),
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
          );
        }),
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
  | TrackerEnablement
> = Layer.effect(AgentRuntimeFactory, makeAgentRuntimeFactory);
