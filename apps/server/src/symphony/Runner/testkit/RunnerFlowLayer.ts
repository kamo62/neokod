/**
 * One composed layer for Symphony runner flow tests.
 *
 * Dispatcher plus the fake Codex peer, approval service, live requests,
 * repositories and a stub finalizer, so W1 flow tests dispatch through the
 * real client with no process. Test-only.
 */
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { WorkItemRepositoryLive } from "../../Persistence/Layers/WorkItemRepository.ts";
import { RunAttemptRepositoryLive } from "../../Persistence/Layers/RunAttemptRepository.ts";
import { RunEventRepositoryLive } from "../../Persistence/Layers/RunEventRepository.ts";
import { ApprovalRepositoryLive } from "../../Persistence/Layers/ApprovalRepository.ts";
import { WorkspaceManager } from "../../Workspaces/Manager.ts";
import { ExecutionFinalizer } from "../ExecutionFinalizer.ts";
import { RunDispatcherLive } from "../Dispatcher.ts";
import { ApprovalServiceLive } from "../ApprovalService.ts";
import { LiveRequestsLive } from "../LiveRequests.ts";
import { fakeCodexRuntimeFactory, type FakeCodexPeer } from "./FakeCodexPeer.ts";
import { fakeWorkspaceManagerLayer, testServerConfigLayer } from "./RunnerFixtures.ts";
import * as Effect from "effect/Effect";

const fakeFinalizerLayer = Layer.succeed(ExecutionFinalizer, {
  finalize: () => Effect.succeed("review_ready"),
});

export const runnerFlowLayer = (input: {
  readonly nextPeer: () => FakeCodexPeer;
  readonly finalizer?: Layer.Layer<ExecutionFinalizer>;
  readonly workspaceManager?: Layer.Layer<WorkspaceManager>;
}) =>
  RunDispatcherLive.pipe(
    Layer.provideMerge(fakeCodexRuntimeFactory(input.nextPeer)),
    Layer.provideMerge(ApprovalServiceLive),
    Layer.provideMerge(LiveRequestsLive),
    Layer.provideMerge(ApprovalRepositoryLive),
    Layer.provideMerge(WorkItemRepositoryLive),
    Layer.provideMerge(RunAttemptRepositoryLive),
    Layer.provideMerge(RunEventRepositoryLive),
    Layer.provideMerge(input.workspaceManager ?? fakeWorkspaceManagerLayer()),
    Layer.provideMerge(input.finalizer ?? fakeFinalizerLayer),
    Layer.provideMerge(testServerConfigLayer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  );
