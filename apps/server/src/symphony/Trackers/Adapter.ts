import type { NormalizedIssue, TrackerKind } from "@neokod/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { TrackerAdapterError } from "./Errors.ts";

/**
 * Tracker adapter contract (SPEC 11.1, PRD 25.2), shaped against the upstream
 * Elixir `SymphonyElixir.Tracker` behaviour (`.repos/symphony/.../tracker.ex`).
 *
 * The orchestrator only depends on the read callbacks. Mutations stay behind
 * optional provider-native agent tools so tracker-specific capabilities do not
 * leak into scheduler policy. The adapter is constructed from an effective
 * workflow config and bound to one session snapshot: a workflow reload applies
 * to future adapters, never to an in-flight one (SPEC 10.5).
 */
export interface TrackerAdapter {
  /** Validate configuration: states, scope, credentials. Must succeed before a workflow can run. */
  readonly validateConfiguration: () => Effect.Effect<void, TrackerAdapterError>;
  /** Candidate issues visible in scope for the active states, including `dispatchable: false`. */
  readonly listCandidateIssues: () => Effect.Effect<NormalizedIssue[], TrackerAdapterError>;
  /** Current snapshots for specific opaque dispatch IDs; complete for the requested set. */
  readonly refreshIssues: (
    ids: ReadonlyArray<string>,
  ) => Effect.Effect<NormalizedIssue[], TrackerAdapterError>;
  /** Single issue by opaque dispatch ID. */
  readonly getIssue: (id: string) => Effect.Effect<NormalizedIssue, TrackerAdapterError>;
  /** Environment names that MUST be removed from the coding-agent child process (SPEC 15.3). */
  readonly secretEnvironmentNames: () => ReadonlyArray<string>;
  /** Adapter availability probe for health/activation validation. */
  readonly probe: () => Effect.Effect<void, TrackerAdapterError>;
  /** Documented contract: supported keys, defaults, secrets, scope, normalization, errors. */
  readonly profile: () => AdapterProfile;
}

/**
 * Documented adapter profile (SPEC 11.2). Each adapter ships one under
 * `docs/integrations/`; the machine-readable shape backs the Trackers view and
 * activation validation.
 */
export interface AdapterProfile {
  readonly kind: TrackerKind;
  readonly displayName: string;
  readonly activeStates: ReadonlyArray<string>;
  readonly terminalStates: ReadonlyArray<string>;
  readonly providerKeys: ReadonlyArray<{
    readonly key: string;
    readonly required: boolean;
    readonly secret: boolean;
    readonly description: string;
  }>;
  readonly scopeSelection: string;
  readonly pagination: string;
  readonly idMapping: string;
  readonly normalization: string;
  readonly errorMapping: string;
  readonly agentTools: ReadonlyArray<{
    readonly name: string;
    readonly mutatesTracker: boolean;
  }>;
}

export class TrackerAdapterRegistry extends Context.Service<
  TrackerAdapterRegistry,
  {
    readonly resolve: (
      kind: TrackerKind,
      providerConfig: Readonly<Record<string, unknown>>,
      options?: {
        readonly repositoryPath?: string;
        readonly env?: Readonly<Record<string, string | undefined>>;
      },
    ) => Effect.Effect<TrackerAdapter, TrackerAdapterError>;
    readonly listKinds: () => ReadonlyArray<TrackerKind>;
  }
>()("neokod/symphony/Trackers/Adapter/TrackerAdapterRegistry") {}
