import * as Layer from "effect/Layer";

import { WorkflowRepositoryLive } from "../Persistence/Layers/WorkflowRepository.ts";
import { WorkItemRepositoryLive } from "../Persistence/Layers/WorkItemRepository.ts";
import { OrchestratorStateRepositoryLive } from "../Persistence/Layers/OrchestratorStateRepository.ts";
import { ApprovalRepositoryLive } from "../Persistence/Layers/ApprovalRepository.ts";
import { TrackerRegistryGitHubLive } from "../Trackers/Registry.ts";
import { TrackerEnablementLive } from "../Orchestrator/TrackerEnablement.ts";
import { SymphonyOrchestratorLive } from "../Orchestrator/Layers/SymphonyOrchestratorLive.ts";
import { LiveRequestsLive } from "../Runner/LiveRequests.ts";
import { ApprovalServiceLive } from "../Runner/ApprovalService.ts";

/**
 * Symphony layer assembly for the Observe phase.
 *
 * Wires the orchestrator live with its persistence repositories, the GitHub
 * Issues tracker adapter (host-side `gh`), and the tracker-enablement gate.
 * The repositories share the runtime's SQLite client, the tracker gate reads
 * `ServerSettings.trackers`, and the GitHub adapter uses `VcsProcess`. These
 * are provided by the runtime assembly that mounts this layer, mirroring how
 * `OrchestrationLayerLive` is wired (the runtime mounts it with its
 * providers already in the environment).
 */
export const SymphonyLayerObserve = Layer.merge(
  SymphonyOrchestratorLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        WorkflowRepositoryLive,
        WorkItemRepositoryLive,
        OrchestratorStateRepositoryLive,
        TrackerRegistryGitHubLive,
        TrackerEnablementLive,
      ),
    ),
  ),
  ApprovalServiceLive.pipe(Layer.provide(Layer.mergeAll(ApprovalRepositoryLive, LiveRequestsLive))),
);
