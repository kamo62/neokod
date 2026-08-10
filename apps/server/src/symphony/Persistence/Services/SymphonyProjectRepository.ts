import type { ProjectId, SymphonyProject, SymphonyProjectId } from "@neokod/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { SymphonyPersistenceError } from "../Errors.ts";

export interface SymphonyProjectRepositoryShape {
  readonly create: (
    project: SymphonyProject,
  ) => Effect.Effect<SymphonyProject, SymphonyPersistenceError>;
  readonly getById: (
    id: SymphonyProjectId,
  ) => Effect.Effect<SymphonyProject | null, SymphonyPersistenceError>;
  readonly getByCodeProjectId: (
    codeProjectId: ProjectId,
  ) => Effect.Effect<SymphonyProject | null, SymphonyPersistenceError>;
  readonly list: () => Effect.Effect<SymphonyProject[], SymphonyPersistenceError>;
  readonly update: (
    project: SymphonyProject,
    expectedRevision: number,
  ) => Effect.Effect<SymphonyProject | null, SymphonyPersistenceError>;
}

export class SymphonyProjectRepository extends Context.Service<
  SymphonyProjectRepository,
  SymphonyProjectRepositoryShape
>()("neokod/symphony/Persistence/Services/SymphonyProjectRepository") {}
