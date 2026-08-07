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

export interface WorkflowContentResult {
  readonly path: string;
  readonly content: string;
}

export interface WorkflowSaveResult {
  readonly ok: boolean;
  readonly validationError?: string;
}

export interface WorkflowCreateResult {
  readonly workflowId: WorkflowId;
  readonly validationError?: string;
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

  /**
   * Read the raw WORKFLOW.md text for the in-app editor (PRD 12.3). The
   * file path always comes from the persisted `WorkflowRecord`, never from
   * client input.
   */
  readonly getWorkflowContent: (
    workflowId: WorkflowId,
  ) => Effect.Effect<WorkflowContentResult, WorkflowLoadError>;

  /**
   * Write new WORKFLOW.md content atomically, then re-parse it through
   * `loadWorkflow` so the record's status/validationError reflect the new
   * content. The write always lands even when the new content is invalid —
   * the record just moves to `invalid` and the result carries
   * `validationError` (the loader already records that; this just surfaces
   * it to the RPC caller instead of swallowing it).
   */
  readonly saveWorkflowContent: (
    workflowId: WorkflowId,
    content: string,
  ) => Effect.Effect<WorkflowSaveResult, WorkflowLoadError>;

  /**
   * Create a brand-new WORKFLOW.md for `repositoryPath` and load it (in-app
   * "New workflow" dialog). Refuses when a WORKFLOW.md already exists at
   * that path — never a silent overwrite. Callers are responsible for
   * confirming `repositoryPath` is a known tracked project root before
   * calling this; it only guards the filesystem write. Content is
   * re-parsed through `loadWorkflow` exactly like `saveWorkflowContent`:
   * invalid content still creates the file and record, landing it as
   * `invalid` with `validationError` set rather than being silently
   * dropped.
   */
  readonly createWorkflow: (input: {
    readonly repositoryPath: string;
    readonly content: string;
  }) => Effect.Effect<WorkflowCreateResult, WorkflowLoadError>;
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

  const getWorkflowContent: WorkflowLoader["getWorkflowContent"] = (workflowId) =>
    Effect.gen(function* () {
      const record = yield* workflows
        .getById(workflowId)
        .pipe(Effect.mapError((cause) => new WorkflowLoadError({ message: cause.message })));
      if (record === null) {
        return yield* Effect.fail(
          new WorkflowLoadError({ message: `Workflow not found: ${workflowId}` }),
        );
      }
      const content = yield* fileSystem
        .readFileString(record.workflowPath)
        .pipe(Effect.mapError((cause) => new WorkflowLoadError({ message: cause.message })));
      return { path: record.workflowPath, content };
    });

  const saveWorkflowContent: WorkflowLoader["saveWorkflowContent"] = (workflowId, content) =>
    Effect.gen(function* () {
      const record = yield* workflows
        .getById(workflowId)
        .pipe(Effect.mapError((cause) => new WorkflowLoadError({ message: cause.message })));
      if (record === null) {
        return yield* Effect.fail(
          new WorkflowLoadError({ message: `Workflow not found: ${workflowId}` }),
        );
      }

      // Atomic write: temp file in a scoped temp directory beside the
      // target, then rename (rename is atomic on the same filesystem — no
      // reader ever observes a partially written WORKFLOW.md). Mirrors
      // atomicWrite.ts's approach; inlined here since this closure holds
      // plain `fileSystem`/`path` values rather than yielding them from
      // Effect context.
      const targetDirectory = path.dirname(record.workflowPath);
      yield* fileSystem
        .makeDirectory(targetDirectory, { recursive: true })
        .pipe(Effect.mapError((cause) => new WorkflowLoadError({ message: cause.message })));
      yield* Effect.scoped(
        Effect.gen(function* () {
          const tempDirectory = yield* fileSystem.makeTempDirectoryScoped({
            directory: targetDirectory,
            prefix: `${path.basename(record.workflowPath)}.`,
          });
          const tempPath = path.join(tempDirectory, "contents.tmp");
          yield* fileSystem.writeFileString(tempPath, content);
          yield* fileSystem.rename(tempPath, record.workflowPath);
        }),
      ).pipe(Effect.mapError((cause) => new WorkflowLoadError({ message: cause.message })));

      // Re-parse through the normal loader path: a broken file lands as
      // `invalid` with `validationError` set (existing behaviour), it is
      // never dropped or left un-upserted.
      const result = yield* loadWorkflow({ repositoryPath: record.repositoryPath });
      return result.errors.length === 0
        ? { ok: true }
        : { ok: true, validationError: summarizeErrors(result.errors) };
    });

  const createWorkflow: WorkflowLoader["createWorkflow"] = (input) =>
    Effect.gen(function* () {
      const workflowPath = path.join(input.repositoryPath, "WORKFLOW.md");

      yield* fileSystem
        .makeDirectory(input.repositoryPath, { recursive: true })
        .pipe(Effect.mapError((cause) => new WorkflowLoadError({ message: cause.message })));

      // Atomic create-if-absent: write the full content to a temp file
      // beside the target, then `link` it into place instead of `rename`.
      // `link` fails with `AlreadyExists` when the destination is already
      // there, so a WORKFLOW.md that appears between the caller's check and
      // this write is never silently overwritten — `rename` would just
      // replace it on POSIX. This mirrors the rename-based atomic write in
      // `saveWorkflowContent` above, swapping the final step for the one
      // that also gives this call its refuse-if-exists guarantee.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const tempDirectory = yield* fileSystem.makeTempDirectoryScoped({
            directory: input.repositoryPath,
            prefix: "WORKFLOW.md.",
          });
          const tempPath = path.join(tempDirectory, "contents.tmp");
          yield* fileSystem.writeFileString(tempPath, input.content);
          yield* fileSystem.link(tempPath, workflowPath);
        }),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new WorkflowLoadError({
              message:
                cause.reason._tag === "AlreadyExists"
                  ? `WORKFLOW.md already exists at ${workflowPath}`
                  : cause.message,
            }),
        ),
      );

      const result = yield* loadWorkflow({ repositoryPath: input.repositoryPath });
      return result.errors.length === 0
        ? { workflowId: result.workflow.id }
        : { workflowId: result.workflow.id, validationError: summarizeErrors(result.errors) };
    });

  return { loadWorkflow, reloadChanged, getWorkflowContent, saveWorkflowContent, createWorkflow };
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
