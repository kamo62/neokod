import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL,
  CommandId,
  type DiscoveredLocalServerList,
  EventId,
  type OrchestrationCommand,
  type GitActionProgressEvent,
  type GitManagerServiceError,
  OrchestrationDispatchCommandError,
  type OrchestrationEvent,
  type OrchestrationShellStreamEvent,
  type OrchestrationShellStreamItem,
  type OrchestrationThreadStreamItem,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetSnapshotError,
  OrchestrationGetTurnDiffError,
  ORCHESTRATION_WS_METHODS,
  type ProjectEntriesFailure,
  type ProjectFileFailure,
  type ProjectFileOperation,
  ProjectListEntriesError,
  ProjectId,
  ProjectReadFileError,
  ProjectSearchEntriesError,
  ProjectWriteFileError,
  type FilesystemBrowseFailure,
  FilesystemBrowseError,
  AssetWorkspaceContextNotFoundError,
  AssetWorkspaceContextResolutionError,
  ThreadId,
  type TerminalAttachStreamEvent,
  type TerminalError,
  type TerminalEvent,
  type TerminalMetadataStreamEvent,
  WS_METHODS,
  WsRpcGroup,
  SYMPHONY_WS_METHODS,
  type SymphonyOverview,
  SymphonyError,
  SymphonyApproveInput,
  SymphonyApproveMergeInput,
  SymphonyRefreshPullRequestInput,
  SymphonyCancelRunInput,
  SymphonyDelegateFromThreadInput,
  SymphonyDispatchWorkItemInput,
  SymphonyExcludeWorkItemInput,
  SymphonyGetRunInput,
  SymphonyListProjectsInput,
  SymphonyGetProjectInput,
  SymphonyCreateProjectInput,
  SymphonyUpdateProjectInput,
  SymphonyStartProjectInput,
  SymphonyPauseProjectInput,
  SymphonyGetProjectBoardInput,
  SymphonyProjectId,
  SymphonyIncludeWorkItemInput,
  SymphonyListAttentionInput,
  SymphonyListQueueInput,
  SymphonyListRunsInput,
  SymphonyRejectInput,
  SymphonyRequestChangesInput,
  SymphonyRespondToUserInputInput,
  SymphonyResumeAutonomousInput,
  SymphonySetLocalPriorityInput,
  SymphonyTakeOverInput,
  SymphonyActivateWorkflowInput,
  SymphonyValidateWorkflowInput,
  SymphonyPauseWorkflowInput,
  SymphonyResumeWorkflowInput,
  SymphonyPauseRepositoryInput,
  SymphonyResumeRepositoryInput,
  SymphonyStopAllRunsInput,
  SymphonyGetWorkflowInput,
  SymphonyGetWorkflowContentInput,
  SymphonySaveWorkflowContentInput,
  SymphonyCreateWorkflowInput,
  SymphonyListHistoryInput,
  SymphonyResolveAttentionInput,
} from "@neokod/contracts";
import { HttpRouter, HttpServerRespondable } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

import * as CheckpointDiffQuery from "./checkpointing/CheckpointDiffQuery.ts";
import * as ServerConfig from "./config.ts";
import * as Keybindings from "./keybindings.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import {
  projectActivityEvent,
  projectThreadDetailSnapshot,
} from "./orchestration/ActivityPayloadProjection.ts";
import { normalizeDispatchCommand } from "./orchestration/Normalizer.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import * as SymphonyOrchestrator from "./symphony/Orchestrator/SymphonyOrchestrator.ts";
import * as ApprovalService from "./symphony/Runner/ApprovalService.ts";
import * as HandoffService from "./symphony/HandoffService.ts";
import { WorkflowLoaderService } from "./symphony/Workflow/Loader.ts";
import {
  observeRpcEffect as instrumentRpcEffect,
  observeRpcStream as instrumentRpcStream,
  observeRpcStreamEffect as instrumentRpcStreamEffect,
} from "./observability/RpcInstrumentation.ts";
import * as ProviderRegistry from "./provider/Services/ProviderRegistry.ts";
import * as ProviderMaintenanceRunner from "./provider/providerMaintenanceRunner.ts";
import { testManagedClientEvidenceConnection } from "./provider/copilot/ManagedClientEvidenceTestConnection.ts";
import {
  getGithubDeviceLoginStatus,
  signOutGithubDeviceLogin,
  startGithubDeviceLogin,
} from "./provider/copilot/GithubDeviceLogin.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as PreviewAutomationBroker from "./mcp/PreviewAutomationBroker.ts";
import * as PreviewManager from "./preview/Manager.ts";
import { issueAssetUrl } from "./assets/AssetAccess.ts";
import * as PortScanner from "./preview/PortScanner.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import * as VcsStatusBroadcaster from "./vcs/VcsStatusBroadcaster.ts";
import * as VcsProvisioningService from "./vcs/VcsProvisioningService.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as ReviewService from "./review/ReviewService.ts";
import * as ProjectSetupScriptRunner from "./project/ProjectSetupScriptRunner.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as ProcessDiagnostics from "./diagnostics/ProcessDiagnostics.ts";
import * as ProcessResourceMonitor from "./diagnostics/ProcessResourceMonitor.ts";
import * as TraceDiagnostics from "./diagnostics/TraceDiagnostics.ts";
import * as SourceControlDiscovery from "./sourceControl/SourceControlDiscovery.ts";
import * as SourceControlRepositoryService from "./sourceControl/SourceControlRepositoryService.ts";
import * as AzureDevOpsCli from "./sourceControl/AzureDevOpsCli.ts";
import * as BitbucketApi from "./sourceControl/BitbucketApi.ts";
import * as GitHubCli from "./sourceControl/GitHubCli.ts";
import * as GitLabCli from "./sourceControl/GitLabCli.ts";
import * as SourceControlProviderRegistry from "./sourceControl/SourceControlProviderRegistry.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "./vcs/VcsDriverRegistry.ts";
import * as VcsProjectConfig from "./vcs/VcsProjectConfig.ts";
import * as VcsProcess from "./vcs/VcsProcess.ts";
import * as WslBearerAuth from "./transport/WslBearerAuth.ts";
const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);
const isSymphonyError = Schema.is(SymphonyError);

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

function unexpectedCompatibilityError(error: never): never {
  throw new Error(`Unhandled compatibility error: ${String(error)}`);
}

/** Preserve the setup runner's broader pre-refactor message normalization. */
function legacySetupFailureDescription(cause: unknown): string {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string"
  ) {
    return cause.message;
  }
  return String(cause);
}

