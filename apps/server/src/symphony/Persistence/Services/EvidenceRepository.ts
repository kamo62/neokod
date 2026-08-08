import type { EvidenceBundle, WorkItemId } from "@neokod/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { SymphonyPersistenceError } from "../Errors.ts";

/**
 * EvidenceRepository - persistence for assembled evidence bundles.
 *
 * One row per work item (`symphony_evidence`, created in migration 036). The
 * bundle is assembled by the Evidence service at a run stopping point and
 * written here under the work item id so the review UI and later phases can
 * read it back without re-deriving it. The bundle is replaced on re-assembly
 * (a new attempt overwrites the previous bundle).
 */
export interface EvidenceRepositoryShape {
  readonly upsert: (
    workItemId: WorkItemId,
    bundle: EvidenceBundle,
  ) => Effect.Effect<EvidenceBundle, SymphonyPersistenceError>;

  readonly getByWorkItem: (
    workItemId: WorkItemId,
  ) => Effect.Effect<EvidenceBundle | null, SymphonyPersistenceError>;
}

export class EvidenceRepository extends Context.Service<
  EvidenceRepository,
  EvidenceRepositoryShape
>()("neokod/symphony/Persistence/Services/EvidenceRepository") {}
