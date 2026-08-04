/**
 * Anonymous PostHog telemetry service.
 *
 * Persists an installation-scoped anonymous identifier, buffers events in
 * memory, and flushes batches over Effect's HTTP client.
 *
 * Delivery is best effort. Consecutive send failures back off exponentially
 * up to a ceiling, the first failure of a streak is logged once at warning
 * level, and a batch that keeps failing is dropped after a bounded number of
 * attempts so it cannot block newer events forever.
 *
 * @module AnalyticsService
 */
import { HostProcessArchitecture, HostProcessPlatform } from "@neokod/shared/hostProcess";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import { getTelemetryIdentifier } from "./Identify.ts";

interface BufferedAnalyticsEvent {
  readonly event: string;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly capturedAt: string;
}

/** Interval between flush attempts while delivery is healthy. */
const flushIntervalMillis = 1_000;

/** Delay before the first retry after a send failure. Doubles per consecutive failure. */
const failureBackoffInitialMillis = 5_000;

/** Ceiling for the retry delay. An unreachable endpoint is probed at most this often. */
const failureBackoffMaxMillis = 300_000;

/**
 * Send attempts a single batch gets before it is dropped. With the backoff
 * schedule above the batch at the head of the buffer survives roughly ten
 * minutes of continuous failure, so a brief outage loses nothing while a
 * batch the endpoint keeps rejecting cannot block newer events forever.
 */
const maxSendAttemptsPerBatch = 8;

interface FlushFailureState {
  /** Send failures since the last successful send. Resets on success. */
  readonly consecutiveFailures: number;
  /** Failed attempts charged to the batch currently at the head of the buffer. */
  readonly headBatchAttempts: number;
  /** Events discarded by the attempt cap since the last successful send. */
  readonly droppedEventsSinceLastSuccess: number;
}

const initialFlushFailureState: FlushFailureState = {
  consecutiveFailures: 0,
  headBatchAttempts: 0,
  droppedEventsSinceLastSuccess: 0,
};

const failureBackoffMillis = (consecutiveFailures: number) =>
  Math.min(
    failureBackoffMaxMillis,
    failureBackoffInitialMillis * 2 ** Math.min(consecutiveFailures - 1, 8),
  );

interface SendFailureReport {
  readonly error: unknown;
  readonly consecutiveFailures: number;
  readonly batchAttempts: number;
  readonly droppedBatch: boolean;
  readonly batchSize: number;
}

// The `T3CODE_*` fallbacks that used to sit alongside each `NEOKOD_*` name are
// gone. They were inherited from upstream and, for the key and host in
// particular, were a live path back to upstream's PostHog project: setting
// `T3CODE_POSTHOG_KEY` would have redirected this fork's telemetry there.
// Neokod never touches that instance, so the fallbacks are removed rather than
// deprecated.

const TelemetryEnvConfig = Config.all({
  /**
   * Neokod's own PostHog project key, on the EU cloud.
   *
   * This previously defaulted to the upstream T3 Code project key, inherited
   * verbatim when the fork rebranded the env var names, so every install
   * reported into upstream's analytics. Replaced with Neokod's own project.
   *
   * `phc_` keys are PostHog public project keys, designed to be shipped in
   * client code, so hardcoding one here is not a secret leak.
   */
  posthogKey: Config.string("NEOKOD_POSTHOG_KEY").pipe(
    Config.withDefault("phc_ChMMKsYfCWTbG48KrKYZVvAeBPEGYBBX7fKUVBRvGAaE"),
  ),
  /** EU cloud, matching the project the key above belongs to. */
  posthogHost: Config.string("NEOKOD_POSTHOG_HOST").pipe(
    Config.withDefault("https://eu.i.posthog.com"),
  ),
  /**
   * Opt-in, per PRD section 21 ("Telemetry must be opt-in unless required for
   * local product diagnostics"). This defaulted to `true`, which contradicted
   * that requirement and shipped data without consent.
   */
  enabled: Config.boolean("NEOKOD_TELEMETRY_ENABLED").pipe(Config.withDefault(false)),
  flushBatchSize: Config.number("NEOKOD_TELEMETRY_FLUSH_BATCH_SIZE").pipe(Config.withDefault(20)),
  maxBufferedEvents: Config.number("NEOKOD_TELEMETRY_MAX_BUFFERED_EVENTS").pipe(
    Config.withDefault(1_000),
  ),
  wslDistroName: Config.string("WSL_DISTRO_NAME").pipe(Config.option),
});

