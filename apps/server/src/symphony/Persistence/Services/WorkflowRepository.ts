import type {
  EffectiveWorkflowConfig,
  WorkflowId,
  WorkflowRecord,
  WorkflowStatus,
} from "@neokod/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { SymphonyPersistenceError } from "../Errors.ts";

/**
 * WorkflowRepository - persistence for activated symphony workflows.
 *
 * `definition_json` holds the raw parsed `WORKFLOW.md` payload (config map +
 * prompt template); `effective_config_json` holds the last validated typed
 * config. A workflow with a validation error is stored with status `invalid`
 * and the message surfaced in the UI.
 */
export interface WorkflowRepositoryShape {
  readonly upsert: (
    workflow: WorkflowRecord,
  ) => Effect.Effect<WorkflowRecord, SymphonyPersistenceError>;
  readonly getById: (
    id: WorkflowId,
  ) => Effect.Effect<WorkflowRecord | null, SymphonyPersistenceError>;
  readonly getByRepository: (
    repositoryPath: string,
  ) => Effect.Effect<WorkflowRecord | null, SymphonyPersistenceError>;
  readonly list: () => Effect.Effect<WorkflowRecord[], SymphonyPersistenceError>;
  readonly setStatus: (
    id: WorkflowId,
    status: WorkflowStatus,
    validationError: string | null,
    effectiveConfig: EffectiveWorkflowConfig | null,
  ) => Effect.Effect<void, SymphonyPersistenceError>;
}

export class WorkflowRepository extends Context.Service<
  WorkflowRepository,
  WorkflowRepositoryShape
>()("neokod/symphony/Persistence/Services/WorkflowRepository") {}
