import { expect, it } from "@effect/vitest";
import type { EffectiveWorkflowConfig } from "@neokod/contracts";
import { ProviderDriverKind, ProviderInstanceId } from "@neokod/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { AgentRuntimeFactory } from "./Dispatcher.ts";
import { AgentRuntimeFactoryLive } from "./Live.ts";
import { ApprovalService } from "./ApprovalService.ts";
import { LiveRequestsLive } from "./LiveRequests.ts";
import { TrackerRegistryEmptyLive } from "../Trackers/Registry.ts";
import { TrackerEnablement, makeTrackerEnablement } from "../Orchestrator/TrackerEnablement.ts";

const makeConfig = (codexCommand?: string): EffectiveWorkflowConfig =>
  ({
    repositoryPath: "/repo",
    workflowPath: "/repo/WORKFLOW.md",
    trackerKind: "github",
    trackerRequiredLabels: [],
    trackerActiveStates: ["open"],
    trackerTerminalStates: ["closed"],
    trackerProvider: {},
    workspaceRoot: "/ws",
    autonomy: "execute",
    agentProvider: {
      instanceId: ProviderInstanceId.make("codex_default"),
      driver: ProviderDriverKind.make("codex"),
    },
    validationRequired: [],
    validationTestPathPatterns: [],
    approvalsProtectedPaths: [],
    approvalsPolicies: [],
    ...(codexCommand !== undefined ? { codexCommand } : {}),
  }) as EffectiveWorkflowConfig;

it.effect("warns once per runtime when codex.command contains app-server", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const logs: Array<string> = [];
      const logger = Logger.make(({ message }) => {
        logs.push(String(message));
      });
      const spawner = ChildProcessSpawner.make(() => Effect.die("unused"));
      const factory = yield* AgentRuntimeFactory.pipe(
        Effect.provide(
          AgentRuntimeFactoryLive.pipe(
            Layer.provide(LiveRequestsLive),
            Layer.provide(Layer.succeed(ApprovalService, {} as never)),
            Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
            Layer.provide(TrackerRegistryEmptyLive),
            Layer.provide(
              Layer.succeed(
                TrackerEnablement,
                makeTrackerEnablement(() => Effect.succeed({})),
              ),
            ),
          ),
        ),
      );
      const logLayer = Logger.layer([logger], { mergeWithExisting: false });
      yield* factory.make(makeConfig("codex app-server")).pipe(Effect.provide(logLayer));
      expect(logs.some((message) => message.includes("codex_command_contains_app_server"))).toBe(
        true,
      );
      logs.length = 0;
      yield* factory.make(makeConfig("codex")).pipe(Effect.provide(logLayer));
      expect(logs.some((message) => message.includes("codex_command_contains_app_server"))).toBe(
        false,
      );
    }),
  ),
);
