import {
  OrchestrationRuntimeItem,
  RuntimeItemId,
  RuntimeItemKind,
  RuntimeSessionId,
  ThreadId,
} from "@neokod/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const GetProjectionRuntimeItemInput = Schema.Struct({
  threadId: ThreadId,
  sessionId: RuntimeSessionId,
  kind: RuntimeItemKind,
  runtimeItemId: RuntimeItemId,
});
export type GetProjectionRuntimeItemInput = typeof GetProjectionRuntimeItemInput.Type;

export const ListProjectionRuntimeItemsInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionRuntimeItemsInput = typeof ListProjectionRuntimeItemsInput.Type;

export interface ProjectionRuntimeItemRepositoryShape {
  readonly upsert: (
    row: OrchestrationRuntimeItem,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getById: (
    input: GetProjectionRuntimeItemInput,
  ) => Effect.Effect<Option.Option<OrchestrationRuntimeItem>, ProjectionRepositoryError>;
  readonly listByThreadId: (
    input: ListProjectionRuntimeItemsInput,
  ) => Effect.Effect<ReadonlyArray<OrchestrationRuntimeItem>, ProjectionRepositoryError>;
  readonly deleteByThreadId: (
    input: ListProjectionRuntimeItemsInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionRuntimeItemRepository extends Context.Service<
  ProjectionRuntimeItemRepository,
  ProjectionRuntimeItemRepositoryShape
>()("neokod/persistence/Services/ProjectionRuntimeItems/ProjectionRuntimeItemRepository") {}
