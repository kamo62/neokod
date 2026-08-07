import type {
  AutonomyLevel,
  EffectiveWorkflowConfig,
  ProviderInstanceRef,
  TrackerKind,
  WorkflowValidationField,
} from "@neokod/contracts";
import {
  ApprovalActionSchema,
  ApprovalPolicyClassSchema,
  AutonomyLevelSchema,
  EffectiveWorkflowConfigSchema,
  TrackerKindSchema,
} from "@neokod/contracts";
import { Schema } from "effect";
import * as Effect from "effect/Effect";

/**
 * Effective workflow config resolution (SPEC 6.1).
 *
 * Pipeline: defaults, `$VAR_NAME` indirection for values that explicitly
 * reference an environment variable, coercion, and validation. Environment
 * variables never override YAML globally; they resolve only where a value
 * explicitly references them (or a documented adapter fallback). `~` expands
 * for path values; relative `workspace.root` resolves against the directory
 * containing `WORKFLOW.md`.
 */

export const WORKFLOW_DEFAULTS = {
  pollIntervalMs: 30_000,
  workspaceRoot: "",
  autonomy: "execute",
  maxConcurrentAgents: 10,
  maxTurns: 20,
  maxAttempts: 5,
  initialRetryDelayMs: 10_000,
  maxRetryBackoffMs: 300_000,
  maxRunDurationMs: 14_400_000,
  codexCommand: "codex app-server",
  codexApprovalPolicy: "on-request",
  codexThreadSandbox: "workspace-write",
  codexTurnSandboxPolicy: "workspaceWrite",
  codexTurnTimeoutMs: 3_600_000,
  codexReadTimeoutMs: 5_000,
  codexStallTimeoutMs: 300_000,
  hooksTimeoutMs: 60_000,
  approvalsWaitTimeoutMs: 1_800_000,
  liveRequestsWaitTimeoutMs: 1_800_000,
  concurrencyGlobal: 3,
  concurrencyRepository: 2,
} as const;

const POLL_INTERVAL_MIN_MS = 5_000;
const POLL_INTERVAL_MAX_MS = 3_600_000;

class ConfigValidationError extends Schema.TaggedErrorClass<ConfigValidationError>()(
  "ConfigValidationError",
  {
    errors: Schema.Array(Schema.String),
  },
) {}

const env = (name: string): string | undefined => process.env[name];

/**
 * Resolve a possibly `$VAR`-referencing string to its literal value.
 * Only expands when the whole value is `$NAME` or starts with `$NAME`.
 * Values with no `$` reference resolve to themselves.
 */
export const resolveEnvIndirection = (
  value: string,
  readEnv: (name: string) => string | undefined = env,
): string | null => {
  const match = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value.trim());
  if (match === null || match[1] === undefined) {
    return value;
  }
  const resolved = readEnv(match[1]);
  return resolved === undefined || resolved === "" ? null : resolved;
};

const expandHome = (value: string, home: string): string =>
  value === "~" || value.startsWith("~/") ? `${home}${value.slice(1)}` : value;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const asStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
};

const asBoolean = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

const asInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) ? value : undefined;

const getObject = (
  config: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> | undefined =>
  config[key] !== null && typeof config[key] === "object" && !Array.isArray(config[key])
    ? (config[key] as Record<string, unknown>)
    : undefined;

const resolvePathValue = (
  value: string,
  workflowDir: string,
  resolveIndirection: (value: string) => string | null,
  home: string,
): string => {
  const resolved = resolveIndirection(value);
  if (resolved === null) {
    return value;
  }
  const homeExpanded = expandHome(resolved, home);
  return homeExpanded.startsWith("/") ? homeExpanded : `${workflowDir}/${homeExpanded}`;
};

const isAutonomyLevel = Schema.is(AutonomyLevelSchema);
const isTrackerKind = Schema.is(TrackerKindSchema);
const isApprovalAction = Schema.is(ApprovalActionSchema);

const asArrayOfObjects = (value: unknown): ReadonlyArray<Readonly<Record<string, unknown>>> =>
  Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> =>
          typeof entry === "object" && entry !== null && !Array.isArray(entry),
      )
    : [];

