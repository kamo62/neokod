import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderInstanceRef,
  WorkflowId,
  type EffectiveWorkflowConfig,
  type WorkflowRecord,
  type WorkflowValidationField,
} from "@neokod/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { parseWorkflowContent } from "./Parser.ts";
import { resolveEffectiveConfig } from "./Config.ts";
import { WorkflowRepository } from "../Persistence/Services/WorkflowRepository.ts";
import { nowIso } from "../Domain/Time.ts";

export interface WorkflowLoadResult {
  readonly workflow: WorkflowRecord;
  readonly errors: ReadonlyArray<WorkflowValidationField>;
}

export interface WorkflowLoader {
  /**
   * Load WORKFLOW.md from a repository path, parse it, resolve the effective
   * config, and upsert the workflow record (production wiring; audit item 8
   * — the parser/config resolver previously had ZERO production callers).
   * A file that fails to parse or validate is recorded as `invalid` (still
   * upserted so the UI can show why) rather than dropped.
   */
  readonly loadWorkflow: (input: {
    readonly repositoryPath: string;
    readonly providerResolver?: (model?: string) => ProviderInstanceRef;
  }) => Effect.Effect<WorkflowLoadResult, WorkflowLoadError>;

  /**
   * Reload all workflows whose WORKFLOW.md mtime changed since the last
   * load (plan 6.4 dynamic reload; audit item 8). Called each poll tick.
   */
  readonly reloadChanged: (input: {
    readonly repositoryPath: string;
    readonly providerResolver?: (model?: string) => ProviderInstanceRef;
  }) => Effect.Effect<boolean, WorkflowLoadError>;
}

export class WorkflowLoadError extends Schema.TaggedErrorClass<WorkflowLoadError>()(
  "WorkflowLoadError",
  { message: Schema.String },
) {}

const DEFAULT_PROVIDER_RESOLVER = (_model?: string): ProviderInstanceRef =>
  ProviderInstanceRef.make({
    instanceId: ProviderInstanceId.make("codex_default"),
    driver: ProviderDriverKind.make("codex"),
  });

const deriveWorkflowId = (repositoryPath: string): WorkflowId =>
  WorkflowId.make(`wf-${repositoryPath.replace(/[^a-zA-Z0-9._-]/g, "_")}`);

export const makeWorkflowLoader = (deps: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly workflows: WorkflowRepository["Service"];
}): WorkflowLoader => {
  const { fileSystem, path, workflows } = deps;

  const loadWorkflow: WorkflowLoader["loadWorkflow"] = (input) =>
    Effect.gen(function* () {
      const workflowPath = path.join(input.repositoryPath, "WORKFLOW.md");
      const content = yield* fileSystem
        .readFileString(workflowPath)
        .pipe(Effect.mapError((cause) => new WorkflowLoadError({ message: cause.message })));
      const definition = parseWorkflowContent(content);
      const resolved = yield* resolveEffectiveConfig(definition.config, {
        workflowDir: input.repositoryPath,
        repositoryPath: input.repositoryPath,
        workflowPath,
        providerResolver: input.providerResolver ?? DEFAULT_PROVIDER_RESOLVER,
      });
      const errors = resolved.errors;
      const now = yield* nowIso;
      const id = deriveWorkflowId(input.repositoryPath);
      const existing = yield* workflows.getById(id).pipe(Effect.catch(() => Effect.succeed(null)));
      const validationError = errors.length > 0 ? summarizeErrors(errors) : null;
      const record: WorkflowRecord = {
        id,
        repositoryPath: input.repositoryPath,
        workflowPath,
        status: errors.length > 0 ? "invalid" : (existing?.status ?? "active"),
        autonomy: resolved.config?.autonomy ?? "observe",
        validationError,
        definition,
        effectiveConfig: resolved.config,
        enabledAt: existing?.enabledAt ?? now,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      yield* workflows
        .upsert(record)
        .pipe(Effect.mapError((cause) => new WorkflowLoadError({ message: cause.message })));
      return { workflow: record, errors };
    });

  const reloadChanged: WorkflowLoader["reloadChanged"] = (input) =>
    Effect.gen(function* () {
      const id = deriveWorkflowId(input.repositoryPath);
      const existing = yield* workflows.getById(id).pipe(Effect.catch(() => Effect.succeed(null)));
      if (existing === null) {
        yield* loadWorkflow(input).pipe(Effect.catch(() => Effect.void));
        return true;
      }
      const workflowPath = path.join(input.repositoryPath, "WORKFLOW.md");
      const stat = yield* fileSystem
        .stat(workflowPath)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (stat === null) {
        return false;
      }
      const mtimeIso = stat.mtime._tag === "Some" ? stat.mtime.value.toISOString() : null;
      // Compare against the stored record's updatedAt: a changed file gets
      // re-loaded (plan 6.4). Best-effort — a stat that cannot be compared
      // falls back to always-reload.
      if (mtimeIso !== null && existing.updatedAt >= mtimeIso) {
        return false;
      }
      yield* loadWorkflow(input).pipe(Effect.catch(() => Effect.void));
      return true;
    });

  return { loadWorkflow, reloadChanged };
};

const summarizeErrors = (errors: ReadonlyArray<WorkflowValidationField>): string =>
  errors.map((error) => `${error.field}: ${error.message}`).join("; ");

export type EffectiveWorkflowConfigType = EffectiveWorkflowConfig;

export class WorkflowLoaderService extends Context.Service<WorkflowLoaderService, WorkflowLoader>()(
  "neokod/symphony/Workflow/WorkflowLoader",
) {}

export const WorkflowLoaderLive: Layer.Layer<
  WorkflowLoaderService,
  never,
  FileSystem.FileSystem | Path.Path | WorkflowRepository
> = Layer.effect(
  WorkflowLoaderService,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workflows = yield* WorkflowRepository;
    return makeWorkflowLoader({ fileSystem, path, workflows });
  }),
);