function projectEntriesFailureContext(error: WorkspaceEntries.WorkspaceEntriesError): {
  readonly failure: ProjectEntriesFailure;
  readonly normalizedCwd?: string;
  readonly timeout?: string;
  readonly detail?: string;
} {
  switch (error._tag) {
    case "WorkspaceRootNotExistsError":
      return {
        failure: "workspace_root_not_found",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceRootCreateFailedError":
      return {
        failure: "workspace_root_create_failed",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceRootStatFailedError":
      return {
        failure: "workspace_root_stat_failed",
        normalizedCwd: error.normalizedWorkspaceRoot,
        detail: error.phase,
      };
    case "WorkspaceRootNotDirectoryError":
      return {
        failure: "workspace_root_not_directory",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceSearchIndexCreateFailed":
      return {
        failure: "search_index_create_failed",
        normalizedCwd: error.cwd,
        detail: error.reason,
      };
    case "WorkspaceSearchIndexScanTimedOut":
      return {
        failure: "search_index_scan_timed_out",
        normalizedCwd: error.cwd,
        timeout: error.timeout,
      };
    case "WorkspaceSearchIndexSearchFailed":
      return {
        failure: "search_index_search_failed",
        normalizedCwd: error.cwd,
        detail: error.reason,
      };
    default:
      return unexpectedCompatibilityError(error);
  }
}

function filesystemBrowseFailureContext(error: WorkspaceEntries.WorkspaceEntriesBrowseError): {
  readonly failure: FilesystemBrowseFailure;
  readonly parentPath?: string;
  readonly platform?: string;
} {
  switch (error._tag) {
    case "WorkspaceEntriesWindowsPathUnsupportedError":
      return { failure: "windows_path_unsupported", platform: error.platform };
    case "WorkspaceEntriesCurrentProjectRequiredError":
      return { failure: "current_project_required" };
    case "WorkspaceEntriesReadDirectoryError":
      return { failure: "read_directory_failed", parentPath: error.parentPath };
    default:
      return unexpectedCompatibilityError(error);
  }
}

function projectFileFailureContext(
  error:
    | WorkspaceFileSystem.WorkspaceFileSystemError
    | WorkspacePaths.WorkspacePathOutsideRootError,
): {
  readonly failure: ProjectFileFailure;
  readonly resolvedPath?: string;
  readonly resolvedWorkspaceRoot?: string;
  readonly operation?: ProjectFileOperation;
  readonly operationPath?: string;
} {
  switch (error._tag) {
    case "WorkspacePathOutsideRootError":
      return { failure: "workspace_path_outside_root" };
    case "WorkspaceFileSystemOperationError":
      return {
        failure: "operation_failed",
        resolvedPath: error.resolvedPath,
        operation: error.operation,
        operationPath: error.operationPath,
      };
    case "WorkspaceFilePathEscapeError":
      return {
        failure: "resolved_path_outside_root",
        resolvedPath: error.resolvedPath,
        resolvedWorkspaceRoot: error.resolvedWorkspaceRoot,
      };
    case "WorkspacePathNotFileError":
      return { failure: "path_not_file", resolvedPath: error.resolvedPath };
    case "WorkspaceBinaryFileError":
      return { failure: "binary_file", resolvedPath: error.resolvedPath };
    default:
      return unexpectedCompatibilityError(error);
  }
}

function projectSetupScriptCompatibilityDetail(
  error: ProjectSetupScriptRunner.ProjectSetupScriptRunnerError,
): string {
  switch (error._tag) {
    case "ProjectSetupScriptOperationError":
      return legacySetupFailureDescription(error.cause);
    case "ProjectSetupScriptProjectNotFoundError":
      return "Project was not found for setup script execution.";
    default:
      return unexpectedCompatibilityError(error);
  }
}

function isThreadDetailEvent(event: OrchestrationEvent): event is Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.message-sent"
      | "thread.proposed-plan-upserted"
      | "thread.activity-appended"
      | "thread.turn-diff-completed"
      | "thread.reverted"
      | "thread.session-set";
  }
> {
  return (
    event.type === "thread.message-sent" ||
    event.type === "thread.proposed-plan-upserted" ||
    event.type === "thread.activity-appended" ||
    event.type === "thread.turn-diff-completed" ||
    event.type === "thread.reverted" ||
    event.type === "thread.session-set"
  );
}

const PROVIDER_STATUS_DEBOUNCE_MS = 200;

// Maximum number of global events a resuming shell subscription may replay.
// Matches the event store's default page size (DEFAULT_READ_FROM_SEQUENCE_LIMIT).
const SHELL_RESUME_MAX_GAP = 1_000;

// Same bound for thread resume. The replay reads the *global* event range and
// filters per-thread afterwards, so a stale cursor far behind the head would
// otherwise decode every intervening event's payload; reconnects with cursors
// hundreds of thousands of events behind have OOM-killed servers on large
// databases. Past this gap the client is reset with a fresh thread snapshot.
const THREAD_RESUME_MAX_GAP = 1_000;

// Symphony Observe reads. These are read-only and never dispatch; the
// orchestrator records transient tracker errors in health rather than
// failing the request. When the orchestrator is not mounted (e.g. in
// harnesses that do not provide the Symphony layers), they return empty
// data rather than failing, so the socket surface stays inert.
const observeRpcEffect = <A, E, R>(
  method: string,
  effect: Effect.Effect<A, E, R>,
  traceAttributes?: Readonly<Record<string, unknown>>,
) => instrumentRpcEffect(method, effect, traceAttributes);

const observeRpcStream = <A, E, R>(
  method: string,
  stream: Stream.Stream<A, E, R>,
  traceAttributes?: Readonly<Record<string, unknown>>,
) => instrumentRpcStream(method, stream, traceAttributes);

const emptyOverview = (): Effect.Effect<SymphonyOverview> => {
  const unavailable = (reason: string): SymphonyOverview["running"] => ({
    state: "unavailable",
    reason,
  });
  return nowIso.pipe(
    Effect.map((generatedAt) => ({
      running: unavailable("Symphony orchestrator is unavailable."),
      queued: unavailable("Symphony orchestrator is unavailable."),
      needsAttention: unavailable("Symphony orchestrator is unavailable."),
      readyForReview: unavailable("Symphony orchestrator is unavailable."),
      retrying: unavailable("Symphony orchestrator is unavailable."),
      failedToday: unavailable("Symphony orchestrator is unavailable."),
      orchestratorPaused: null,
      activeWorkflowCount: unavailable("Symphony orchestrator is unavailable."),
      providerHealth: {},
      trackerHealth: {},
      lastTrackerPollAt: null,
      activeAgentCount: unavailable("Symphony orchestrator is unavailable."),
      generatedAt,
    })),
  );
};

// Resolve the Symphony orchestrator lazily per request so the RPC layer
// itself has no hard dependency on the Symphony layers. When they are not
// mounted, the Observe methods degrade to empty data instead of failing.
const withOrchestrator = <A, E, R>(
  run: (
    orchestrator: SymphonyOrchestrator.SymphonyOrchestrator["Service"],
  ) => Effect.Effect<A, E, R>,
  fallback: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.serviceOption(SymphonyOrchestrator.SymphonyOrchestrator).pipe(
    Effect.flatMap((maybe) => (Option.isSome(maybe) ? run(maybe.value) : fallback)),
  );

const withOrchestratorStream = <A, E, R>(
  run: (
    orchestrator: SymphonyOrchestrator.SymphonyOrchestrator["Service"],
  ) => Stream.Stream<A, E, R>,
  fallback: Stream.Stream<A, E, R>,
): Stream.Stream<A, E, R> =>
  Stream.fromEffect(
    Effect.serviceOption(SymphonyOrchestrator.SymphonyOrchestrator).pipe(
      Effect.map((maybe) =>
        Option.isSome(maybe)
          ? (maybe.value as SymphonyOrchestrator.SymphonyOrchestrator["Service"])
          : null,
      ),
    ),
  ).pipe(Stream.flatMap((orchestrator) => (orchestrator === null ? fallback : run(orchestrator))));
const withApprovalService = <A, E>(
  run: (approvals: ApprovalService.ApprovalService["Service"]) => Effect.Effect<A, E>,
  fallback: Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  Effect.serviceOption(ApprovalService.ApprovalService).pipe(
    Effect.flatMap((maybe) => (Option.isSome(maybe) ? run(maybe.value) : fallback)),
  );
const approvalError = (message: string): SymphonyError =>
  new SymphonyError({ code: "approval_request_not_found", message });

/** Actions must not report success when the Symphony layer is absent. */
const orchestratorUnavailable = (): SymphonyError =>
  new SymphonyError({ code: "symphony_unavailable", message: "symphony layer is not mounted" });

const projectError = (code: string, message: string): SymphonyError =>
  new SymphonyError({ code, message });

const requireProject = <A>(value: A | null, code: string, message: string) =>
  value === null ? Effect.fail(projectError(code, message)) : Effect.succeed(value);

const withHandoffService = <A, E>(
  run: (handoff: HandoffService.HandoffService["Service"]) => Effect.Effect<A, E>,
  fallback: Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  Effect.serviceOption(HandoffService.HandoffService).pipe(
    Effect.flatMap((maybe) => (Option.isSome(maybe) ? run(maybe.value) : fallback)),
  );
const handoffError = (message: string): SymphonyError =>
  new SymphonyError({ code: "symphony_handoff_failed", message });

export const makeSymphonyRpcHandlers = () => ({
  [SYMPHONY_WS_METHODS.subscribeOverview]: () =>
    observeRpcStream(
      SYMPHONY_WS_METHODS.subscribeOverview,
      withOrchestratorStream(
        (orchestrator) =>
          Stream.fromEffect(
            orchestrator
              .getOverview()
              .pipe(
                Effect.map((overview) => ({ version: 1, type: "overview", overview }) as const),
              ),
          ).pipe(Stream.repeat(Schedule.fixed("2 seconds"))),
        Stream.empty,
      ),
      { "rpc.aggregate": "symphony" },
    ),
  [SYMPHONY_WS_METHODS.subscribeRuns]: () =>
    observeRpcStream(
      SYMPHONY_WS_METHODS.subscribeRuns,
      withOrchestratorStream(
        (orchestrator) =>
          Stream.fromEffect(
            orchestrator
              .listRuns({})
              .pipe(Effect.map((runs) => ({ version: 1, type: "runs", runs }) as const)),
          ).pipe(Stream.repeat(Schedule.fixed("2 seconds"))),
        Stream.empty,
      ),
      { "rpc.aggregate": "symphony" },
    ),
  [SYMPHONY_WS_METHODS.subscribeQueue]: () =>
    observeRpcStream(
      SYMPHONY_WS_METHODS.subscribeQueue,
      withOrchestratorStream(
        (orchestrator) =>
          Stream.fromEffect(
            orchestrator
              .listQueue({})
              .pipe(Effect.map((items) => ({ version: 1, type: "queue", items }) as const)),
          ).pipe(Stream.repeat(Schedule.fixed("2 seconds"))),
        Stream.empty,
      ),
      { "rpc.aggregate": "symphony" },
    ),
  [SYMPHONY_WS_METHODS.subscribeAttention]: () =>
    observeRpcStream(
      SYMPHONY_WS_METHODS.subscribeAttention,
      withOrchestratorStream(
        (orchestrator) =>
          Stream.fromEffect(
            orchestrator
              .listAttention()
              .pipe(Effect.map((items) => ({ version: 1, type: "attention", items }) as const)),
          ).pipe(Stream.repeat(Schedule.fixed("2 seconds"))),
        Stream.empty,
      ),
      { "rpc.aggregate": "symphony" },
    ),
  [SYMPHONY_WS_METHODS.subscribeProjectBoard]: (
    input: (typeof SymphonyGetProjectBoardInput)["Type"],
  ) =>
    observeRpcStream(
      SYMPHONY_WS_METHODS.subscribeProjectBoard,
      withOrchestratorStream(
        (orchestrator) =>
          Stream.fromEffect(
            orchestrator.getProjectBoard(input.projectId).pipe(
              Effect.flatMap((board) =>
                requireProject(
                  board,
                  "symphony_project_not_found",
                  `Symphony project ${input.projectId} was not found.`,
                ),
              ),
              Effect.map((board) => ({ version: 1, type: "projectBoard", board }) as const),
            ),
          ).pipe(Stream.repeat(Schedule.fixed("2 seconds"))),
        Stream.empty,
      ),
      { "rpc.aggregate": "symphony" },
    ),
  [SYMPHONY_WS_METHODS.subscribeRunEvents]: (input: (typeof SymphonyGetRunInput)["Type"]) =>
    observeRpcStream(
      SYMPHONY_WS_METHODS.subscribeRunEvents,
      withOrchestratorStream(
        (orchestrator) =>
          Stream.fromEffect(
            orchestrator
              .listRunEvents(input.runAttemptId)
              .pipe(
                Effect.map((events) =>
                  events.map((runEvent) => ({ version: 1, type: "runEvent", runEvent }) as const),
                ),
              ),
          ).pipe(
            Stream.flatMap((events) => Stream.fromIterable(events)),
            Stream.repeat(Schedule.fixed("2 seconds")),
          ),
        Stream.empty,
      ),
      { "rpc.aggregate": "symphony" },
    ),
  [SYMPHONY_WS_METHODS.getOverview]: () =>
    observeRpcEffect(
      SYMPHONY_WS_METHODS.getOverview,
      withOrchestrator((orchestrator) => orchestrator.getOverview(), emptyOverview()),
      { "rpc.aggregate": "symphony" },
    ),
  [SYMPHONY_WS_METHODS.listQueue]: (input: (typeof SymphonyListQueueInput)["Type"]) =>
    observeRpcEffect(
      SYMPHONY_WS_METHODS.listQueue,
      withOrchestrator((orchestrator) => orchestrator.listQueue(input), Effect.succeed([])),
      { "rpc.aggregate": "symphony" },
    ),
  [SYMPHONY_WS_METHODS.listRuns]: (input: (typeof SymphonyListRunsInput)["Type"]) =>
    observeRpcEffect(
      SYMPHONY_WS_METHODS.listRuns,
      withOrchestrator((orchestrator) => orchestrator.listRuns(input), Effect.succeed([])),
      { "rpc.aggregate": "symphony" },
    ),
  [SYMPHONY_WS_METHODS.getRun]: (input: (typeof SymphonyGetRunInput)["Type"]) =>
    observeRpcEffect(
      SYMPHONY_WS_METHODS.getRun,
      withOrchestrator(
        (orchestrator) => orchestrator.getRun(input.runAttemptId),
        Effect.succeed(null),
      ),
      { "rpc.aggregate": "symphony" },
    ),
  [SYMPHONY_WS_METHODS.listProjects]: (_input: (typeof SymphonyListProjectsInput)["Type"]) =>
    observeRpcEffect(
      SYMPHONY_WS_METHODS.listProjects,
      withOrchestrator((orchestrator) => orchestrator.listProjects(), Effect.succeed([])),
      { "rpc.aggregate": "symphony" },
    ),
  [SYMPHONY_WS_METHODS.getProject]: (input: (typeof SymphonyGetProjectInput)["Type"]) =>
    observeRpcEffect(
      SYMPHONY_WS_METHODS.getProject,
      withOrchestrator(
        (orchestrator) => orchestrator.getProject(input.projectId),
        Effect.fail(orchestratorUnavailable()),
      ),
      { "rpc.aggregate": "symphony" },
    ),
  [SYMPHONY_WS_METHODS.createProject]: (input: (typeof SymphonyCreateProjectInput)["Type"]) =>
    observeRpcEffect(
      SYMPHONY_WS_METHODS.createProject,
      withOrchestrator(
        (orchestrator) =>
          Effect.gen(function* () {
            const projection = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
            const shell = yield* projection
              .getProjectShellById(ProjectId.make(input.codeProjectId))
              .pipe(
                Effect.mapError((cause) =>
                  projectError("symphony_project_create_failed", cause.message),
                ),
              );
            if (Option.isNone(shell)) {
              return yield* Effect.fail(
                projectError(
                  "symphony_code_project_not_found",
                  `Code project ${input.codeProjectId} was not found.`,
                ),
              );
            }
            const crypto = yield* Crypto.Crypto;
            const id = yield* crypto.randomUUIDv4.pipe(
              Effect.map(SymphonyProjectId.make),
              Effect.mapError((cause) =>
                projectError("symphony_project_create_failed", String(cause)),
              ),
            );
            return yield* orchestrator
              .createProject({
                id,
                codeProjectId: String(shell.value.id),
                title: input.title ?? shell.value.title,
                repositoryPath: shell.value.workspaceRoot,
                configuration: input.configuration,
                now: yield* nowIso,
              })
              .pipe(
                Effect.mapError((cause) =>
                  projectError("symphony_project_create_failed", cause.message),
                ),
              );
          }),
        Effect.fail(orchestratorUnavailable()),
      ),
      { "rpc.aggregate": "symphony" },
    ),
  [SYMPHONY_WS_METHODS.updateProject]: (input: (typeof SymphonyUpdateProjectInput)["Type"]) =>
    observeRpcEffect(
      SYMPHONY_WS_METHODS.updateProject,
      withOrchestrator(
        (orchestrator) =>
          nowIso
            .pipe(
              Effect.flatMap((now) =>
                orchestrator.updateProject({
                  projectId: input.projectId,
                  expectedRevision: input.expectedRevision,
                  ...(input.title === undefined ? {} : { title: input.title }),
                  ...(input.configuration === undefined
                    ? {}
                    : { configuration: input.configuration }),
                  now,
                }),
              ),
            )
            .pipe(
              Effect.flatMap((project) =>
                requireProject(
                  project,
                  "symphony_project_revision_conflict",
                  "The project changed. Refresh and retry.",
                ),
              ),
              Effect.mapError((cause) =>
                isSymphonyError(cause)
                  ? cause
                  : projectError("symphony_project_update_failed", cause.message),
              ),
            ),
        Effect.fail(orchestratorUnavailable()),
      ),
      { "rpc.aggregate": "symphony" },
    ),
  [SYMPHONY_WS_METHODS.startProject]: (input: (typeof SymphonyStartProjectInput)["Type"]) =>
    observeRpcEffect(
      SYMPHONY_WS_METHODS.startProject,
      withOrchestrator(
        (orchestrator) =>
          Effect.gen(function* () {
            const project = yield* orchestrator
              .getProject(input.projectId)
              .pipe(
                Effect.flatMap((value) =>
                  requireProject(
                    value,
                    "symphony_project_not_found",
                    `Symphony project ${input.projectId} was not found.`,
                  ),
                ),
              );
            if (project.setupState !== "ready" || project.configuration === null) {
              return yield* Effect.fail(
                projectError(
                  "symphony_project_needs_setup",
                  "Complete the tracker and runtime settings before starting this project.",
                ),
              );
            }
            if (project.configuration.autonomy === "deliver") {
              const board = yield* orchestrator
                .getProjectBoard(project.id)
                .pipe(
                  Effect.flatMap((value) =>
                    requireProject(
                      value,
                      "symphony_project_not_found",
                      `Symphony project ${input.projectId} was not found.`,
                    ),
                  ),
                );
              if (board.sourceControl.state !== "known" || board.sourceControl.provider === null) {
                return yield* Effect.fail(
                  projectError(
                    "symphony_delivery_unavailable",
                    "Deliver mode requires a recognised source-control remote.",
                  ),
                );
              }
              const discovery = yield* SourceControlDiscovery.SourceControlDiscovery;
              const providers = yield* discovery.discover;
              const providerKind = board.sourceControl.provider;
              const provider = providers.sourceControlProviders.find(
                (candidate) => candidate.kind === providerKind,
              );
              if (provider?.auth.status !== "authenticated") {
                return yield* Effect.fail(
                  projectError(
                    "symphony_delivery_unauthenticated",
                    "Authenticate the repository's source-control provider before using Deliver mode.",
                  ),
                );
              }
            }
            const updated = yield* orchestrator.updateProject({
              projectId: project.id,
              expectedRevision: input.expectedRevision,
              status: "active",
              now: yield* nowIso,
            });
            return yield* requireProject(
              updated,
              "symphony_project_revision_conflict",
              "The project changed. Refresh and retry.",
            );
          }).pipe(
            Effect.mapError((cause) =>
              isSymphonyError(cause)
                ? cause
                : projectError("symphony_project_start_failed", cause.message),
            ),
          ),
        Effect.fail(orchestratorUnavailable()),
      ),
      { "rpc.aggregate": "symphony" },
    ),
  [SYMPHONY_WS_METHODS.pauseProject]: (input: (typeof SymphonyPauseProjectInput)["Type"]) =>
    observeRpcEffect(
      SYMPHONY_WS_METHODS.pauseProject,
      withOrchestrator(
        (orchestrator) =>
          nowIso
            .pipe(
              Effect.flatMap((now) =>
                orchestrator.updateProject({
                  projectId: input.projectId,
                  expectedRevision: input.expectedRevision,
                  status: "paused",
                  now,
                }),
              ),
            )
            .pipe(
              Effect.flatMap((project) =>
                requireProject(
                  project,
                  "symphony_project_revision_conflict",
                  "The project changed. Refresh and retry.",
                ),
              ),
              Effect.mapError((cause) =>
                isSymphonyError(cause)
                  ? cause
                  : projectError("symphony_project_pause_failed", cause.message),
              ),
            ),
        Effect.fail(orchestratorUnavailable()),
      ),
      { "rpc.aggregate": "symphony" },
    ),
  [SYMPHONY_WS_METHODS.getProjectBoard]: (input: (typeof SymphonyGetProjectBoardInput)["Type"]) =>
    observeRpcEffect(
      SYMPHONY_WS_METHODS.getProjectBoard,
      withOrchestrator(
        (orchestrator) =>
          orchestrator
            .getProjectBoard(input.projectId)
            .pipe(
              Effect.flatMap((board) =>
                requireProject(
                  board,
                  "symphony_project_not_found",
                  `Symphony project ${input.projectId} was not found.`,
                ),
              ),
            ),
        Effect.fail(orchestratorUnavailable()),
      ),
      { "rpc.aggregate": "symphony" },
    ),
  [SYMPHONY_WS_METHODS.listAttention]: (input: (typeof SymphonyListAttentionInput)["Type"]) =>
    observeRpcEffect(
      SYMPHONY_WS_METHODS.listAttention,
      withOrchestrator((orchestrator) => orchestrator.listAttention(input), Effect.succeed([])),
      { "rpc.aggregate": "symphony" },
    ),
  [SYMPHONY_WS_METHODS.listWorkflows]: () =>
    observeRpcEffect(
      SYMPHONY_WS_METHODS.listWorkflows,
      withOrchestrator((orchestrator) => orchestrator.listWorkflows(), Effect.succeed([])),
      { "rpc.aggregate": "symphony" },
    ),
  [SYMPHONY_WS_METHODS.getWorkflow]: (input: (typeof SymphonyGetWorkflowInput)["Type"]) =>
    observeRpcEffect(
      SYMPHONY_WS_METHODS.getWorkflow,
      withOrchestrator(
        (orchestrator) => orchestrator.getWorkflow(String(input.workflowId)),
        Effect.fail(orchestratorUnavailable()),
      ),
      { "rpc.aggregate": "symphony" },
    ),
  [SYMPHONY_WS_METHODS.listTrackers]: () =>
    observeRpcEffect(
      SYMPHONY_WS_METHODS.listTrackers,
      withOrchestrator((orchestrator) => orchestrator.listTrackers(), Effect.succeed([])),
      { "rpc.aggregate": "symphony" },
    ),
  [SYMPHONY_WS_METHODS.listHistory]: (input: (typeof SymphonyListHistoryInput)["Type"]) =>
    observeRpcEffect(
      SYMPHONY_WS_METHODS.listHistory,
      withOrchestrator((orchestrator) => orchestrator.listHistory(input), Effect.succeed([])),
      { "rpc.aggregate": "symphony" },
    ),
  [SYMPHONY_WS_METHODS.resolveAttention]: (input: (typeof SymphonyResolveAttentionInput)["Type"]) =>
    observeRpcEffect(
      SYMPHONY_WS_METHODS.resolveAttention,
      withOrchestrator(
        (orchestrator) =>
          orchestrator
            .resolveAttention(String(input.attentionItemId), "resolved via RPC")
            .pipe(Effect.map((resolved) => ({ ok: resolved }))),
        Effect.fail(orchestratorUnavailable()),
      ),
      { "rpc.aggregate": "symphony" },
    ),
  [SYMPHONY_WS_METHODS.validateWorkflow]: (input: (typeof SymphonyValidateWorkflowInput)["Type"]) =>
    observeRpcEffect(
      SYMPHONY_WS_METHODS.validateWorkflow,
      // Real validation (audit item 8: was an {ok:true} stub): load and
      // parse WORKFLOW.md; a validation failure records the workflow as
      // `invalid` and returns ok:false.
      Effect.serviceOption(WorkflowLoaderService).pipe(
        Effect.flatMap((maybe) =>
          Option.isSome(maybe)
            ? maybe.value
                .loadWorkflow({
                  repositoryPath: input.repositoryPath,
                })
                .pipe(
                  Effect.map((result) => ({ ok: result.errors.length === 0 })),
                  Effect.catch(() => Effect.succeed({ ok: false })),
                )
            : Effect.succeed({ ok: false }),
        ),
      ),
      { "rpc.aggregate": "symphony" },
    ),
  // In-app workflow editor (PRD 12.3, pragmatic v1). Both resolve the file
  // path from the persisted WorkflowRecord inside WorkflowLoaderService,
  // never from client input.
  [SYMPHONY_WS_METHODS.getWorkflowContent]: (
    input: (typeof SymphonyGetWorkflowContentInput)["Type"],
  ) =>
    observeRpcEffect(
      SYMPHONY_WS_METHODS.getWorkflowContent,
      Effect.serviceOption(WorkflowLoaderService).pipe(
        Effect.flatMap((maybe) =>
          Option.isSome(maybe)
            ? maybe.value.getWorkflowContent(input.workflowId).pipe(
                Effect.mapError(
                  (cause) =>
                    new SymphonyError({
                      code: "workflow_content_unavailable",
                      message: cause.message,
                    }),
                ),
              )
            : Effect.fail(orchestratorUnavailable()),
        ),
      ),
      { "rpc.aggregate": "symphony" },
    ),
  [SYMPHONY_WS_METHODS.saveWorkflowContent]: (
    input: (typeof SymphonySaveWorkflowContentInput)["Type"],
  ) =>
    observeRpcEffect(
      SYMPHONY_WS_METHODS.saveWorkflowContent,
      Effect.serviceOption(WorkflowLoaderService).pipe(
        Effect.flatMap((maybe) =>
          Option.isSome(maybe)
            ? maybe.value
                .saveWorkflowContent(input.workflowId, input.content)
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new SymphonyError({ code: "workflow_save_failed", message: cause.message }),
                  ),
                )
            : Effect.fail(orchestratorUnavailable()),
        ),
      ),
      { "rpc.aggregate": "symphony" },
    ),
  // "New workflow" dialog: `repositoryPath` is client-supplied, so unlike
  // every other workflow RPC above it is never trusted directly. It is
  // checked against ProjectionSnapshotQuery — the same read model the
  // client's own project list is built from — before any filesystem write
  // happens; an unrecognised path is refused rather than treated as a
  // filesystem location.
  [SYMPHONY_WS_METHODS.createWorkflow]: (input: (typeof SymphonyCreateWorkflowInput)["Type"]) =>
    observeRpcEffect(
      SYMPHONY_WS_METHODS.createWorkflow,
      Effect.gen(function* () {
        const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
        const project = yield* projectionSnapshotQuery
          .getActiveProjectByWorkspaceRoot(input.repositoryPath)
          .pipe(
            Effect.mapError(
              (cause) =>
                new SymphonyError({ code: "workflow_create_failed", message: cause.message }),
            ),
          );
        if (Option.isNone(project)) {
          return yield* Effect.fail(
            new SymphonyError({
              code: "workflow_create_invalid_repository",
              message: `Not a tracked project root: ${input.repositoryPath}`,
            }),
          );
        }
        const maybeLoader = yield* Effect.serviceOption(WorkflowLoaderService);
        if (Option.isNone(maybeLoader)) {
          return yield* Effect.fail(orchestratorUnavailable());
        }
        const result = yield* maybeLoader.value
          .createWorkflow({ repositoryPath: input.repositoryPath, content: input.content })
          .pipe(
            Effect.mapError(
              (cause) =>
                new SymphonyError({ code: "workflow_create_failed", message: cause.message }),
            ),
          );
        return { ok: true, ...result };
      }),
      { "rpc.aggregate": "symphony" },
    ),
  [SYMPHONY_WS_METHODS.activateWorkflow]: (input: (typeof SymphonyActivateWorkflowInput)["Type"]) =>
    observeRpcEffect(
      SYMPHONY_WS_METHODS.activateWorkflow,
      // Real activation (audit item 8): load the workflow and mark it
      // active so the poll loop starts dispatching from it.
      Effect.serviceOption(WorkflowLoaderService).pipe(
        Effect.flatMap((maybe) =>
          Option.isSome(maybe)
            ? maybe.value.loadWorkflow({ repositoryPath: input.repositoryPath }).pipe(
                Effect.map((result) => ({ ok: result.errors.length === 0 })),
                Effect.catch(() => Effect.succeed({ ok: false })),
              )
            : Effect.succeed({ ok: false }),
        ),
      ),
      { "rpc.aggregate": "symphony" },
    ),
  [SYMPHONY_WS_METHODS.approve]: (input: (typeof SymphonyApproveInput)["Type"]) =>
    observeRpcEffect(
      SYMPHONY_WS_METHODS.approve,
      withApprovalService(
        (approvals) =>
          approvals.approve(input.requestId).pipe(
            Effect.mapError((cause) => approvalError(cause.message)),
            Effect.as({ ok: true }),
          ),
        Effect.succeed({ ok: true }),
      ),
      { "rpc.aggregate": "symphony" },
    ),
  [SYMPHONY_WS_METHODS.reject]: (input: (typeof SymphonyRejectInput)["Type"]) =>
    observeRpcEffect(
      SYMPHONY_WS_METHODS.reject,
      withApprovalService(
        (approvals) =>
          approvals.reject(input.requestId, input.reason).pipe(
            Effect.mapError((cause) => approvalError(cause.message)),
            Effect.as({ ok: true }),
          ),
        Effect.succeed({ ok: true }),
      ),
      { "rpc.aggregate": "symphony" },
    ),
  [SYMPHONY_WS_METHODS.respondToUserInput]: (
    input: (typeof SymphonyRespondToUserInputInput)["Type"],
  ) =>
    observeRpcEffect(
      SYMPHONY_WS_METHODS.respondToUserInput,
      withApprovalService(
        (approvals) =>
          approvals.respondToUserInput(input.requestId, input.text).pipe(
            Effect.mapError((cause) => approvalError(cause.message)),
            Effect.as({ ok: true }),
          ),
        Effect.succeed({ ok: true }),
      ),
      { "rpc.aggregate": "symphony" },
    ),
  [SYMPHONY_WS_METHODS.excludeWorkItem]: (input: (typeof SymphonyExcludeWorkItemInput)["Type"]) =>
    observeRpcEffect(
      SYMPHONY_WS_METHODS.excludeWorkItem,
      withOrchestrator(
        (orchestrator) =>
          orchestrator
            .excludeWorkItem(input.workItemId, input.exclude)
            .pipe(Effect.as({ ok: true })),
        Effect.succeed({ ok: true }),
      ),
      { "rpc.aggregate": "symphony" },
    ),
  [SYMPHONY_WS_METHODS.includeWorkItem]: (input: (typeof SymphonyIncludeWorkItemInput)["Type"]) =>
    observeRpcEffect(
      SYMPHONY_WS_METHODS.includeWorkItem,
      withOrchestrator(
        (orchestrator) =>
          orchestrator.includeWorkItem(input.workItemId).pipe(Effect.as({ ok: true })),
        Effect.succeed({ ok: true }),
      ),
      { "rpc.aggregate": "symphony" },
    ),
  [SYMPHONY_WS_METHODS.setLocalPriority]: (input: (typeof SymphonySetLocalPriorityInput)["Type"]) =>
    observeRpcEffect(
      SYMPHONY_WS_METHODS.setLocalPriority,
      withOrchestrator(
        (orchestrator) =>
          orchestrator
            .setLocalPriority(input.workItemId, input.priority)
            .pipe(Effect.as({ ok: true })),
        Effect.succeed({ ok: true }),
      ),
      { "rpc.aggregate": "symphony" },
    ),
  [SYMPHONY_WS_METHODS.dispatchWorkItem]: (input: (typeof SymphonyDispatchWorkItemInput)["Type"]) =>
    observeRpcEffect(
      SYMPHONY_WS_METHODS.dispatchWorkItem,
      withOrchestrator(
        (orchestrator) =>
          orchestrator.dispatchWorkItem(input.workItemId).pipe(Effect.as({ ok: true })),
        Effect.fail(orchestratorUnavailable()),
      ),
      { "rpc.aggregate": "symphony" },
    ),
  [SYMPHONY_WS_METHODS.cancelRun]: (input: (typeof SymphonyCancelRunInput)["Type"]) =>
    observeRpcEffect(
      SYMPHONY_WS_METHODS.cancelRun,
      withOrchestrator(
        (orchestrator) => orchestrator.cancelRun(input.runAttemptId).pipe(Effect.as({ ok: true })),
        Effect.fail(orchestratorUnavailable()),
      ),
      { "rpc.aggregate": "symphony" },
    ),
  [SYMPHONY_WS_METHODS.pauseWorkflow]: (input: (typeof SymphonyPauseWorkflowInput)["Type"]) =>
    observeRpcEffect(
      SYMPHONY_WS_METHODS.pauseWorkflow,
      withOrchestrator(
        (orchestrator) =>
          orchestrator
            .setWorkflowPaused(String(input.workflowId), true)
            .pipe(Effect.as({ ok: true })),
        Effect.fail(orchestratorUnavailable()),
      ),
      { "rpc.aggregate": "symphony" },
    ),
  [SYMPHONY_WS_METHODS.resumeWorkflow]: (input: (typeof SymphonyResumeWorkflowInput)["Type"]) =>
    observeRpcEffect(
      SYMPHONY_WS_METHODS.resumeWorkflow,
      withOrchestrator(
        (orchestrator) =>
          orchestrator
            .setWorkflowPaused(String(input.workflowId), false)
            .pipe(Effect.as({ ok: true })),
        Effect.fail(orchestratorUnavailable()),
      ),
      { "rpc.aggregate": "symphony" },
    ),
  [SYMPHONY_WS_METHODS.pauseRepository]: (input: (typeof SymphonyPauseRepositoryInput)["Type"]) =>
    observeRpcEffect(
      SYMPHONY_WS_METHODS.pauseRepository,
      withOrchestrator(
        (orchestrator) =>
          orchestrator
            .setRepositoryPaused(input.repositoryPath, true)
            .pipe(Effect.as({ ok: true })),
        Effect.fail(orchestratorUnavailable()),
      ),
      { "rpc.aggregate": "symphony" },
    ),
  [SYMPHONY_WS_METHODS.resumeRepository]: (input: (typeof SymphonyResumeRepositoryInput)["Type"]) =>
    observeRpcEffect(
      SYMPHONY_WS_METHODS.resumeRepository,
      withOrchestrator(
        (orchestrator) =>
          orchestrator
            .setRepositoryPaused(input.repositoryPath, false)
            .pipe(Effect.as({ ok: true })),
        Effect.fail(orchestratorUnavailable()),
      ),
      { "rpc.aggregate": "symphony" },
    ),
  [SYMPHONY_WS_METHODS.pauseGlobal]: () =>
    observeRpcEffect(
      SYMPHONY_WS_METHODS.pauseGlobal,
      withOrchestrator(
        (orchestrator) => orchestrator.setGlobalPaused(true).pipe(Effect.as({ ok: true })),
        Effect.fail(orchestratorUnavailable()),
      ),
      { "rpc.aggregate": "symphony" },
    ),
  [SYMPHONY_WS_METHODS.resumeGlobal]: () =>
    observeRpcEffect(
      SYMPHONY_WS_METHODS.resumeGlobal,
      withOrchestrator(
        (orchestrator) => orchestrator.setGlobalPaused(false).pipe(Effect.as({ ok: true })),
        Effect.fail(orchestratorUnavailable()),
      ),
      { "rpc.aggregate": "symphony" },
    ),
  [SYMPHONY_WS_METHODS.stopAllRuns]: (input: (typeof SymphonyStopAllRunsInput)["Type"]) =>
    observeRpcEffect(
      SYMPHONY_WS_METHODS.stopAllRuns,
      // FR-134: the confirm literal is required at the RPC boundary.
      input.confirm === "stop-all-runs"
        ? withOrchestrator(
            (orchestrator) =>
              orchestrator.stopAllRuns().pipe(Effect.map((stopped) => ({ ok: stopped > 0 }))),
            Effect.fail(orchestratorUnavailable()),
          )
        : Effect.fail(
            new SymphonyError({ code: "symphony_handoff_failed", message: "confirm required" }),
          ),
      { "rpc.aggregate": "symphony" },
    ),
  [SYMPHONY_WS_METHODS.requestChanges]: (input: (typeof SymphonyRequestChangesInput)["Type"]) =>
    observeRpcEffect(
      SYMPHONY_WS_METHODS.requestChanges,
      withOrchestrator(
        // The boolean result is the gate outcome: report it as `ok` rather
        // than always claiming success (REVIEW P2 #3).
        (orchestrator) =>
          orchestrator
            .requestChanges(input.workItemId, input.reason)
            .pipe(Effect.map((changed) => ({ ok: changed }))),
        Effect.fail(orchestratorUnavailable()),
      ),
      { "rpc.aggregate": "symphony" },
    ),
  [SYMPHONY_WS_METHODS.refreshPullRequest]: (
    input: (typeof SymphonyRefreshPullRequestInput)["Type"],
  ) =>
    observeRpcEffect(
      SYMPHONY_WS_METHODS.refreshPullRequest,
      withOrchestrator(
        // Boolean result = whether stored evidence changed; report it as ok
        // so the client can distinguish refreshed from no-op.
        (orchestrator) =>
          orchestrator
            .refreshPullRequest(input.workItemId)
            .pipe(Effect.map((changed) => ({ ok: changed }))),
        Effect.fail(orchestratorUnavailable()),
      ),
      { "rpc.aggregate": "symphony" },
    ),
  [SYMPHONY_WS_METHODS.approveMerge]: (input: (typeof SymphonyApproveMergeInput)["Type"]) =>
    observeRpcEffect(
      SYMPHONY_WS_METHODS.approveMerge,
      withOrchestrator(
        (orchestrator) =>
          orchestrator
            .approveMerge(input.workItemId)
            .pipe(Effect.map((changed) => ({ ok: changed }))),
        Effect.fail(orchestratorUnavailable()),
      ),
      { "rpc.aggregate": "symphony" },
    ),
  [SYMPHONY_WS_METHODS.takeOver]: (input: (typeof SymphonyTakeOverInput)["Type"]) =>
    observeRpcEffect(
      SYMPHONY_WS_METHODS.takeOver,
      withHandoffService(
        (handoff) =>
          handoff
            .takeOver({ runAttemptId: input.runAttemptId })
            .pipe(Effect.mapError((cause) => handoffError(cause.message))),
        // The Symphony layer is not mounted: report unavailable rather than
        // a fabricated success (REVIEW P2).
        Effect.fail(handoffError("symphony layer is not mounted")),
      ),
      { "rpc.aggregate": "symphony" },
    ),
  [SYMPHONY_WS_METHODS.resumeAutonomous]: (input: (typeof SymphonyResumeAutonomousInput)["Type"]) =>
    observeRpcEffect(
      SYMPHONY_WS_METHODS.resumeAutonomous,
      withHandoffService(
        (handoff) =>
          handoff.resumeAutonomous({ workItemId: input.workItemId }).pipe(
            Effect.mapError((cause) => handoffError(cause.message)),
            Effect.as({ ok: true }),
          ),
        Effect.fail(handoffError("symphony layer is not mounted")),
      ),
      { "rpc.aggregate": "symphony" },
    ),
  [SYMPHONY_WS_METHODS.delegateFromThread]: (
    input: (typeof SymphonyDelegateFromThreadInput)["Type"],
  ) =>
    observeRpcEffect(
      SYMPHONY_WS_METHODS.delegateFromThread,
      withHandoffService(
        (handoff) =>
          handoff
            .delegateFromThread({
              threadId: input.threadId,
              objective: input.objective,
              ...(input.repositoryPath !== undefined
                ? { repositoryPath: input.repositoryPath }
                : {}),
              ...(input.branch !== undefined ? { branch: input.branch } : {}),
              ...(input.summary !== undefined ? { summary: input.summary } : {}),
              ...(input.acceptanceCriteria !== undefined
                ? { acceptanceCriteria: input.acceptanceCriteria }
                : {}),
            })
            .pipe(
              Effect.map((workItemId) => ({ workItemId })),
              Effect.mapError((cause) => handoffError(cause.message)),
            ),
        Effect.fail(handoffError("symphony layer is not mounted")),
      ),
      { "rpc.aggregate": "symphony" },
    ),
});

const makeWsRpcLayer = (
  previewAutomationBroker: PreviewAutomationBroker.PreviewAutomationBroker["Service"],
) =>
  WsRpcGroup.toLayer(
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
      const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
      const checkpointDiffQuery = yield* CheckpointDiffQuery.CheckpointDiffQuery;
      const keybindings = yield* Keybindings.Keybindings;
      const externalLauncher = yield* ExternalLauncher.ExternalLauncher;
      const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
      const review = yield* ReviewService.ReviewService;
      const vcsProvisioning = yield* VcsProvisioningService.VcsProvisioningService;
      const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const terminalManager = yield* TerminalManager.TerminalManager;
      const previewManager = yield* PreviewManager.PreviewManager;
      const portDiscovery = yield* PortScanner.PortDiscovery;
      const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
      const providerMaintenanceRunner = yield* ProviderMaintenanceRunner.ProviderMaintenanceRunner;
      const config = yield* ServerConfig.ServerConfig;
      const lifecycleEvents = yield* ServerLifecycleEvents.ServerLifecycleEvents;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
      const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
      const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
      const projectSetupScriptRunner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
      const sourceControlDiscovery = yield* SourceControlDiscovery.SourceControlDiscovery;
      const automaticGitFetchInterval = serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.automaticGitFetchInterval),
        Effect.catch((cause) =>
          Effect.logWarning("Failed to read automatic Git fetch interval setting", {
            detail: cause.message,
          }).pipe(Effect.as(DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL)),
        ),
      );
      const sourceControlRepositories =
        yield* SourceControlRepositoryService.SourceControlRepositoryService;
      const processDiagnostics = yield* ProcessDiagnostics.ProcessDiagnostics;
      const processResourceMonitor = yield* ProcessResourceMonitor.ProcessResourceMonitor;
      const observeRpcEffect = <A, E, R>(
        method: string,
        effect: Effect.Effect<A, E, R>,
        traceAttributes?: Readonly<Record<string, unknown>>,
      ) => instrumentRpcEffect(method, effect, traceAttributes);
      const observeRpcStream = <A, E, R>(
        method: string,
        stream: Stream.Stream<A, E, R>,
        traceAttributes?: Readonly<Record<string, unknown>>,
      ) => instrumentRpcStream(method, stream, traceAttributes);
      const observeRpcStreamEffect = <A, StreamError, StreamContext, EffectError, EffectContext>(
        method: string,
        effect: Effect.Effect<
          Stream.Stream<A, StreamError, StreamContext>,
          EffectError,
          EffectContext
        >,
        traceAttributes?: Readonly<Record<string, unknown>>,
      ) => instrumentRpcStreamEffect(method, effect, traceAttributes);
      const toDispatchCommandError = (cause: unknown, fallbackMessage: string) =>
        isOrchestrationDispatchCommandError(cause)
          ? cause
          : new OrchestrationDispatchCommandError({
              message: cause instanceof Error ? cause.message : fallbackMessage,
              cause,
            });
      const randomUUID = crypto.randomUUIDv4.pipe(
        Effect.mapError((cause) =>
          toDispatchCommandError(cause, "Failed to generate orchestration command identifier."),
        ),
      );
      const serverEventId = randomUUID.pipe(Effect.map(EventId.make));
      const serverCommandId = (tag: string) =>
        randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));

      const appendSetupScriptActivity = (input: {
        readonly threadId: ThreadId;
        readonly kind: "setup-script.requested" | "setup-script.started" | "setup-script.failed";
        readonly summary: string;
        readonly createdAt: string;
        readonly payload: Record<string, unknown>;
        readonly tone: "info" | "error";
      }) =>
        Effect.all({
          commandId: serverCommandId("setup-script-activity"),
          activityId: serverEventId,
        }).pipe(
          Effect.flatMap(({ commandId, activityId }) =>
            orchestrationEngine.dispatch({
              type: "thread.activity.append",
              commandId,
              threadId: input.threadId,
              activity: {
                id: activityId,
                tone: input.tone,
                kind: input.kind,
                summary: input.summary,
                payload: input.payload,
                turnId: null,
                createdAt: input.createdAt,
              },
              createdAt: input.createdAt,
            }),
          ),
        );

      const toBootstrapDispatchCommandCauseError = (cause: Cause.Cause<unknown>) => {
        const error = Cause.squash(cause);
        return isOrchestrationDispatchCommandError(error)
          ? error
          : new OrchestrationDispatchCommandError({
              message:
                error instanceof Error ? error.message : "Failed to bootstrap thread turn start.",
              cause,
            });
      };

      const toShellStreamEvent = (
        event: OrchestrationEvent,
      ): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>, never, never> => {
        switch (event.type) {
          case "project.created":
          case "project.meta-updated":
            return projectionSnapshotQuery.getProjectShellById(event.payload.projectId).pipe(
              Effect.map((project) =>
                Option.map(project, (nextProject) => ({
                  kind: "project-upserted" as const,
                  sequence: event.sequence,
                  project: nextProject,
                })),
              ),
              Effect.orElseSucceed(() => Option.none()),
            );
          case "project.deleted":
            return Effect.succeed(
              Option.some({
                kind: "project-removed" as const,
                sequence: event.sequence,
                projectId: event.payload.projectId,
              }),
            );
          case "thread.deleted":
          case "thread.archived":
            return Effect.succeed(
              Option.some({
                kind: "thread-removed" as const,
                sequence: event.sequence,
                threadId: event.payload.threadId,
              }),
            );
          case "thread.unarchived":
            return projectionSnapshotQuery.getThreadShellById(event.payload.threadId).pipe(
              Effect.map((thread) =>
                Option.map(thread, (nextThread) => ({
                  kind: "thread-upserted" as const,
                  sequence: event.sequence,
                  thread: nextThread,
                })),
              ),
              Effect.orElseSucceed(() => Option.none()),
            );
          default:
            if (event.aggregateKind !== "thread") {
              return Effect.succeed(Option.none());
            }
            return projectionSnapshotQuery
              .getThreadShellById(ThreadId.make(event.aggregateId))
              .pipe(
                Effect.map((thread) =>
                  Option.map(thread, (nextThread) => ({
                    kind: "thread-upserted" as const,
                    sequence: event.sequence,
                    thread: nextThread,
                  })),
                ),
                Effect.orElseSucceed(() => Option.none()),
              );
        }
      };

      const dispatchBootstrapTurnStart = (
        command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
      ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> =>
        Effect.gen(function* () {
          const bootstrap = command.bootstrap;
          const { bootstrap: _bootstrap, ...finalTurnStartCommand } = command;
          let createdThread = false;
          let targetProjectId = bootstrap?.createThread?.projectId;
          let targetProjectCwd = bootstrap?.prepareWorktree?.projectCwd;
          let targetWorktreePath = bootstrap?.createThread?.worktreePath ?? null;

          const cleanupCreatedThread = () =>
            createdThread
              ? serverCommandId("bootstrap-thread-delete").pipe(
                  Effect.flatMap((commandId) =>
                    orchestrationEngine.dispatch({
                      type: "thread.delete",
                      commandId,
                      threadId: command.threadId,
                    }),
                  ),
                  Effect.ignoreCause({ log: true }),
                )
              : Effect.void;

          const recordSetupScriptLaunchFailure = (input: {
            readonly error: ProjectSetupScriptRunner.ProjectSetupScriptRunnerError;
            readonly requestedAt: string;
            readonly worktreePath: string;
          }) => {
            const detail = projectSetupScriptCompatibilityDetail(input.error);
            return appendSetupScriptActivity({
              threadId: command.threadId,
              kind: "setup-script.failed",
              summary: "Setup script failed to start",
              createdAt: input.requestedAt,
              payload: {
                detail,
                worktreePath: input.worktreePath,
              },
              tone: "error",
            }).pipe(
              Effect.ignoreCause({ log: false }),
              Effect.flatMap(() =>
                Effect.logWarning("bootstrap turn start failed to launch setup script", {
                  threadId: command.threadId,
                  worktreePath: input.worktreePath,
                  detail,
                }),
              ),
            );
          };

          const recordSetupScriptStarted = (input: {
            readonly requestedAt: string;
            readonly worktreePath: string;
            readonly scriptId: string;
            readonly scriptName: string;
            readonly terminalId: string;
          }) =>
            Effect.gen(function* () {
              const startedAt = yield* nowIso;
              const payload = {
                scriptId: input.scriptId,
                scriptName: input.scriptName,
                terminalId: input.terminalId,
                worktreePath: input.worktreePath,
              };
              yield* Effect.all([
                appendSetupScriptActivity({
                  threadId: command.threadId,
                  kind: "setup-script.requested",
                  summary: "Starting setup script",
                  createdAt: input.requestedAt,
                  payload,
                  tone: "info",
                }),
                appendSetupScriptActivity({
                  threadId: command.threadId,
                  kind: "setup-script.started",
                  summary: "Setup script started",
                  createdAt: startedAt,
                  payload,
                  tone: "info",
                }),
              ]).pipe(
                Effect.asVoid,
                Effect.catch((error) =>
                  Effect.logWarning(
                    "bootstrap turn start launched setup script but failed to record setup activity",
                    {
                      threadId: command.threadId,
                      worktreePath: input.worktreePath,
                      scriptId: input.scriptId,
                      terminalId: input.terminalId,
                      detail: error.message,
                    },
                  ),
                ),
              );
            });

          const runSetupProgram = () =>
            Effect.gen(function* () {
              if (!bootstrap?.runSetupScript || !targetWorktreePath) {
                return;
              }
              const worktreePath = targetWorktreePath;
              const requestedAt = yield* nowIso;
              yield* projectSetupScriptRunner
                .runForThread({
                  threadId: command.threadId,
                  ...(targetProjectId ? { projectId: targetProjectId } : {}),
                  ...(targetProjectCwd ? { projectCwd: targetProjectCwd } : {}),
                  worktreePath,
                })
                .pipe(
                  Effect.matchEffect({
                    onFailure: (error) =>
                      recordSetupScriptLaunchFailure({
                        error,
                        requestedAt,
                        worktreePath,
                      }),
                    onSuccess: (setupResult) => {
                      if (setupResult.status !== "started") {
                        return Effect.void;
                      }
                      return recordSetupScriptStarted({
                        requestedAt,
                        worktreePath,
                        scriptId: setupResult.scriptId,
                        scriptName: setupResult.scriptName,
                        terminalId: setupResult.terminalId,
                      });
                    },
                  }),
                );
            });

          const bootstrapProgram = Effect.gen(function* () {
            if (bootstrap?.createThread) {
              yield* orchestrationEngine.dispatch({
                type: "thread.create",
                commandId: yield* serverCommandId("bootstrap-thread-create"),
                threadId: command.threadId,
                projectId: bootstrap.createThread.projectId,
                title: bootstrap.createThread.title,
                modelSelection: bootstrap.createThread.modelSelection,
                runtimeMode: bootstrap.createThread.runtimeMode,
                interactionMode: bootstrap.createThread.interactionMode,
                branch: bootstrap.createThread.branch,
                worktreePath: bootstrap.createThread.worktreePath,
                createdAt: bootstrap.createThread.createdAt,
              });
              createdThread = true;
            }

            if (bootstrap?.prepareWorktree) {
              let worktreeBaseRef = bootstrap.prepareWorktree.baseBranch;
              if (bootstrap.prepareWorktree.startFromOrigin) {
                yield* gitWorkflow.fetchRemote({
                  cwd: bootstrap.prepareWorktree.projectCwd,
                  remoteName: "origin",
                });
                const resolvedRemoteBase = yield* gitWorkflow.resolveRemoteTrackingCommit({
                  cwd: bootstrap.prepareWorktree.projectCwd,
                  refName: bootstrap.prepareWorktree.baseBranch,
                  fallbackRemoteName: "origin",
                });
                worktreeBaseRef = resolvedRemoteBase.commitSha;
              }
              const worktree = yield* gitWorkflow.createWorktree({
                cwd: bootstrap.prepareWorktree.projectCwd,
                refName: worktreeBaseRef,
                newRefName: bootstrap.prepareWorktree.branch,
                baseRefName: bootstrap.prepareWorktree.baseBranch,
                path: null,
              });
              targetWorktreePath = worktree.worktree.path;
              yield* orchestrationEngine.dispatch({
                type: "thread.meta.update",
                commandId: yield* serverCommandId("bootstrap-thread-meta-update"),
                threadId: command.threadId,
                branch: worktree.worktree.refName,
                worktreePath: targetWorktreePath,
              });
              yield* refreshGitStatus(targetWorktreePath);
            }

            yield* runSetupProgram();

            return yield* orchestrationEngine.dispatch(finalTurnStartCommand);
          });

          return yield* bootstrapProgram.pipe(
            Effect.catchCause((cause) => {
              const dispatchError = toBootstrapDispatchCommandCauseError(cause);
              if (Cause.hasInterruptsOnly(cause)) {
                return Effect.fail(dispatchError);
              }
              return cleanupCreatedThread().pipe(Effect.flatMap(() => Effect.fail(dispatchError)));
            }),
          );
        });

      const dispatchNormalizedCommand = (
        normalizedCommand: OrchestrationCommand,
      ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> => {
        const dispatchEffect =
          normalizedCommand.type === "thread.turn.start" && normalizedCommand.bootstrap
            ? dispatchBootstrapTurnStart(normalizedCommand)
            : orchestrationEngine
                .dispatch(normalizedCommand)
                .pipe(
                  Effect.mapError((cause) =>
                    toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
                  ),
                );

        return startup
          .enqueueCommand(dispatchEffect)
          .pipe(
            Effect.mapError((cause) =>
              toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
            ),
          );
      };

      const loadServerConfig = Effect.gen(function* () {
        const keybindingsConfig = yield* keybindings.loadConfigState;
        const providers = yield* providerRegistry.getProviders;
        const settings = ServerSettings.redactServerSettingsForClient(
          yield* serverSettings.getSettings,
        );
        const environment = yield* serverEnvironment.getDescriptor;

        return {
          environment,
          cwd: config.cwd,
          keybindingsConfigPath: config.keybindingsConfigPath,
          keybindings: keybindingsConfig.keybindings,
          issues: keybindingsConfig.issues,
          providers,
          availableEditors: yield* externalLauncher.resolveAvailableEditors(),
          observability: {
            logsDirectoryPath: config.logsDir,
            localTracingEnabled: true,
            ...(config.otlpTracesUrl !== undefined ? { otlpTracesUrl: config.otlpTracesUrl } : {}),
            otlpTracesEnabled: config.otlpTracesUrl !== undefined,
            ...(config.otlpMetricsUrl !== undefined
              ? { otlpMetricsUrl: config.otlpMetricsUrl }
              : {}),
            otlpMetricsEnabled: config.otlpMetricsUrl !== undefined,
          },
          settings,
        };
      });

      const refreshGitStatus = (cwd: string) =>
        vcsStatusBroadcaster
          .refreshStatus(cwd)
          .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);

      return WsRpcGroup.of({
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.dispatchCommand,
            Effect.gen(function* () {
              const normalizedCommand = yield* normalizeDispatchCommand(command);
              const shouldStopSessionAfterArchive =
                normalizedCommand.type === "thread.archive"
                  ? yield* projectionSnapshotQuery
                      .getThreadShellById(normalizedCommand.threadId)
                      .pipe(
                        Effect.map(
                          Option.match({
                            onNone: () => false,
                            onSome: (thread) =>
                              thread.session !== null && thread.session.status !== "stopped",
                          }),
                        ),
                        Effect.orElseSucceed(() => false),
                      )
                  : false;
              const result = yield* dispatchNormalizedCommand(normalizedCommand);
              if (normalizedCommand.type === "thread.archive") {
                if (shouldStopSessionAfterArchive) {
                  yield* Effect.gen(function* () {
                    const stopCommand = yield* normalizeDispatchCommand({
                      type: "thread.session.stop",
                      commandId: CommandId.make(
                        `session-stop-for-archive:${normalizedCommand.commandId}`,
                      ),
                      threadId: normalizedCommand.threadId,
                      createdAt: yield* nowIso,
                    });

                    yield* dispatchNormalizedCommand(stopCommand);
                  }).pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning("failed to stop provider session during archive", {
                        threadId: normalizedCommand.threadId,
                        cause,
                      }),
                    ),
                  );
                }

                yield* terminalManager.close({ threadId: normalizedCommand.threadId }).pipe(
                  Effect.catch((error) =>
                    Effect.logWarning("failed to close thread terminals after archive", {
                      threadId: normalizedCommand.threadId,
                      error: error.message,
                    }),
                  ),
                );
              }
              return result;
            }).pipe(
              Effect.mapError((cause) =>
                isOrchestrationDispatchCommandError(cause)
                  ? cause
                  : new OrchestrationDispatchCommandError({
                      message: "Failed to dispatch orchestration command",
                      cause,
                    }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getTurnDiff]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getTurnDiff,
            checkpointDiffQuery.getTurnDiff(input).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetTurnDiffError({
                    message: "Failed to load turn diff",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getFullThreadDiff]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getFullThreadDiff,
            checkpointDiffQuery.getFullThreadDiff(input).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetFullThreadDiffError({
                    message: "Failed to load full thread diff",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.subscribeShell]: (input) =>
          observeRpcStreamEffect(
            ORCHESTRATION_WS_METHODS.subscribeShell,
            Effect.gen(function* () {
              const liveStream = orchestrationEngine.streamDomainEvents.pipe(
                Stream.mapEffect(toShellStreamEvent),
                Stream.flatMap((event) =>
                  Option.isSome(event) ? Stream.succeed(event.value) : Stream.empty,
                ),
              );

              // When the client already holds a shell snapshot (cached, or loaded
              // over HTTP) it passes that snapshot's sequence, and we resume by
              // replaying shell events after it instead of re-sending the whole
              // projects/threads list over the socket. As in the thread path, the
              // live subscription is attached (into a scope-bound buffer) before
              // draining the catch-up replay so no event published during the
              // replay window is lost; overlapping events are deduped by sequence
              // on the client.
              //
              // The replay is bounded to the projection head captured below:
              // replaying every intervening event (each a shell refetch) is far
              // more expensive than a single O(active-threads) snapshot, and a
              // stale cached cursor can sit hundreds of thousands of global
              // events behind. Past the gap cap (or when the cursor is ahead of
              // the authoritative state) the branch falls through to the fresh
              // snapshot path below so the client converges from a snapshot
              // instead of an unbounded replay.
              if (input.afterSequence !== undefined) {
                const afterSequence = input.afterSequence;
                const headSequence = yield* orchestrationEngine.latestSequence;
                const replayGap = headSequence - afterSequence;
                if (replayGap >= 0 && replayGap <= SHELL_RESUME_MAX_GAP) {
                  return Stream.unwrap(
                    Effect.gen(function* () {
                      const liveBuffer = yield* Queue.unbounded<OrchestrationShellStreamItem>();
                      yield* Effect.forkScoped(
                        liveStream.pipe(Stream.runForEach((item) => Queue.offer(liveBuffer, item))),
                      );
                      // Replay only through the head captured above. Newer events
                      // are already covered by the live subscription, so this
                      // bound cannot chase a moving event-store head.
                      const catchUpStream = orchestrationEngine
                        .readEvents(afterSequence, replayGap)
                        .pipe(
                          Stream.mapEffect(toShellStreamEvent),
                          Stream.flatMap((event) =>
                            Option.isSome(event) ? Stream.succeed(event.value) : Stream.empty,
                          ),
                          Stream.mapError(
                            (cause) =>
                              new OrchestrationGetSnapshotError({
                                message: "Failed to replay orchestration shell events",
                                cause,
                              }),
                          ),
                        );
                      return Stream.concat(catchUpStream, Stream.fromQueue(liveBuffer));
                    }),
                  );
                }
              }

              const snapshot = yield* projectionSnapshotQuery.getShellSnapshot().pipe(
                Effect.tapError((cause) =>
                  Effect.logError("orchestration shell snapshot load failed", { cause }),
                ),
                Effect.mapError(
                  (cause) =>
                    new OrchestrationGetSnapshotError({
                      message: "Failed to load orchestration shell snapshot",
                      cause,
                    }),
                ),
              );

              return Stream.concat(
                Stream.make({
                  kind: "snapshot" as const,
                  snapshot,
                }),
                liveStream,
              );
            }),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot]: (_input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot,
            projectionSnapshotQuery.getArchivedShellSnapshot().pipe(
              Effect.tapError((cause) =>
                Effect.logError("orchestration archived shell snapshot load failed", { cause }),
              ),
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetSnapshotError({
                    message: "Failed to load archived orchestration shell snapshot",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.subscribeThread]: (input) =>
          observeRpcStreamEffect(
            ORCHESTRATION_WS_METHODS.subscribeThread,
            Effect.gen(function* () {
              const isThisThreadDetailEvent = (event: OrchestrationEvent) =>
                event.aggregateKind === "thread" &&
                event.aggregateId === input.threadId &&
                isThreadDetailEvent(event);

              const liveStream = orchestrationEngine.streamDomainEvents.pipe(
                Stream.filter(isThisThreadDetailEvent),
                Stream.map((event) => ({
                  kind: "event" as const,
                  event: projectActivityEvent(event),
                })),
              );

              // Attach live delivery before reading either replay or snapshot state.
              // Otherwise an event published while the snapshot is loading is lost.
              const liveBuffer = yield* Queue.unbounded<OrchestrationThreadStreamItem>();
              yield* Effect.forkScoped(
                liveStream.pipe(Stream.runForEach((item) => Queue.offer(liveBuffer, item))),
              );
              const bufferedLiveStream = Stream.fromQueue(liveBuffer);

              // When the client already loaded the snapshot over HTTP it passes
              // that snapshot's sequence, and we resume the live subscription by
              // replaying persisted events after it instead of re-sending the
              // (potentially multi-KB) snapshot frame over the socket.
              //
              // The live PubSub subscription must be attached *before* draining
              // the catch-up replay, otherwise events published during the replay
              // window are dropped (they are past the persisted tail the replay
              // read, but the live stream is not yet subscribed). So fork the
              // live stream into a buffer bound to this stream's scope, then emit
              // catch-up followed by the buffered/ongoing live events. Overlapping
              // events are deduped by sequence on the client.
              //
              // The replay is bounded to the projection head captured below. The
              // catch-up range is normally tiny (a fresh HTTP snapshot sequence),
              // but a stale cached cursor can sit hundreds of thousands of global
              // events behind; replaying that decodes every intervening event
              // (including every other thread's tool payloads) only to discard
              // almost all of them, which has OOM-killed servers on large
              // databases. A truncated replay would silently drop this thread's
              // events, so past the gap cap we reset the client with a fresh
              // thread snapshot instead, exactly like subscribeShell above.
              if (input.afterSequence !== undefined) {
                const afterSequence = input.afterSequence;
                const headSequence = yield* orchestrationEngine.latestSequence;
                const replayGap = headSequence - afterSequence;
                if (replayGap >= 0 && replayGap <= THREAD_RESUME_MAX_GAP) {
                  const catchUpStream = orchestrationEngine
                    .readEvents(afterSequence, replayGap)
                    .pipe(
                      Stream.filter(isThisThreadDetailEvent),
                      Stream.map((event) => ({
                        kind: "event" as const,
                        event: projectActivityEvent(event),
                      })),
                      Stream.mapError(
                        (cause) =>
                          new OrchestrationGetSnapshotError({
                            message: `Failed to replay thread ${input.threadId} events`,
                            cause,
                          }),
                      ),
                    );
                  return Stream.concat(catchUpStream, bufferedLiveStream);
                }
                // Gap too large (or cursor ahead of authoritative state): fall
                // through to the snapshot path so the client converges from a
                // fresh thread detail instead of an unbounded replay.
              }

              const snapshot = yield* projectionSnapshotQuery
                .getThreadDetailSnapshot(input.threadId)
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new OrchestrationGetSnapshotError({
                        message: `Failed to load thread ${input.threadId}`,
                        cause,
                      }),
                  ),
                );

              if (Option.isNone(snapshot)) {
                return yield* new OrchestrationGetSnapshotError({
                  message: `Thread ${input.threadId} was not found`,
                  cause: input.threadId,
                });
              }

              return Stream.concat(
                Stream.make({
                  kind: "snapshot" as const,
                  snapshot: projectThreadDetailSnapshot(snapshot.value),
                }),
                bufferedLiveStream,
              );
            }),
            { "rpc.aggregate": "orchestration" },
          ),
        [WS_METHODS.serverGetConfig]: (_input) =>
          observeRpcEffect(WS_METHODS.serverGetConfig, loadServerConfig, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverRefreshProviders]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverRefreshProviders,
            (input.instanceId !== undefined
              ? providerRegistry.refreshInstance(input.instanceId)
              : providerRegistry.refresh()
            ).pipe(Effect.map((providers) => ({ providers }))),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverUpdateProvider]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverUpdateProvider,
            providerMaintenanceRunner.updateProvider(input),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverUpsertKeybinding]: (rule) =>
          observeRpcEffect(
            WS_METHODS.serverUpsertKeybinding,
            Effect.gen(function* () {
              const keybindingsConfig = yield* keybindings.upsertKeybindingRule(rule);
              return { keybindings: keybindingsConfig, issues: [] };
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverRemoveKeybinding]: (rule) =>
          observeRpcEffect(
            WS_METHODS.serverRemoveKeybinding,
            Effect.gen(function* () {
              const keybindingsConfig = yield* keybindings.removeKeybindingRule(rule);
              return { keybindings: keybindingsConfig, issues: [] };
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverGetSettings]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverGetSettings,
            serverSettings.getSettings.pipe(
              Effect.map(ServerSettings.redactServerSettingsForClient),
            ),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverUpdateSettings]: (mutation) =>
          observeRpcEffect(
            WS_METHODS.serverUpdateSettings,
            serverSettings.updateSettingsMutation(mutation).pipe(
              Effect.map((acknowledgement) => ({
                ...acknowledgement,
                settings: ServerSettings.redactServerSettingsForClient(acknowledgement.settings),
              })),
            ),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverDiscoverSourceControl]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverDiscoverSourceControl,
            sourceControlDiscovery.discover,
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverGetTraceDiagnostics]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverGetTraceDiagnostics,
            TraceDiagnostics.readTraceDiagnostics({
              traceFilePath: config.serverTracePath,
              maxFiles: config.traceMaxFiles,
            }),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverGetProcessDiagnostics]: (_input) =>
          observeRpcEffect(WS_METHODS.serverGetProcessDiagnostics, processDiagnostics.read, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverGetProcessResourceHistory]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverGetProcessResourceHistory,
            processResourceMonitor.readHistory(input),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverSignalProcess]: (input) =>
          observeRpcEffect(WS_METHODS.serverSignalProcess, processDiagnostics.signal(input), {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverTestManagedClientEvidenceConnection]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverTestManagedClientEvidenceConnection,
            serverSettings.getSettings.pipe(
              Effect.flatMap((settings) =>
                testManagedClientEvidenceConnection(
                  settings.providers.githubCopilot.managedClientEvidence,
                  settings.analytics,
                ),
              ),
            ),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.copilotDeviceLoginStart]: (_input) =>
          observeRpcEffect(WS_METHODS.copilotDeviceLoginStart, startGithubDeviceLogin(), {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.copilotDeviceLoginStatus]: ({ flowId }) =>
          observeRpcEffect(
            WS_METHODS.copilotDeviceLoginStatus,
            Effect.succeed(getGithubDeviceLoginStatus(flowId)),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.copilotSignOut]: (_input) =>
          observeRpcEffect(WS_METHODS.copilotSignOut, signOutGithubDeviceLogin(), {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.sourceControlLookupRepository]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlLookupRepository,
            sourceControlRepositories.lookupRepository(input),
            {
              "rpc.aggregate": "source-control",
            },
          ),
        [WS_METHODS.sourceControlCloneRepository]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlCloneRepository,
            sourceControlRepositories.cloneRepository(input),
            {
              "rpc.aggregate": "source-control",
            },
          ),
        [WS_METHODS.sourceControlPublishRepository]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlPublishRepository,
            sourceControlRepositories
              .publishRepository(input)
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            {
              "rpc.aggregate": "source-control",
            },
          ),
        [WS_METHODS.projectsSearchEntries]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsSearchEntries,
            workspaceEntries.search(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectSearchEntriesError({
                    cwd: input.cwd,
                    queryLength: input.query.length,
                    limit: input.limit,
                    ...projectEntriesFailureContext(cause),
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsListEntries]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsListEntries,
            workspaceEntries.list(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectListEntriesError({
                    ...input,
                    ...projectEntriesFailureContext(cause),
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsReadFile]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsReadFile,
            workspaceFileSystem.readFile(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectReadFileError({
                    ...input,
                    ...projectFileFailureContext(cause),
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsWriteFile]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsWriteFile,
            workspaceFileSystem.writeFile(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectWriteFileError({
                    cwd: input.cwd,
                    relativePath: input.relativePath,
                    ...projectFileFailureContext(cause),
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.shellOpenInEditor]: (input) =>
          observeRpcEffect(WS_METHODS.shellOpenInEditor, externalLauncher.launchEditor(input), {
            "rpc.aggregate": "workspace",
          }),
        [WS_METHODS.filesystemBrowse]: (input) =>
          observeRpcEffect(
            WS_METHODS.filesystemBrowse,
            workspaceEntries.browse(input).pipe(
              Effect.mapError(
                (cause) =>
                  new FilesystemBrowseError({
                    ...input,
                    ...filesystemBrowseFailureContext(cause),
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.assetsCreateUrl]: (input) =>
          observeRpcEffect(
            WS_METHODS.assetsCreateUrl,
            Effect.gen(function* () {
              if (input.resource._tag !== "workspace-file") {
                return yield* issueAssetUrl({ resource: input.resource });
              }
              const thread = yield* projectionSnapshotQuery
                .getThreadShellById(input.resource.threadId)
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new AssetWorkspaceContextResolutionError({
                        resource: input.resource,
                        cause,
                      }),
                  ),
                );
              if (Option.isNone(thread)) {
                return yield* new AssetWorkspaceContextNotFoundError({
                  resource: input.resource,
                });
              }
              const project = yield* projectionSnapshotQuery
                .getProjectShellById(thread.value.projectId)
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new AssetWorkspaceContextResolutionError({
                        resource: input.resource,
                        cause,
                      }),
                  ),
                );
              if (Option.isNone(project)) {
                return yield* new AssetWorkspaceContextNotFoundError({
                  resource: input.resource,
                });
              }
              return yield* issueAssetUrl({
                resource: input.resource,
                workspaceRoot: thread.value.worktreePath ?? project.value.workspaceRoot,
              });
            }),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.subscribeVcsStatus]: (input) =>
          observeRpcStream(
            WS_METHODS.subscribeVcsStatus,
            vcsStatusBroadcaster.streamStatus(input, {
              automaticRemoteRefreshInterval: automaticGitFetchInterval,
            }),
            {
              "rpc.aggregate": "vcs",
            },
          ),
        [WS_METHODS.vcsRefreshStatus]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsRefreshStatus,
            vcsStatusBroadcaster.refreshStatus(input.cwd),
            {
              "rpc.aggregate": "vcs",
            },
          ),
        [WS_METHODS.vcsPull]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsPull,
            gitWorkflow.pullCurrentBranch(input.cwd).pipe(
              Effect.matchCauseEffect({
                onFailure: (cause) => Effect.failCause(cause),
                onSuccess: (result) =>
                  refreshGitStatus(input.cwd).pipe(Effect.ignore({ log: true }), Effect.as(result)),
              }),
            ),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.gitRunStackedAction]: (input) =>
          observeRpcStream(
            WS_METHODS.gitRunStackedAction,
            Stream.callback<GitActionProgressEvent, GitManagerServiceError>((queue) =>
              gitWorkflow
                .runStackedAction(input, {
                  actionId: input.actionId,
                  progressReporter: {
                    publish: (event) => Queue.offer(queue, event).pipe(Effect.asVoid),
                  },
                })
                .pipe(
                  Effect.matchCauseEffect({
                    onFailure: (cause) => Queue.failCause(queue, cause),
                    onSuccess: () =>
                      refreshGitStatus(input.cwd).pipe(
                        Effect.andThen(Queue.end(queue).pipe(Effect.asVoid)),
                      ),
                  }),
                ),
            ),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.gitResolvePullRequest]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitResolvePullRequest,
            gitWorkflow.resolvePullRequest(input),
            {
              "rpc.aggregate": "git",
            },
          ),
        [WS_METHODS.gitPreparePullRequestThread]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitPreparePullRequestThread,
            gitWorkflow
              .preparePullRequestThread(input)
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.vcsListRefs]: (input) =>
          observeRpcEffect(WS_METHODS.vcsListRefs, gitWorkflow.listRefs(input), {
            "rpc.aggregate": "vcs",
          }),
        [WS_METHODS.vcsCreateWorktree]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsCreateWorktree,
            gitWorkflow.createWorktree(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsRemoveWorktree]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsRemoveWorktree,
            gitWorkflow.removeWorktree(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsCreateRef]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsCreateRef,
            gitWorkflow.createRef(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsSwitchRef]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsSwitchRef,
            gitWorkflow.switchRef(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsInit]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsInit,
            vcsProvisioning
              .initRepository(input)
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.reviewGetDiffPreview]: (input) =>
          observeRpcEffect(WS_METHODS.reviewGetDiffPreview, review.getDiffPreview(input), {
            "rpc.aggregate": "review",
          }),
        [WS_METHODS.terminalOpen]: (input) =>
          observeRpcEffect(WS_METHODS.terminalOpen, terminalManager.open(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalAttach]: (input) =>
          observeRpcStream(
            WS_METHODS.terminalAttach,
            Stream.callback<TerminalAttachStreamEvent, TerminalError>((queue) =>
              Effect.acquireRelease(
                terminalManager.attachStream(input, (event) => Queue.offer(queue, event)),
                (unsubscribe) => Effect.sync(unsubscribe),
              ),
            ),
            { "rpc.aggregate": "terminal" },
          ),
        [WS_METHODS.terminalWrite]: (input) =>
          observeRpcEffect(WS_METHODS.terminalWrite, terminalManager.write(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalResize]: (input) =>
          observeRpcEffect(WS_METHODS.terminalResize, terminalManager.resize(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalClear]: (input) =>
          observeRpcEffect(WS_METHODS.terminalClear, terminalManager.clear(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalRestart]: (input) =>
          observeRpcEffect(WS_METHODS.terminalRestart, terminalManager.restart(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalClose]: (input) =>
          observeRpcEffect(WS_METHODS.terminalClose, terminalManager.close(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.subscribeTerminalEvents]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeTerminalEvents,
            Stream.callback<TerminalEvent>((queue) =>
              Effect.acquireRelease(
                terminalManager.subscribe((event) => Queue.offer(queue, event)),
                (unsubscribe) => Effect.sync(unsubscribe),
              ),
            ),
            { "rpc.aggregate": "terminal" },
          ),
        [WS_METHODS.subscribeTerminalMetadata]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeTerminalMetadata,
            Stream.callback<TerminalMetadataStreamEvent>((queue) =>
              Effect.acquireRelease(
                terminalManager.subscribeMetadata((event) => Queue.offer(queue, event)),
                (unsubscribe) => Effect.sync(unsubscribe),
              ),
            ),
            { "rpc.aggregate": "terminal" },
          ),
        [WS_METHODS.previewOpen]: (input) =>
          observeRpcEffect(WS_METHODS.previewOpen, previewManager.open(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewNavigate]: (input) =>
          observeRpcEffect(WS_METHODS.previewNavigate, previewManager.navigate(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewResize]: (input) =>
          observeRpcEffect(WS_METHODS.previewResize, previewManager.resize(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewRefresh]: (input) =>
          observeRpcEffect(WS_METHODS.previewRefresh, previewManager.refresh(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewClose]: (input) =>
          observeRpcEffect(WS_METHODS.previewClose, previewManager.close(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewList]: (input) =>
          observeRpcEffect(WS_METHODS.previewList, previewManager.list(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewReportStatus]: (input) =>
          observeRpcEffect(WS_METHODS.previewReportStatus, previewManager.reportStatus(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewAutomationConnect]: (input) =>
          observeRpcStreamEffect(
            WS_METHODS.previewAutomationConnect,
            previewAutomationBroker.connect(input),
            { "rpc.aggregate": "preview-automation" },
          ),
        [WS_METHODS.previewAutomationRespond]: (input) =>
          observeRpcEffect(
            WS_METHODS.previewAutomationRespond,
            previewAutomationBroker.respond(input),
            { "rpc.aggregate": "preview-automation" },
          ),
        [WS_METHODS.previewAutomationFocusHost]: (input) =>
          observeRpcEffect(
            WS_METHODS.previewAutomationFocusHost,
            previewAutomationBroker.focusHost(input),
            { "rpc.aggregate": "preview-automation" },
          ),
        [WS_METHODS.subscribePreviewEvents]: (_input) =>
          observeRpcStream(WS_METHODS.subscribePreviewEvents, previewManager.events, {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.subscribeDiscoveredLocalServers]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeDiscoveredLocalServers,
            Stream.callback<DiscoveredLocalServerList>((queue) =>
              Effect.gen(function* () {
                yield* portDiscovery.retain;
                const initial = yield* portDiscovery.scan();
                const initialScannedAt = DateTime.formatIso(yield* DateTime.now);
                yield* Queue.offer(queue, {
                  servers: initial,
                  scannedAt: initialScannedAt,
                });
                yield* portDiscovery.subscribe((servers) =>
                  Effect.gen(function* () {
                    const scannedAt = DateTime.formatIso(yield* DateTime.now);
                    yield* Queue.offer(queue, { servers, scannedAt });
                  }),
                );
              }),
            ),
            { "rpc.aggregate": "preview" },
          ),
        [WS_METHODS.subscribeServerConfig]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeServerConfig,
            Effect.gen(function* () {
              const keybindingsUpdates = keybindings.streamChanges.pipe(
                Stream.map((event) => ({
                  version: 1 as const,
                  type: "keybindingsUpdated" as const,
                  payload: {
                    keybindings: event.keybindings,
                    issues: event.issues,
                  },
                })),
              );
              const providerStatuses = providerRegistry.streamChanges.pipe(
                Stream.map((providers) => ({
                  version: 1 as const,
                  type: "providerStatuses" as const,
                  payload: { providers },
                })),
                Stream.debounce(Duration.millis(PROVIDER_STATUS_DEBOUNCE_MS)),
              );
              const settingsUpdates = serverSettings.streamChanges.pipe(
                Stream.map((settings) => ServerSettings.redactServerSettingsForClient(settings)),
                Stream.map((settings) => ({
                  version: 1 as const,
                  type: "settingsUpdated" as const,
                  payload: { settings },
                })),
              );

              yield* providerRegistry
                .refresh()
                .pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped);

              const liveUpdates = Stream.merge(
                keybindingsUpdates,
                Stream.merge(providerStatuses, settingsUpdates),
              );

              return Stream.concat(
                Stream.make({
                  version: 1 as const,
                  type: "snapshot" as const,
                  config: yield* loadServerConfig,
                }),
                liveUpdates,
              );
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.subscribeServerLifecycle]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeServerLifecycle,
            Effect.gen(function* () {
              const snapshot = yield* lifecycleEvents.snapshot;
              const snapshotEvents = Array.from(snapshot.events).toSorted(
                (left, right) => left.sequence - right.sequence,
              );
              const liveEvents = lifecycleEvents.stream.pipe(
                Stream.filter((event) => event.sequence > snapshot.sequence),
              );
              return Stream.concat(Stream.fromIterable(snapshotEvents), liveEvents);
            }),
            { "rpc.aggregate": "server" },
          ),

        ...makeSymphonyRpcHandlers(),
      });
    }),
  );

export const websocketRpcRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const previewAutomationBroker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    return HttpRouter.add(
      "GET",
      "/ws",
      Effect.gen(function* () {
        const wslBearerAuth = yield* WslBearerAuth.WslBearerAuth;
        yield* wslBearerAuth.authorizeWebSocketUpgrade;
        const rpcWebSocketHttpEffect = yield* RpcServer.toHttpEffectWebsocket(WsRpcGroup, {
          disableTracing: true,
        }).pipe(
          Effect.provide(
            makeWsRpcLayer(previewAutomationBroker).pipe(
              Layer.provideMerge(RpcSerialization.layerJson),
              Layer.provide(ProviderMaintenanceRunner.layer),
              Layer.provide(
                SourceControlDiscovery.layer.pipe(
                  Layer.provide(
                    SourceControlProviderRegistry.layer.pipe(
                      Layer.provide(
                        Layer.mergeAll(
                          AzureDevOpsCli.layer,
                          BitbucketApi.layer,
                          GitHubCli.layer,
                          GitLabCli.layer,
                        ),
                      ),
                      Layer.provideMerge(GitVcsDriver.layer),
                      Layer.provide(
                        VcsDriverRegistry.layer.pipe(Layer.provide(VcsProjectConfig.layer)),
                      ),
                    ),
                  ),
                  Layer.provide(VcsProcess.layer),
                ),
              ),
            ),
          ),
        );
        return yield* rpcWebSocketHttpEffect;
      }).pipe(
        Effect.catchTags({
          EnvironmentWslBearerInvalidError: HttpServerRespondable.toResponse,
        }),
      ),
    );
  }),
);