const asApprovalMode = (value: unknown): "auto" | "human" | "auto_if_required" | undefined =>
  value === "auto" || value === "human" || value === "auto_if_required" ? value : undefined;

const asApprovalScope = (value: unknown): "once" | "current_run" | "repository" | undefined =>
  value === "once" || value === "current_run" || value === "repository" ? value : undefined;

const asReviewRequirement = (
  value: unknown,
): "all-approve" | "any-approve" | "advisory" | undefined =>
  value === "all-approve" || value === "any-approve" || value === "advisory" ? value : undefined;

/**
 * Resolve a raw front-matter config map into a typed, validated effective
 * config. `workflowDir` is the directory containing `WORKFLOW.md`; relative
 * workspace roots resolve against it.
 *
 * Returns `Effect` with `{config, errors}`; `config` is present whenever at
 * least the required fields could be derived. The orchestrator treats any
 * validation error as a dispatch-blocking workflow status.
 */
export const resolveEffectiveConfig = (
  rawConfig: Readonly<Record<string, unknown>>,
  options: {
    readonly workflowDir: string;
    readonly repositoryPath: string;
    readonly workflowPath: string;
    readonly readEnv?: (name: string) => string | undefined;
    readonly providerResolver: (model?: string) => ProviderInstanceRef;
  },
): Effect.Effect<
  { readonly config: EffectiveWorkflowConfig | null; readonly errors: WorkflowValidationField[] },
  never
