import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { FetchHttpClient } from "effect/unstable/http";

import { layer as ProcessRunnerLayer } from "../../processRunner.ts";
import { layer as GitVcsDriverLayer } from "../../vcs/GitVcsDriver.ts";
import { WorkflowRepositoryLive } from "../Persistence/Layers/WorkflowRepository.ts";
import { WorkItemRepositoryLive } from "../Persistence/Layers/WorkItemRepository.ts";
import { RunAttemptRepositoryLive } from "../Persistence/Layers/RunAttemptRepository.ts";
import { RunEventRepositoryLive } from "../Persistence/Layers/RunEventRepository.ts";
import { OrchestratorStateRepositoryLive } from "../Persistence/Layers/OrchestratorStateRepository.ts";
import { ApprovalRepositoryLive } from "../Persistence/Layers/ApprovalRepository.ts";
import { TrackerRegistryGitHubLive } from "../Trackers/Registry.ts";
import { TrackerEnablementLive } from "../Orchestrator/TrackerEnablement.ts";
import { SymphonyOrchestratorLive } from "../Orchestrator/Layers/SymphonyOrchestratorLive.ts";
import { LiveRequestsLive } from "../Runner/LiveRequests.ts";
import { ApprovalServiceLive } from "../Runner/ApprovalService.ts";
import { RunDispatcherLive } from "../Runner/Dispatcher.ts";
import { AgentRuntimeFactoryLive } from "../Runner/Live.ts";
import { WorkspaceManagerLive } from "../Workspaces/Live.ts";

/**
 * Symphony layer assembly for the Observe phase (plus the Phase 2 dispatch
 * wiring). The orchestrator reads trackers and projects the queue; when a
 * workflow's autonomy is prepare/execute/deliver it can also dispatch through
 * the RunDispatcher. All requirements (persistence, trackers, workspace
 * manager, agent runtime factory, and the platform services the dispatcher
 * stack needs) are provided internally so nothing leaks into the launch
 * boundary.
 */
export const SymphonyLayerObserve = Layer.merge(
  SymphonyOrchestratorLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        WorkflowRepositoryLive,
        WorkItemRepositoryLive,
        RunAttemptRepositoryLive,
        RunEventRepositoryLive,
        OrchestratorStateRepositoryLive,
        TrackerRegistryGitHubLive.pipe(Layer.provide(FetchHttpClient.layer)),
        TrackerEnablementLive,
        ApprovalServiceLive.pipe(
          Layer.provide(Layer.mergeAll(ApprovalRepositoryLive, LiveRequestsLive)),
        ),
      ).pipe(
        Layer.provideMerge(
          RunDispatcherLive.pipe(
            Layer.provide(
              Layer.mergeAll(
                WorkItemRepositoryLive,
                RunAttemptRepositoryLive,
                RunEventRepositoryLive,
                WorkspaceManagerLive.pipe(
                  Layer.provideMerge(NodeServices.layer),
                  Layer.provideMerge(GitVcsDriverLayer),
                  Layer.provideMerge(ProcessRunnerLayer),
                ),
                AgentRuntimeFactoryLive.pipe(
                  Layer.provideMerge(NodeServices.layer),
                  Layer.provideMerge(LiveRequestsLive),
                  Layer.provideMerge(
                    ApprovalServiceLive.pipe(
                      Layer.provide(Layer.mergeAll(ApprovalRepositoryLive, LiveRequestsLive)),
                    ),
                  ),
                ),
                LiveRequestsLive,
              ),
            ),
          ),
        ),
      ),
    ),
  ),
  ApprovalServiceLive.pipe(Layer.provide(Layer.mergeAll(ApprovalRepositoryLive, LiveRequestsLive))),
);
