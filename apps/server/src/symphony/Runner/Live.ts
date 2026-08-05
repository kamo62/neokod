import type { EffectiveWorkflowConfig } from "@neokod/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { makeCodexAgentRuntime } from "./AgentRuntime.ts";
import { LiveRequests } from "./LiveRequests.ts";
import { AgentRuntimeFactory } from "./Dispatcher.ts";

/**
 * Live per-config Codex agent runtime factory (Phase 2).
 *
 * Constructs the Codex agent runtime per workflow config: codex command from
 * the workflow, CODEX_HOME unset so Codex uses its own home, the server's
 * process environment, and the shared live-request registry. The dispatcher
 * builds one per dispatch inside a scope.
 */
const makeAgentRuntimeFactory = Effect.gen(function* () {
  const liveRequests = yield* LiveRequests;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const make = (config: EffectiveWorkflowConfig) =>
    makeCodexAgentRuntime({
      codexCommand: config.codexCommand ?? "codex app-server",
      codexHomePath: undefined,
      env: process.env,
      liveRequests,
    }).pipe(
      Effect.mapError(() => Effect.never as never),
      // Resolve the spawner at factory construction so the dispatcher's public
      // boundary does not leak ChildProcessSpawner into the RPC handler.
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
  return AgentRuntimeFactory.of({ make });
});

export const AgentRuntimeFactoryLive: Layer.Layer<
  AgentRuntimeFactory,
  never,
  LiveRequests | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> = Layer.effect(AgentRuntimeFactory, makeAgentRuntimeFactory);