> =>
  Effect.sync(() => {
    const readEnv = options.readEnv ?? env;
    const resolveIndirection = (value: string) => resolveEnvIndirection(value, readEnv);
    const errors: WorkflowValidationField[] = [];
    const addError = (field: string, message: string) => {
      errors.push({ field, message });
    };

    const tracker = getObject(rawConfig, "tracker") ?? {};
    const trackerKind = asString(tracker.kind);
    if (trackerKind === undefined || !isTrackerKind(trackerKind)) {
      addError(
        "tracker.kind",
        "tracker.kind must be one of github, jira, linear, gitlab, asana, azure_boards, github_projects",
      );
    }
    const effectiveTrackerKind: TrackerKind =
      trackerKind !== undefined && isTrackerKind(trackerKind) ? trackerKind : "github";

    const requiredLabels = asStringArray(tracker.required_labels);
    const activeStates = asStringArray(tracker.active_states);
    const terminalStates = asStringArray(tracker.terminal_states);
    if (activeStates.length === 0) {
      addError("tracker.active_states", "tracker.active_states must be a non-empty list");
    }

    const polling = getObject(rawConfig, "polling") ?? {};
    const rawPollInterval = asInteger(polling.interval_ms);
    let pollIntervalMs = rawPollInterval ?? WORKFLOW_DEFAULTS.pollIntervalMs;
    if (rawPollInterval !== undefined) {
      if (rawPollInterval < POLL_INTERVAL_MIN_MS || rawPollInterval > POLL_INTERVAL_MAX_MS) {
        addError(
          "polling.interval_ms",
          `polling.interval_ms must be between ${POLL_INTERVAL_MIN_MS} and ${POLL_INTERVAL_MAX_MS}`,
        );
      }
    }

    const workspace = getObject(rawConfig, "workspace") ?? {};
    const workspaceRootRaw = asString(workspace.root) ?? "";
    const workspaceRoot =
      workspaceRootRaw === ""
        ? ""
        : resolvePathValue(
            workspaceRootRaw,
            options.workflowDir,
            resolveIndirection,
            readEnv("HOME") ?? "",
          );

    const agent = getObject(rawConfig, "agent") ?? {};
    const maxConcurrentAgents =
      asInteger(agent.max_concurrent_agents) ?? WORKFLOW_DEFAULTS.maxConcurrentAgents;
    const maxTurns = asInteger(agent.max_turns) ?? WORKFLOW_DEFAULTS.maxTurns;
    const maxAttempts = asInteger(agent.max_attempts) ?? WORKFLOW_DEFAULTS.maxAttempts;
    const initialRetryDelayMs =
      asInteger(agent.initial_retry_delay_ms) ?? WORKFLOW_DEFAULTS.initialRetryDelayMs;
    const maxRetryBackoffMs =
      asInteger(agent.max_retry_backoff_ms) ?? WORKFLOW_DEFAULTS.maxRetryBackoffMs;
    const maxRunDurationMs =
      asInteger(agent.max_run_duration_ms) ?? WORKFLOW_DEFAULTS.maxRunDurationMs;

    const codex = getObject(rawConfig, "codex") ?? {};
    const codexCommand = asString(codex.command) ?? WORKFLOW_DEFAULTS.codexCommand;
    if (codexCommand.trim().length === 0) {
      addError("codex.command", "codex.command must be present and non-empty");
    }

    const validation = getObject(rawConfig, "validation") ?? {};
    const validationRequired = asStringArray(validation.required);
    const validationTestPathPatterns = asStringArray(validation.test_path_patterns);

    const approvals = getObject(rawConfig, "approvals") ?? {};
    const liveRequests = getObject(rawConfig, "liveRequests") ?? {};
    const approvalsPolicies: Schema.Schema.Type<typeof ApprovalPolicyClassSchema>[] = [];
    for (const policy of asArrayOfObjects(approvals.policies)) {
      const action = asString(policy.action);
      const mode = asApprovalMode(policy.mode);
      const scope = asApprovalScope(policy.scope);
      if (
        action === undefined ||
        !isApprovalAction(action) ||
        mode === undefined ||
        scope === undefined
      ) {
        addError(
          "approvals.policies",
          "each approval policy needs a valid action, mode, and scope",
        );
        continue;
      }
      approvalsPolicies.push({ action, mode, scope });
    }

    const concurrency = getObject(rawConfig, "concurrency") ?? {};
    const hooks = getObject(rawConfig, "hooks") ?? {};

    const autonomyRaw = asString(rawConfig.autonomy);
    const autonomy: AutonomyLevel =
      autonomyRaw !== undefined && isAutonomyLevel(autonomyRaw)
        ? autonomyRaw
        : WORKFLOW_DEFAULTS.autonomy;

    const agentModel = asString(agent.model) ?? undefined;
    const provider = options.providerResolver(agentModel);

    const review = getObject(rawConfig, "review") ?? {};
    const reviewAgents: string[] = [];
    if (review.agents !== undefined) {
      if (!Array.isArray(review.agents)) {
        addError("review.agents", "review.agents must be a list of model names");
      } else {
        const seen = new Set<string>();
        review.agents.forEach((entry, index) => {
          const model = typeof entry === "string" ? entry.trim() : "";
          if (model.length === 0) {
            addError(`review.agents.${index}`, "reviewer model names must be non-empty strings");
          } else if (seen.has(model)) {
            addError(`review.agents.${index}`, `duplicate reviewer model '${model}'`);
          } else {
            seen.add(model);
            reviewAgents.push(model);
          }
        });
      }
    }
    const parsedReviewRequirement = asReviewRequirement(review.require);
    if (review.require !== undefined && parsedReviewRequirement === undefined) {
      addError(
        "review.require",
        "review.require must be one of all-approve, any-approve, advisory",
      );
    }
    const reviewRequirement = parsedReviewRequirement ?? "advisory";
    if (reviewRequirement !== "advisory" && reviewAgents.length === 0) {
      addError("review.agents", `${reviewRequirement} requires at least one reviewer model`);
    }

    const config = EffectiveWorkflowConfigSchema.make({
      repositoryPath: options.repositoryPath,
      workflowPath: options.workflowPath,
      trackerKind: effectiveTrackerKind,
      trackerRequiredLabels: requiredLabels,
      trackerActiveStates: activeStates,
      trackerTerminalStates: terminalStates,
      trackerProvider: getObject(tracker, "provider") ?? {},
      pollIntervalMs,
      workspaceRoot,
      autonomy,
      agentProvider: provider,
      agentModel,
      reviewAgents,
      reviewRequirement,
      maxConcurrentAgents,
      maxTurns,
      maxAttempts,
      initialRetryDelayMs,
      maxRetryBackoffMs,
      maxRunDurationMs,
      codexCommand,
      codexApprovalPolicy:
        (asString(codex.approval_policy) as EffectiveWorkflowConfig["codexApprovalPolicy"]) ??
        WORKFLOW_DEFAULTS.codexApprovalPolicy,
      codexThreadSandbox:
        (asString(codex.thread_sandbox) as EffectiveWorkflowConfig["codexThreadSandbox"]) ??
        WORKFLOW_DEFAULTS.codexThreadSandbox,
      codexTurnSandboxPolicy:
        (asString(
          codex.turn_sandbox_policy,
        ) as EffectiveWorkflowConfig["codexTurnSandboxPolicy"]) ??
        WORKFLOW_DEFAULTS.codexTurnSandboxPolicy,
      codexTurnTimeoutMs: asInteger(codex.turn_timeout_ms) ?? WORKFLOW_DEFAULTS.codexTurnTimeoutMs,
      codexReadTimeoutMs: asInteger(codex.read_timeout_ms) ?? WORKFLOW_DEFAULTS.codexReadTimeoutMs,
      codexStallTimeoutMs:
        asInteger(codex.stall_timeout_ms) ?? WORKFLOW_DEFAULTS.codexStallTimeoutMs,
      validationRequired,
      validationTestPathPatterns,
      approvalsBeforePush: asBoolean(approvals.before_push),
      approvalsBeforePullRequest: asBoolean(approvals.before_pull_request),
      approvalsBeforeMerge: asBoolean(approvals.before_merge),
      approvalsProtectedPaths: asStringArray(approvals.protected_paths),
      approvalsWaitTimeoutMs:
        asInteger(approvals.wait_timeout_ms) ?? WORKFLOW_DEFAULTS.approvalsWaitTimeoutMs,
      approvalsPolicies,
      concurrencyGlobal: asInteger(concurrency.global) ?? WORKFLOW_DEFAULTS.concurrencyGlobal,
      concurrencyRepository:
        asInteger(concurrency.repository) ?? WORKFLOW_DEFAULTS.concurrencyRepository,
      concurrencyProvider: asInteger(concurrency.provider) ?? undefined,
      concurrencyWorkflow: asInteger(concurrency.workflow) ?? undefined,
      hooksAfterCreate: asString(hooks.after_create),
      hooksBeforeRun: asString(hooks.before_run),
      hooksAfterRun: asString(hooks.after_run),
      hooksBeforeRemove: asString(hooks.before_remove),
      hooksTimeoutMs: asInteger(hooks.timeout_ms) ?? WORKFLOW_DEFAULTS.hooksTimeoutMs,
      // liveRequests.waitTimeoutMs is the canonical timeout covering both
      // approvals and user-input requests (plan 8.3.1). The legacy
      // approvals.wait_timeout_ms key resolves as a fallback so existing
      // workflows keep their bound.
      liveRequestsWaitTimeoutMs:
        asInteger(liveRequests.wait_timeout_ms) ??
        asInteger(approvals.wait_timeout_ms) ??
        WORKFLOW_DEFAULTS.liveRequestsWaitTimeoutMs,
      handoffState: asString(getObject(rawConfig, "handoff")?.state),
    });

    return { config: errors.length > 0 ? null : config, errors };
  });

export { ConfigValidationError };
