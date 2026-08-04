import type {
  EffectiveWorkflowConfig,
  NormalizedIssue,
  QueueItem,
  RunSummary,
  SymphonyOverview,
  TrackerHealth,
  WorkflowRecord,
  WorkItem,
} from "@neokod/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";

import { nowIso } from "../../Domain/Time.ts";
import { WorkflowRepository } from "../../Persistence/Services/WorkflowRepository.ts";
import { WorkItemRepository } from "../../Persistence/Services/WorkItemRepository.ts";
import { OrchestratorStateRepository } from "../../Persistence/Services/OrchestratorStateRepository.ts";
import { TrackerAdapterRegistry } from "../../Trackers/Adapter.ts";
import { TrackerEnablement } from "../TrackerEnablement.ts";
import { evaluateEligibility } from "../Eligibility.ts";
import { projectWorkItem } from "../Projection.ts";
import { SymphonyOrchestrator, type SymphonyOrchestratorShape } from "../SymphonyOrchestrator.ts";

/**
 * Live orchestrator. At Observe autonomy it polls each active workflow,
 * validates the tracker is enabled, fetches candidate issues, evaluates
 * eligibility, and upserts the queue projection. It never dispatches: there is
 * no claim, no workspace creation, and no agent launch until a later phase.
 *
 * The poll loop is a daemon fiber forked into the layer's scope; it ticks on a
 * fixed cadence and `refreshNow()` forces an immediate cycle for the Observe
 * RPC surface.
 */

const POLL_INTERVAL = "30 seconds";

interface OrchestratorRuntimeState {
  readonly lastPollAt: string | null;
  readonly trackerHealth: ReadonlyArray<TrackerHealth>;
}

const EMPTY_STATE: OrchestratorRuntimeState = {
  lastPollAt: null,
  trackerHealth: [],
};

const buildQueueItem = (workItem: WorkItem): QueueItem => ({
  workItemId: workItem.id,
  trackerIdentifier: workItem.trackerIdentifier ?? undefined,
  title: workItem.objective,
  repositoryPath: workItem.repositoryPath ?? undefined,
  workflowId: workItem.workflowId ?? undefined,
  state: workItem.lifecycle,
  lifecycle: workItem.lifecycle,
  priority: workItem.priority ?? undefined,
  blocked: workItem.blocked ?? false,
  blockers: [],
  eligible: workItem.eligibilityReasons.length === 0,
  ineligibilityReasons: workItem.eligibilityReasons,
  excluded: workItem.excluded ?? false,
  estimatedReadiness: null,
  createdAt: workItem.createdAt,
});

const recordTrackerHealth = (
  stateRef: Ref.Ref<OrchestratorRuntimeState>,
  config: EffectiveWorkflowConfig,
  ok: boolean,
  error: string | null,
) =>
  Effect.gen(function* () {
    const now = yield* nowIso;
    yield* Ref.update(stateRef, (state) => {
      const health: TrackerHealth = {
        kind: config.trackerKind,
        ok,
        error,
        lastPollAt: now,
        profile: config.trackerProvider,
      };
      const next = state.trackerHealth.filter((h) => h.kind !== config.trackerKind);
      return { ...state, lastPollAt: now, trackerHealth: [...next, health] };
    });
  });

const pollWorkflow = (deps: {
  readonly workItems: WorkItemRepository["Service"];
  readonly registry: TrackerAdapterRegistry["Service"];
  readonly enablement: TrackerEnablement["Service"];
  readonly stateRef: Ref.Ref<OrchestratorRuntimeState>;
}) =>
  Effect.fn("pollWorkflow")(function* (workflow: WorkflowRecord, now: string) {
    const config = workflow.effectiveConfig;
    if (config === null || workflow.status !== "active") {
      return;
    }

    const enabled = yield* deps.enablement.validateTrackerEnabled(config).pipe(Effect.isSuccess);
    if (!enabled) {
      yield* recordTrackerHealth(
        deps.stateRef,
        config,
        false,
        "tracker disabled in Tracking settings",
      );
      return;
    }

    const adapter = yield* deps.registry
      .resolve(config.trackerKind, config.trackerProvider, {
        repositoryPath: config.repositoryPath,
      })
      .pipe(
        Effect.catch((error) =>
          recordTrackerHealth(deps.stateRef, config, false, error.message).pipe(
            Effect.as(null as never),
          ),
        ),
      );
    if (adapter === null) {
      return;
    }

    const issues = yield* adapter
      .listCandidateIssues()
      .pipe(
        Effect.catch((error) =>
          recordTrackerHealth(deps.stateRef, config, false, error.message).pipe(
            Effect.as([] as NormalizedIssue[]),
          ),
        ),
      );
    yield* recordTrackerHealth(deps.stateRef, config, true, null);

    for (const issue of issues) {
      const eligibility = evaluateEligibility({
        config,
        issue,
        claimedIssueIds: new Set<string>(),
        dispatchPaused: false,
      });
      const workItem = yield* projectWorkItem(issue, config, eligibility, now);
      yield* deps.workItems.upsert(workItem).pipe(Effect.catch(() => Effect.void));
    }
  });

