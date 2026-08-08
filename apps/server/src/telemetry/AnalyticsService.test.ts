import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ServerSettingsError,
  type ServerSettings as ServerSettingsModel,
} from "@neokod/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as PubSub from "effect/PubSub";
import { TestClock } from "effect/testing";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { getTelemetryIdentifier } from "./Identify.ts";
import { drainAnalyticsErrorEvents, publishAnalyticsErrorEvent } from "./errorEvents.ts";
import * as AnalyticsService from "./AnalyticsService.ts";

interface RecordedBatchRequest {
  readonly path: string;
  readonly body: {
    readonly batch?: ReadonlyArray<{
      readonly event?: string;
      readonly properties?: {
        readonly index?: number;
        readonly clientType?: string;
        readonly errorName?: string;
        readonly level?: string;
      };
    }>;
  } | null;
}

interface RecordedBatchBody {
  readonly batch: ReadonlyArray<{
    readonly event?: string;
    readonly properties?: {
      readonly index?: number;
      readonly clientType?: string;
    };
  }>;
}

const transportFailure = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.fail(
    new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({
        request,
        cause: new Error("fetch failed"),
      }),
    }),
  );

const successResponse = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}", { status: 200 })));

const batchEventNames = (request: HttpClientRequest.HttpClientRequest): ReadonlyArray<string> => {
  const body = request.body;
  if (body._tag !== "Uint8Array") {
    return [];
  }
  const parsed = JSON.parse(new TextDecoder().decode(body.body)) as {
    readonly batch?: ReadonlyArray<{ readonly event?: string }>;
  };
  return (parsed.batch ?? []).flatMap((entry) =>
    typeof entry.event === "string" ? [entry.event] : [],
  );
};

const mockClientConfigLayer = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    NEOKOD_TELEMETRY_ENABLED: true,
    NEOKOD_POSTHOG_KEY: "phc_test_key",
    NEOKOD_POSTHOG_HOST: "http://telemetry.test",
    NEOKOD_TELEMETRY_FLUSH_BATCH_SIZE: 20,
  }),
);

const mockClientRuntimeLayer = (
  client: HttpClient.HttpClient,
  prefix: string,
  serverSettingsLayer = ServerSettings.ServerSettingsService.layerTest(),
) =>
  AnalyticsService.layer.pipe(
    Layer.provideMerge(ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix })),
    Layer.provideMerge(serverSettingsLayer),
    Layer.provide(mockClientConfigLayer),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
  );

