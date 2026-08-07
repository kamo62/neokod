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
import { EvidenceRepositoryLive } from "../Persistence/Layers/EvidenceRepository.ts";
import { TrackerRegistryGitHubLive } from "../Trackers/Registry.ts";
import { TrackerEnablementLive } from "../Orchestrator/TrackerEnablement.ts";
import { SymphonyOrchestratorLive } from "../Orchestrator/Layers/SymphonyOrchestratorLive.ts";
import { LiveRequestsLive } from "../Runner/LiveRequests.ts";
import { ApprovalServiceLive } from "../Runner/ApprovalService.ts";
import { RunDispatcherLive } from "../Runner/Dispatcher.ts";
import { ExecutionFinalizerLive } from "../Runner/ExecutionFinalizer.ts";
import { AgentRuntimeFactoryLive } from "../Runner/Live.ts";
import { OrchestrationLayerLive } from "../../orchestration/runtimeLayer.ts";
import { WorkspaceManagerLive } from "../Workspaces/Live.ts";
import { ValidationRunnerLive } from "../Validation/Runner.ts";
import { EvidenceServiceLive } from "../Evidence/Service.ts";
import { PullRequestServiceLive } from "../Evidence/PullRequest.ts";
import { HandoffServiceLive } from "../HandoffService.ts";
import {
  WorkspaceOwnershipRepositoryLive,
  WorkspaceRemovalGuardLive,
} from "../Persistence/Layers/WorkspaceOwnershipRepository.ts";
import { layer as SourceControlProviderRegistryLayer } from "../../sourceControl/SourceControlProviderRegistry.ts";
import { layer as AzureDevOpsCliLayer } from "../../sourceControl/AzureDevOpsCli.ts";
import { layer as BitbucketApiLayer } from "../../sourceControl/BitbucketApi.ts";
import { layer as GitHubCliLayer } from "../../sourceControl/GitHubCli.ts";
import { layer as GitLabCliLayer } from "../../sourceControl/GitLabCli.ts";
import { layer as VcsDriverRegistryLayer } from "../../vcs/VcsDriverRegistry.ts";
import { layer as VcsProjectConfigLayer } from "../../vcs/VcsProjectConfig.ts";

/**
 * Symphony layer assembly for the Observe phase (plus the Phase 2 dispatch
 * wiring and the Phase 3 execute exit). The orchestrator reads trackers and
 * projects the queue; when a workflow's autonomy is prepare/execute/deliver it
 * can also dispatch through the RunDispatcher. Completed execute/deliver runs
 * land review-ready through the ExecutionFinalizer (validation + evidence +
 * orchestrator-owned PR creation, plan 10, WS-L). All requirements
 * (persistence, trackers, workspace manager, agent runtime factory, evidence,
 * and the platform services the dispatcher stack needs) are provided
 * internally so nothing leaks into the launch boundary (only ServerConfig,
 * which the CLI provides).
 */

// The source-control provider registry (PR creation goes through the provider
// abstraction, never a hard-coded CLI — plan D4). Rebuilt here so its
// requirements (VCS driver registry, CLI layers) stay inside the Symphony
// boundary instead of leaking into the launch layer.
const SourceControlProviderRegistryLive = SourceControlProviderRegistryLayer.pipe(
  Layer.provide(
    Layer.mergeAll(AzureDevOpsCliLayer, BitbucketApiLayer, GitHubCliLayer, GitLabCliLayer).pipe(
      Layer.provideMerge(FetchHttpClient.layer),
    ),
  ),
  Layer.provideMerge(GitVcsDriverLayer),
  Layer.provideMerge(VcsDriverRegistryLayer.pipe(Layer.provide(VcsProjectConfigLayer))),
);

const ExecutionFinalizerSlice = ExecutionFinalizerLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      ValidationRunnerLive.pipe(Layer.provideMerge(ProcessRunnerLayer)),
      EvidenceServiceLive.pipe(Layer.provideMerge(GitVcsDriverLayer)),
      PullRequestServiceLive.pipe(
        Layer.provideMerge(GitVcsDriverLayer),
        Layer.provideMerge(SourceControlProviderRegistryLive),
      ),
      EvidenceRepositoryLive,
      RunAttemptRepositoryLive,
      RunEventRepositoryLive,
      WorkItemRepositoryLive,
    ).pipe(Layer.provideMerge(NodeServices.layer)),
  ),
);

// Cross-mode handoff (plan 16, Phase 4). Exposed separately so the WS RPC
// layer can resolve it via `serviceOption` alongside the orchestrator.
const HandoffServiceSlice = HandoffServiceLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      WorkItemRepositoryLive,
      RunAttemptRepositoryLive,
      RunEventRepositoryLive,
      WorkflowRepositoryLive,
      WorkspaceOwnershipRepositoryLive,
      // The orchestration stack (memoized with the Work-mode instance, so
      // takeOver binds a REAL thread in production instead of taking the
      // placeholder path — fix-lane item 7: the engine was absent from this
      // sub-graph's context).
      OrchestrationLayerLive,
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
              // Required at construction: every dispatch path records a
              // Symphony lease (plan 16.0; completion audit, send-back 2).
              Layer.provideMerge(WorkspaceOwnershipRepositoryLive),
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
            ExecutionFinalizerSlice,
          ),
        ),
      ),
      LiveRequestsLive,
    ).pipe(Layer.provideMerge(NodeServices.layer)),
  ),
);

export const SymphonyLayerObserve = Layer.merge(
  SymphonyOrchestratorLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        WorkflowRepositoryLive,
        WorkItemRepositoryLive,
        RunAttemptRepositoryLive,
        RunEventRepositoryLive,
        OrchestratorStateRepositoryLive,
        EvidenceRepositoryLive,
        PullRequestServiceLive.pipe(
          Layer.provideMerge(GitVcsDriverLayer),
          Layer.provideMerge(SourceControlProviderRegistryLive),
          Layer.provideMerge(NodeServices.layer),
        ),
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
                  // Required at construction: every dispatch path records a
                  // Symphony lease (plan 16.0; completion audit, send-back 2).
                  Layer.provideMerge(WorkspaceOwnershipRepositoryLive),
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
                ExecutionFinalizerSlice,
              ),
            ),
          ),
        ),
      ),
    ),
  ),
  Layer.mergeAll(
    ApprovalServiceLive.pipe(
      Layer.provide(Layer.mergeAll(ApprovalRepositoryLive, LiveRequestsLive)),
    ),
    HandoffServiceSlice,
    // WorkspaceRemovalGuard needs its own repo instance; WorkspaceOwnership
    // is ALSO exposed here so `serviceOption` in the Workspaces live layer
    // resolves it on production paths (fix-lane item 2: hiding it in
    // sub-graphs left acquireOwnership a no-op and the plan 16.0 lease
    // unrecorded).
    WorkspaceRemovalGuardLive.pipe(Layer.provide(WorkspaceOwnershipRepositoryLive)),
    WorkspaceOwnershipRepositoryLive,
  ),
);