const makeOrchestrator = Effect.gen(function* () {
  const workflows = yield* WorkflowRepository;
  const workItems = yield* WorkItemRepository;
  const registry = yield* TrackerAdapterRegistry;
  const enablement = yield* TrackerEnablement;
  const orchestratorState = yield* OrchestratorStateRepository;

  const stateRef = yield* Ref.make<OrchestratorRuntimeState>(EMPTY_STATE);

  const runTick = Effect.fn("symphonyOrchestrator.tick")(function* () {
    const now = yield* nowIso;
    const active = yield* workflows
      .list()
      .pipe(Effect.map((all) => all.filter((w) => w.status === "active")))
      .pipe(Effect.catch(() => Effect.succeed([] as WorkflowRecord[])));
    for (const workflow of active) {
      yield* pollWorkflow({ workItems, registry, enablement, stateRef })(workflow, now).pipe(
        Effect.catch(() => Effect.void),
      );
    }
    yield* Ref.update(stateRef, (state) => ({ ...state, lastPollAt: now }));
  });

  const scheduler = Effect.gen(function* () {
    yield* runTick();
    yield* Effect.repeat(runTick(), Schedule.fixed(POLL_INTERVAL));
  });

  // Fork the poll loop into the surrounding scope so it stops on layer teardown.
  yield* Effect.forkScoped(scheduler);

  const refreshNow: SymphonyOrchestratorShape["refreshNow"] = () => runTick();

  const getOverview = (): Effect.Effect<SymphonyOverview, never> =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      const state = yield* Ref.get(stateRef);
      const paused = yield* orchestratorState
        .isGlobalPaused()
        .pipe(Effect.catch(() => Effect.succeed(false)));
      const activeWorkflows = yield* workflows
        .list()
        .pipe(Effect.map((all) => all.filter((w) => w.status === "active").length))
        .pipe(Effect.catch(() => Effect.succeed(0)));
      const queue = yield* workItems
        .listByLifecycle(["eligible", "queued"])
        .pipe(Effect.catch(() => Effect.succeed([])));
      const queued = queue.filter((item) => item.lifecycle === "queued").length;
      return {
        running: 0,
        queued,
        needsAttention: 0,
        readyForReview: 0,
        retrying: 0,
        failedToday: 0,
        orchestratorPaused: paused,
        activeWorkflowCount: activeWorkflows,
        providerHealth: {},
        trackerHealth: Object.fromEntries(
          state.trackerHealth.map((health) => [
            health.kind,
            { ok: health.ok, lastPollAt: health.lastPollAt },
          ]),
        ),
        lastTrackerPollAt: state.lastPollAt,
        activeAgentCount: 0,
        generatedAt: now,
      };
    });

  const listQueue: SymphonyOrchestratorShape["listQueue"] = (filter) =>
    Effect.gen(function* () {
      const items = yield* workItems
        .listByLifecycle(
          ["eligible", "queued"],
          filter?.limit === undefined ? undefined : { limit: filter.limit },
        )
        .pipe(Effect.catch(() => Effect.succeed([] as WorkItem[])));
      return items.map(buildQueueItem);
    });

  const listRuns: SymphonyOrchestratorShape["listRuns"] = () => Effect.succeed([] as RunSummary[]);

  const listWorkflows: SymphonyOrchestratorShape["listWorkflows"] = () =>
    workflows.list().pipe(Effect.catch(() => Effect.succeed([])));

  const listTrackerHealth: SymphonyOrchestratorShape["listTrackerHealth"] = () =>
    Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);
      return [...state.trackerHealth];
    });

  const isPaused: SymphonyOrchestratorShape["isPaused"] = () =>
    orchestratorState.isGlobalPaused().pipe(Effect.catch(() => Effect.succeed(false)));

  return {
    refreshNow,
    getOverview,
    listQueue,
    listRuns,
    listWorkflows,
    listTrackerHealth,
    isPaused,
  } satisfies SymphonyOrchestratorShape;
});

export const SymphonyOrchestratorLive = Layer.effect(SymphonyOrchestrator, makeOrchestrator);

export { pollWorkflow, buildQueueItem };