it.layer(NodeServices.layer)("AnalyticsService test", (it) => {
  it.effect("flush drains all buffered events across multiple batches", () =>
    Effect.gen(function* () {
      const capturedRequests: Array<RecordedBatchRequest> = [];
      const serverConfigLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
        prefix: "neokod-telemetry-base-",
      });

      const telemetryLayer = AnalyticsService.layer.pipe(
        Layer.provideMerge(serverConfigLayer),
        Layer.provideMerge(ServerSettings.ServerSettingsService.layerTest()),
      );
      const configLayer = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          NEOKOD_TELEMETRY_ENABLED: true,
          NEOKOD_POSTHOG_KEY: "phc_test_key",
          NEOKOD_POSTHOG_HOST: "",
          NEOKOD_TELEMETRY_FLUSH_BATCH_SIZE: 20,
        }),
      );
      const batchServerLayer = HttpServer.serve(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (request.method !== "POST") {
            return HttpServerResponse.empty({ status: 404 });
          }

          const payload = yield* request.json.pipe(
            Effect.map((body) => body as RecordedBatchRequest["body"]),
            Effect.orElseSucceed(() => null),
          );

          capturedRequests.push({ path: request.url, body: payload });

          return HttpServerResponse.jsonUnsafe({});
        }),
      );
      const runtimeLayer = telemetryLayer.pipe(
        Layer.provide(configLayer),
        Layer.provideMerge(NodeHttpServer.layerTest),
      );

      yield* Effect.gen(function* () {
        yield* Layer.launch(batchServerLayer).pipe(Effect.forkScoped);
        const telemetryIdentifier = yield* getTelemetryIdentifier;
        assert.equal(telemetryIdentifier !== null, true);
        const analytics = yield* AnalyticsService.AnalyticsService;

        for (let index = 0; index < 45; index += 1) {
          yield* analytics.record("test.flush.drain", { index });
        }

        yield* analytics.flush;
      }).pipe(Effect.provide(runtimeLayer));

      const batchRequests = capturedRequests.filter(
        (request): request is RecordedBatchRequest & { readonly body: RecordedBatchBody } =>
          Array.isArray(request.body?.batch),
      );
      assert.equal(batchRequests.length, 3);
      assert.equal(
        batchRequests.every((request) => request.path === "/batch/" || request.path === "/batch"),
        true,
      );
      const deliveredIndexes = batchRequests.flatMap((request) =>
        request.body.batch
          .filter((event) => event.event === "test.flush.drain")
          .map((event) => event.properties?.index)
          .filter((index): index is number => typeof index === "number"),
      );

      const sorted = deliveredIndexes.toSorted((a, b) => a - b);
      assert.equal(sorted.length, 45);
      assert.deepEqual(
        sorted,
        Array.from({ length: 45 }, (_, index) => index),
      );
      assert.equal(
        batchRequests.every((request) =>
          request.body.batch.every((event) => event.properties?.clientType === "cli-web-client"),
        ),
        true,
      );
    }),
  );

  it.effect("drains logged errors into privacy-safe server.error events with a per-name cap", () =>
    Effect.gen(function* () {
      drainAnalyticsErrorEvents();
      const capturedRequests: Array<RecordedBatchRequest> = [];
      const serverConfigLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
        prefix: "neokod-telemetry-errors-",
      });
      const telemetryLayer = AnalyticsService.layer.pipe(
        Layer.provideMerge(serverConfigLayer),
        Layer.provideMerge(ServerSettings.ServerSettingsService.layerTest()),
      );
      const configLayer = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          NEOKOD_TELEMETRY_ENABLED: true,
          NEOKOD_POSTHOG_KEY: "phc_test_key",
          NEOKOD_POSTHOG_HOST: "",
          NEOKOD_TELEMETRY_FLUSH_BATCH_SIZE: 100,
        }),
      );
      const batchServerLayer = HttpServer.serve(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (request.method !== "POST") {
            return HttpServerResponse.empty({ status: 404 });
          }
          const payload = yield* request.json.pipe(
            Effect.map((body) => body as RecordedBatchRequest["body"]),
            Effect.orElseSucceed(() => null),
          );
          capturedRequests.push({ path: request.url, body: payload });
          return HttpServerResponse.jsonUnsafe({});
        }),
      );
      const runtimeLayer = telemetryLayer.pipe(
        Layer.provide(configLayer),
        Layer.provideMerge(NodeHttpServer.layerTest),
      );

      yield* Effect.gen(function* () {
        yield* Layer.launch(batchServerLayer).pipe(Effect.forkScoped);
        const analytics = yield* AnalyticsService.AnalyticsService;

        publishAnalyticsErrorEvent({ errorName: "GitCommandError", level: "Error" });
        publishAnalyticsErrorEvent({ errorName: "GitCommandError", level: "Error" });
        for (let index = 0; index < 40; index += 1) {
          publishAnalyticsErrorEvent({ errorName: "FloodError", level: "Error" });
        }
        yield* analytics.flush;
      }).pipe(Effect.provide(runtimeLayer));

      const deliveredEvents = capturedRequests.flatMap((request) => request.body?.batch ?? []);
      const errorEvents = deliveredEvents.filter((event) => event.event === "server.error");
      const gitErrors = errorEvents.filter(
        (event) => event.properties?.errorName === "GitCommandError",
      );
      const floodErrors = errorEvents.filter(
        (event) => event.properties?.errorName === "FloodError",
      );
      assert.equal(gitErrors.length, 2);
      // The per-name window cap holds back the flood.
      assert.equal(floodErrors.length, 25);
      assert.equal(gitErrors[0]?.properties?.level, "Error");
      // Privacy: only the class name and level travel, never a message.
      assert.equal(
        errorEvents.every(
          (event) =>
            !("message" in (event.properties ?? {})) && !("stack" in (event.properties ?? {})),
        ),
        true,
      );
    }),
  );

  it.effect("failed flushes back off exponentially instead of retrying every second", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const failingClient = HttpClient.make((request) => {
        attempts += 1;
        return transportFailure(request);
      });
      const runtimeLayer = mockClientRuntimeLayer(failingClient, "neokod-telemetry-backoff-");

      yield* Effect.gen(function* () {
        const analytics = yield* AnalyticsService.AnalyticsService;
        yield* analytics.record("test.backoff", { index: 0 });

        // First scheduled flush after one second of healthy cadence.
        yield* TestClock.adjust(Duration.millis(1_000));
        assert.equal(attempts, 1);

        // The defect retried every second. The fix waits 5 seconds after one failure.
        yield* TestClock.adjust(Duration.millis(4_999));
        assert.equal(attempts, 1);
        yield* TestClock.adjust(Duration.millis(1));
        assert.equal(attempts, 2);

        // Second failure doubles the delay to 10 seconds.
        yield* TestClock.adjust(Duration.millis(9_999));
        assert.equal(attempts, 2);
        yield* TestClock.adjust(Duration.millis(1));
        assert.equal(attempts, 3);

        // Third failure doubles it again to 20 seconds.
        yield* TestClock.adjust(Duration.millis(20_000));
        assert.equal(attempts, 4);
      }).pipe(Effect.provide(runtimeLayer));
    }),
  );

  it.effect("an unreachable endpoint sees bounded attempts and the stuck batch is dropped", () =>
    Effect.gen(function* () {
      let attempts = 0;
      let succeed = false;
      const deliveredBatches: Array<ReadonlyArray<string>> = [];
      const client = HttpClient.make((request) => {
        attempts += 1;
        if (!succeed) {
          return transportFailure(request);
        }
        deliveredBatches.push(batchEventNames(request));
        return successResponse(request);
      });
      const runtimeLayer = mockClientRuntimeLayer(client, "neokod-telemetry-bounded-");

      yield* Effect.gen(function* () {
        const analytics = yield* AnalyticsService.AnalyticsService;
        yield* analytics.record("test.stuck", { index: 0 });

        yield* TestClock.adjust(Duration.millis(1_000));
        assert.equal(attempts, 1);

        // Cheap guard that fails fast on the reverted one-second retry loop.
        yield* TestClock.adjust(Duration.millis(5_000));
        assert.equal(attempts, 2);

        // Walk the remaining backoff schedule: attempts 3 to 8 land at
        // 16s, 36s, 76s, 156s, 316s and 616s. Attempt 8 hits the per-batch
        // cap and drops the stuck batch.
        yield* TestClock.adjust(Duration.millis(610_000));
        assert.equal(attempts, 8);

        // A further simulated hour of downtime produces no additional sends
        // because the buffer is empty and the retry delay is at its ceiling.
        yield* TestClock.adjust(Duration.hours(1));
        assert.equal(attempts, 8);

        // After recovery only newer events are delivered; the dropped batch
        // stays dropped.
        succeed = true;
        yield* analytics.record("test.after-recovery", { index: 1 });
        yield* TestClock.adjust(Duration.millis(300_000));
        assert.equal(attempts, 9);
        assert.deepEqual(deliveredBatches, [["test.after-recovery"]]);
      }).pipe(Effect.provide(runtimeLayer));
    }),
  );

  it.effect("logs one warning per failure streak and reports recovery", () =>
    Effect.gen(function* () {
      const logs: Array<{ readonly level: string; readonly parts: ReadonlyArray<unknown> }> = [];
      const logger = Logger.make<unknown, void>((options) => {
        logs.push({
          level: options.logLevel,
          parts: Array.isArray(options.message) ? options.message : [options.message],
        });
      });

      let attempts = 0;
      const deliveredEvents: Array<string> = [];
      const client = HttpClient.make((request) => {
        attempts += 1;
        if (attempts <= 2) {
          return transportFailure(request);
        }
        deliveredEvents.push(...batchEventNames(request));
        return successResponse(request);
      });
      const runtimeLayer = mockClientRuntimeLayer(client, "neokod-telemetry-logs-").pipe(
        Layer.provide(Logger.layer([logger], { mergeWithExisting: false })),
      );

      yield* Effect.gen(function* () {
        const analytics = yield* AnalyticsService.AnalyticsService;
        yield* analytics.record("test.brief-outage", { index: 0 });

        // Attempt 1 fails at 1s, attempt 2 fails at 6s, attempt 3 succeeds at 16s.
        yield* TestClock.adjust(Duration.millis(1_000));
        yield* TestClock.adjust(Duration.millis(5_000));
        yield* TestClock.adjust(Duration.millis(10_000));
        assert.equal(attempts, 3);

        // A brief outage loses no events.
        assert.deepEqual(deliveredEvents, ["test.brief-outage"]);

        // The streak produced exactly one warning and no error-level entries.
        const failureLogs = logs.filter((entry) =>
          entry.parts.some(
            (part) => typeof part === "string" && part.includes("Failed to flush telemetry"),
          ),
        );
        assert.equal(failureLogs.length, 1);
        assert.equal(failureLogs[0]?.level, "Warn");
        assert.equal(logs.filter((entry) => entry.level === "Error").length, 0);

        // Recovery is reported once at info level.
        const recoveryLogs = logs.filter((entry) =>
          entry.parts.some(
            (part) => typeof part === "string" && part.includes("Telemetry delivery recovered"),
          ),
        );
        assert.equal(recoveryLogs.length, 1);
        assert.equal(recoveryLogs[0]?.level, "Info");
      }).pipe(Effect.provide(runtimeLayer));
    }),
  );

  it.effect("uses the custom PostHog host and project key from server settings", () =>
    Effect.gen(function* () {
      let requestUrl: string | undefined;
      let requestApiKey: string | undefined;
      const client = HttpClient.make((request) => {
        requestUrl = request.url;
        const body = JSON.parse(
          new TextDecoder().decode((request.body as { readonly body: Uint8Array }).body),
        ) as { readonly api_key?: string };
        requestApiKey = body.api_key;
        return successResponse(request);
      });
      const runtimeLayer = mockClientRuntimeLayer(
        client,
        "neokod-telemetry-custom-",
        ServerSettings.ServerSettingsService.layerTest({
          analytics: {
            posthogApiKey: "phc_custom",
            posthogHost: "https://posthog.example",
          },
        }),
      );

      yield* Effect.gen(function* () {
        const analytics = yield* AnalyticsService.AnalyticsService;
        yield* analytics.record("test.custom-destination");
        yield* analytics.flush;
      }).pipe(Effect.provide(runtimeLayer));

      assert.equal(requestUrl, "https://posthog.example/batch/");
      assert.equal(requestApiKey, "phc_custom");
    }),
  );

  it.effect("does not enqueue or send events when analytics is disabled", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const client = HttpClient.make((request) => {
        attempts += 1;
        return successResponse(request);
      });
      const runtimeLayer = AnalyticsService.layer.pipe(
        Layer.provideMerge(
          ServerConfig.ServerConfig.layerTest(process.cwd(), {
            prefix: "neokod-telemetry-disabled-",
          }),
        ),
        Layer.provideMerge(
          ServerSettings.ServerSettingsService.layerTest({
            analytics: { enabled: false },
          }),
        ),
        Layer.provide(mockClientConfigLayer),
        Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
      );

      yield* Effect.gen(function* () {
        const analytics = yield* AnalyticsService.AnalyticsService;
        yield* analytics.record("test.disabled");
        yield* analytics.flush;
      }).pipe(Effect.provide(runtimeLayer));

      assert.equal(attempts, 0);
    }),
  );

  it.effect("fails closed when the initial settings read fails", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const client = HttpClient.make((request) => {
        attempts += 1;
        return successResponse(request);
      });
      const settingsError = new ServerSettingsError({
        settingsPath: "/settings.json",
        operation: "read-file",
        cause: new Error("settings unavailable"),
      });
      const unreadableSettingsLayer = Layer.succeed(ServerSettings.ServerSettingsService, {
        start: Effect.void,
        ready: Effect.void,
        getSettings: Effect.fail(settingsError),
        updateSettings: () => Effect.fail(settingsError),
        streamChanges: Stream.empty,
      } satisfies ServerSettings.ServerSettingsService["Service"]);
      const runtimeLayer = AnalyticsService.layer.pipe(
        Layer.provideMerge(
          ServerConfig.ServerConfig.layerTest(process.cwd(), {
            prefix: "neokod-telemetry-settings-read-failure-",
          }),
        ),
        Layer.provideMerge(unreadableSettingsLayer),
        Layer.provide(mockClientConfigLayer),
        Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
      );

      yield* Effect.gen(function* () {
        const analytics = yield* AnalyticsService.AnalyticsService;
        yield* analytics.record("test.settings-read-failure");
        yield* analytics.flush;

        const serverConfig = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        assert.isFalse(yield* fileSystem.exists(serverConfig.anonymousIdPath));
      }).pipe(Effect.provide(runtimeLayer));

      assert.equal(attempts, 0);
    }),
  );

  it.effect("clears buffered events when a live settings update disables analytics", () =>
    Effect.gen(function* () {
      const initialSettings: ServerSettingsModel = {
        ...DEFAULT_SERVER_SETTINGS,
        analytics: { ...DEFAULT_SERVER_SETTINGS.analytics, enabled: true },
      };
      const changes = yield* PubSub.unbounded<ServerSettingsModel>();
      const reactiveSettingsLayer = Layer.succeed(ServerSettings.ServerSettingsService, {
        start: Effect.void,
        ready: Effect.void,
        getSettings: Effect.succeed(initialSettings),
        updateSettings: () => Effect.succeed(initialSettings),
        streamChanges: Stream.fromPubSub(changes),
      } satisfies ServerSettings.ServerSettingsService["Service"]);
      const deliveredEvents: Array<string> = [];
      const client = HttpClient.make((request) => {
        deliveredEvents.push(...batchEventNames(request));
        return successResponse(request);
      });
      const runtimeLayer = mockClientRuntimeLayer(
        client,
        "neokod-telemetry-live-disable-",
        reactiveSettingsLayer,
      );

      yield* Effect.gen(function* () {
        const analytics = yield* AnalyticsService.AnalyticsService;
        yield* analytics.record("test.before-disable");
        yield* PubSub.publish(changes, {
          ...initialSettings,
          analytics: { ...initialSettings.analytics, enabled: false },
        });
        yield* Effect.all(
          Array.from({ length: 5 }, () => Effect.yieldNow),
          { discard: true },
        );
        yield* analytics.flush;

        yield* PubSub.publish(changes, initialSettings);
        yield* Effect.all(
          Array.from({ length: 5 }, () => Effect.yieldNow),
          { discard: true },
        );
        yield* analytics.record("test.after-enable");
        yield* analytics.flush;
      }).pipe(Effect.provide(runtimeLayer));

      assert.deepEqual(deliveredEvents, ["test.after-enable"]);
    }),
  );
});
