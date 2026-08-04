import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";

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
 * Issues and Jira tracker adapters, and the tracker-enablement gate. The
 * repositories share the runtime's SQLite client, the tracker gate reads
 * `ServerSettings.trackers`, the GitHub adapter uses `VcsProcess`, and the
 * Jira adapter uses the shared `HttpClient` (provided internally so the
 * requirement does not leak into the launch boundary).
 */
export const SymphonyLayerObserve = Layer.merge(
  SymphonyOrchestratorLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        WorkflowRepositoryLive,
        WorkItemRepositoryLive,
        OrchestratorStateRepositoryLive,
        TrackerRegistryGitHubLive.pipe(Layer.provide(FetchHttpClient.layer)),
        TrackerEnablementLive,
      ),
    ),
  ),
  ApprovalServiceLive.pipe(Layer.provide(Layer.mergeAll(ApprovalRepositoryLive, LiveRequestsLive))),
);