export class AnalyticsService extends Context.Service<
  AnalyticsService,
  {
    /** Record an anonymous event for best-effort buffered delivery. */
    readonly record: (
      event: string,
      properties?: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<void>;

    /** Flush all currently queued telemetry events. */
    readonly flush: Effect.Effect<void>;
  }
>()("neokod/telemetry/AnalyticsService") {
  /** No-op layer for callers that intentionally disable telemetry. */
  static readonly layerTest = Layer.succeed(
    AnalyticsService,
    AnalyticsService.of({
      record: () => Effect.void,
      flush: Effect.void,
    }),
  );
}

export const make = Effect.gen(function* () {
  const telemetryConfig = yield* TelemetryEnvConfig;
  const httpClient = yield* HttpClient.HttpClient;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const identifier = yield* getTelemetryIdentifier;
  const bufferRef = yield* Ref.make<ReadonlyArray<BufferedAnalyticsEvent>>([]);
  const clientType = serverConfig.mode === "desktop" ? "desktop-app" : "cli-web-client";
  const hostPlatform = yield* HostProcessPlatform;
  const hostArchitecture = yield* HostProcessArchitecture;

  const enqueueBufferedEvent = (event: string, properties?: Readonly<Record<string, unknown>>) =>
    Effect.flatMap(DateTime.now, (now) =>
      Ref.modify(bufferRef, (current) => {
        const appended = [
          ...current,
          {
            event,
            ...(properties ? { properties } : {}),
            capturedAt: DateTime.formatIso(now),
          } satisfies BufferedAnalyticsEvent,
        ];

        const next =
          appended.length > telemetryConfig.maxBufferedEvents
            ? appended.slice(appended.length - telemetryConfig.maxBufferedEvents)
            : appended;

        return [
          {
            size: next.length,
            dropped: next.length !== appended.length,
          } as const,
          next,
        ] as const;
      }),
    );

  const sendBatch = Effect.fn("AnalyticsService.sendBatch")(function* (
    events: ReadonlyArray<BufferedAnalyticsEvent>,
  ) {
    if (!telemetryConfig.enabled || !identifier) return;

    const payload = {
      api_key: telemetryConfig.posthogKey,
      batch: events.map((event) => ({
        event: event.event,
        distinct_id: identifier,
        properties: {
          ...event.properties,
          $process_person_profile: false,
          platform: hostPlatform,
          wsl: Option.getOrUndefined(telemetryConfig.wslDistroName),
          arch: hostArchitecture,
          neokodVersion: packageJson.version,
          clientType,
        },
        timestamp: event.capturedAt,
      })),
    };

    yield* HttpClientRequest.post(`${telemetryConfig.posthogHost}/batch/`).pipe(
      HttpClientRequest.bodyJson(payload),
      Effect.flatMap(httpClient.execute),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
    );
  });

  const failureStateRef = yield* Ref.make<FlushFailureState>(initialFlushFailureState);

  const registerSendFailure = (batch: ReadonlyArray<BufferedAnalyticsEvent>, error: unknown) =>
    Ref.modify(failureStateRef, (state) => {
      const batchAttempts = state.headBatchAttempts + 1;
      const droppedBatch = batchAttempts >= maxSendAttemptsPerBatch;
      const consecutiveFailures = state.consecutiveFailures + 1;
      return [
        {
          error,
          consecutiveFailures,
          batchAttempts,
          droppedBatch,
          batchSize: batch.length,
        } satisfies SendFailureReport,
        {
          consecutiveFailures,
          headBatchAttempts: droppedBatch ? 0 : batchAttempts,
          droppedEventsSinceLastSuccess:
            state.droppedEventsSinceLastSuccess + (droppedBatch ? batch.length : 0),
        },
      ] as const;
    }).pipe(
      Effect.tap((report) =>
        report.droppedBatch
          ? Effect.void
          : Ref.update(bufferRef, (current) => [...batch, ...current]),
      ),
    );

  const reportSendFailure = (report: SendFailureReport) =>
    Effect.gen(function* () {
      const nextRetryMillis = failureBackoffMillis(report.consecutiveFailures);
      if (report.droppedBatch) {
        yield* Effect.logDebug("dropping telemetry batch after repeated send failures", {
          attempts: report.batchAttempts,
          droppedEvents: report.batchSize,
        });
      }
      if (report.consecutiveFailures === 1) {
        yield* Effect.logWarning("Failed to flush telemetry", {
          cause: report.error,
          nextRetryMillis,
        });
      } else {
        yield* Effect.logDebug("Telemetry flush still failing", {
          consecutiveFailures: report.consecutiveFailures,
          nextRetryMillis,
        });
      }
    });

  const flush: AnalyticsService["Service"]["flush"] = Effect.gen(function* () {
    while (true) {
      const batch = yield* Ref.modify(bufferRef, (current) => {
        if (current.length === 0) {
          return [[] as ReadonlyArray<BufferedAnalyticsEvent>, current] as const;
        }
        const nextBatch = current.slice(0, telemetryConfig.flushBatchSize);
        const remaining = current.slice(nextBatch.length);
        return [nextBatch, remaining] as const;
      });

      if (batch.length === 0) {
        return;
      }

      const failure = yield* sendBatch(batch).pipe(
        Effect.map(() => null),
        Effect.catch((error) => registerSendFailure(batch, error)),
      );

      if (failure !== null) {
        yield* reportSendFailure(failure);
        return;
      }

      const previous = yield* Ref.getAndSet(failureStateRef, initialFlushFailureState);
      if (previous.consecutiveFailures > 0) {
        yield* Effect.logInfo("Telemetry delivery recovered", {
          failedAttempts: previous.consecutiveFailures,
          droppedEvents: previous.droppedEventsSinceLastSuccess,
        });
      }
    }
  });

  const record: AnalyticsService["Service"]["record"] = Effect.fn("AnalyticsService.record")(
    function* (event, properties) {
      if (!telemetryConfig.enabled || !identifier) return;

      const enqueueResult = yield* enqueueBufferedEvent(event, properties);
      if (enqueueResult.dropped) {
        yield* Effect.logDebug("analytics buffer full; dropping oldest event", {
          size: enqueueResult.size,
          event,
        });
      }
    },
  );

  const scheduledFlush = Effect.gen(function* () {
    const { consecutiveFailures } = yield* Ref.get(failureStateRef);
    const delayMillis =
      consecutiveFailures === 0 ? flushIntervalMillis : failureBackoffMillis(consecutiveFailures);
    yield* Effect.sleep(delayMillis);
    yield* flush;
  });

  yield* Effect.forever(scheduledFlush, {
    disableYield: true,
  }).pipe(Effect.forkScoped);

  yield* Effect.addFinalizer(() => flush);

  return AnalyticsService.of({ record, flush });
});

export const layer = Layer.effect(AnalyticsService, make);

export const layerTest = AnalyticsService.layerTest;
