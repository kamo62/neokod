import type { EffectiveWorkflowConfig, TrackersSettings } from "@neokod/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerSettingsService } from "../../serverSettings.ts";
import type { TrackerAdapterRegistry } from "../Trackers/Adapter.ts";
import { effectiveTrackerProvider } from "../Trackers/SettingsOverlay.ts";

/**
 * TrackerEnablement - app-level gate on which trackers Symphony may use.
 *
 * The Tracking settings surface (`ServerSettings.trackers`) is the control
 * plane: a tracker that is disabled there cannot be used by any activated
 * workflow, regardless of what `WORKFLOW.md` declares. This keeps the
 * enable/disable toggles in the Tracking panel authoritative (PRD 12.4: a
 * workflow must not run until its tracker is properly configured).
 *
 * The live layer reads the current trackers settings at layer construction and
 * serves them from a `Ref`, so the orchestrator does not depend on the settings
 * service directly (which would leak its runtime requirements everywhere).
 */
export class TrackerEnablement extends Context.Service<
  TrackerEnablement,
  {
    /** Validate a workflow's tracker kind is enabled in app settings. */
    readonly validateTrackerEnabled: (
      config: EffectiveWorkflowConfig,
    ) => Effect.Effect<void, TrackerDisabledError>;
    readonly resolveProvider: (
      config: EffectiveWorkflowConfig,
    ) => Effect.Effect<Readonly<Record<string, unknown>>>;
  }
>()("neokod/symphony/Orchestrator/TrackerEnablement") {}

export class TrackerDisabledError extends Error {
  readonly trackerKind: string;
  readonly repositoryPath: string;

  constructor(trackerKind: string, repositoryPath: string) {
    super(
      `Tracker "${trackerKind}" is disabled for ${repositoryPath}. Enable it in Settings > Tracking first.`,
    );
    this.name = "TrackerDisabledError";
    this.trackerKind = trackerKind;
    this.repositoryPath = repositoryPath;
  }
}

export const makeTrackerEnablement = (
  readTrackers: () => Effect.Effect<TrackersSettings>,
): TrackerEnablement["Service"] => ({
  validateTrackerEnabled: (config) =>
    Effect.gen(function* () {
      const trackers = yield* readTrackers();
      const tracker = trackers[config.trackerKind];
      if (tracker === undefined || !tracker.enabled) {
        return yield* Effect.fail(
          new TrackerDisabledError(config.trackerKind, config.repositoryPath),
        );
      }
    }),
  resolveProvider: (config) =>
    readTrackers().pipe(
      Effect.map((trackers) =>
        effectiveTrackerProvider(config.trackerKind, config.trackerProvider, trackers),
      ),
    ),
});

export const resolveTrackerAdapter = (
  registry: TrackerAdapterRegistry["Service"],
  enablement: TrackerEnablement["Service"],
  config: EffectiveWorkflowConfig,
) =>
  enablement.resolveProvider(config).pipe(
    Effect.flatMap((provider) =>
      registry.resolve(config.trackerKind, provider, {
        repositoryPath: config.repositoryPath,
        env: process.env,
      }),
    ),
  );

export const TrackerEnablementLive = Layer.effect(
  TrackerEnablement,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    return makeTrackerEnablement(() =>
      serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.trackers),
        Effect.catch(() => Effect.succeed({})),
      ),
    );
  }),
);
