import * as NodeAssert from "node:assert/strict";
import { it } from "vite-plus/test";

import {
  DEFAULT_SERVER_SETTINGS,
  EventId,
  ProviderDriverKind,
  type ServerSettings,
  type ServerSettingsPatch,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@neokod/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as References from "effect/References";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ManagedClientEvidenceForwarderLive } from "./ManagedClientEvidenceForwarder.ts";
import { setKnownGithubLogin } from "./ManagedClientIdentityRegistry.ts";

const COPILOT_DRIVER = ProviderDriverKind.make("githubCopilot");
const THREAD_ID = ThreadId.make("thread-forwarder");
const CREATED_AT = "2026-07-02T10:00:00.000Z";
const dieUnused = () => Effect.die(new Error("unused"));
const decoder = new TextDecoder();

const sessionStarted = (
  index: number,
): Extract<ProviderRuntimeEvent, { type: "session.started" }> => ({
  eventId: EventId.make(`evt-${index}`),
  provider: COPILOT_DRIVER,
  threadId: THREAD_ID,
  createdAt: CREATED_AT,
  type: "session.started",
  payload: {},
});

interface CapturedPost {
  readonly url: string;
  readonly authorization: string | undefined;
  readonly bodyKeys: ReadonlyArray<string>;
  readonly clientIdentity:
    | {
        readonly v: number;
        readonly os_username?: string;
        readonly hostname: string;
        readonly os_platform?: string;
        readonly github_login?: string;
      }
    | undefined;
  readonly events: ReadonlyArray<{
    readonly event_id: string;
    readonly schema_version: string;
    readonly client: string;
    readonly event_type: string;
  }>;
}

const flushEffects = Effect.all(
  Array.from({ length: 5 }, () => Effect.yieldNow),
  {
    discard: true,
  },
);

const makeProviderLayer = (pubsub: PubSub.PubSub<ProviderRuntimeEvent>, onSubscribe?: () => void) =>
  Layer.succeed(ProviderService, {
    startSession: dieUnused,
    sendTurn: dieUnused,
    interruptTurn: dieUnused,
    respondToRequest: dieUnused,
    respondToUserInput: dieUnused,
    stopSession: dieUnused,
    listSessions: () => Effect.succeed([]),
    getCapabilities: dieUnused,
    getInstanceInfo: dieUnused,
    rollbackConversation: dieUnused,
    get streamEvents() {
      onSubscribe?.();
      return Stream.fromPubSub(pubsub);
    },
  } satisfies ProviderService["Service"]);

const makeOrchestrationLayer = () =>
  Layer.succeed(OrchestrationEngineService, {
    readEvents: () => Stream.empty,
    dispatch: dieUnused,
    streamDomainEvents: Stream.empty,
  } satisfies OrchestrationEngineService["Service"]);

const makeEnabledSettingsLayer = (overrides = {}) =>
  ServerSettingsService.layerTest({
    providers: {
      githubCopilot: {
        managedClientEvidence: {
          enabled: true,
          governanceUrl: "https://orch.example",
          credential: "air_test",
          ...overrides,
        },
      },
    },
  });

const patchManagedClientEvidenceSettings = (
  settings: ServerSettings,
  patch: ServerSettingsPatch,
): ServerSettings => {
  const evidencePatch = patch.providers?.githubCopilot?.managedClientEvidence;
  if (!evidencePatch) return settings;
  return {
    ...settings,
    providers: {
      ...settings.providers,
      githubCopilot: {
        ...settings.providers.githubCopilot,
        managedClientEvidence: {
          ...settings.providers.githubCopilot.managedClientEvidence,
          ...evidencePatch,
        },
      },
    },
  };
};

const makeReactiveSettingsLayer = (
  initial: ServerSettings["providers"]["githubCopilot"]["managedClientEvidence"],
  changes: PubSub.PubSub<ServerSettings>,
) => {
  let current: ServerSettings = {
    ...DEFAULT_SERVER_SETTINGS,
    providers: {
      ...DEFAULT_SERVER_SETTINGS.providers,
      githubCopilot: {
        ...DEFAULT_SERVER_SETTINGS.providers.githubCopilot,
        managedClientEvidence: initial,
      },
    },
  };
  const publishCurrent = (
    next: ServerSettings["providers"]["githubCopilot"]["managedClientEvidence"],
  ) =>
    Effect.sync(() => {
      current = {
        ...current,
        providers: {
          ...current.providers,
          githubCopilot: {
            ...current.providers.githubCopilot,
            managedClientEvidence: next,
          },
        },
      };
      return current;
    }).pipe(Effect.tap((settings) => PubSub.publish(changes, settings)));
  return {
    layer: Layer.succeed(ServerSettingsService, {
      start: Effect.void,
      ready: Effect.void,
      getSettings: Effect.sync(() => current),
      updateSettings: (patch) =>
        Effect.sync(() => {
          current = patchManagedClientEvidenceSettings(current, patch);
          return current;
        }).pipe(Effect.tap((settings) => PubSub.publish(changes, settings))),
      streamChanges: Stream.fromPubSub(changes),
    } satisfies ServerSettingsService["Service"]),
    publishCurrent,
  };
};

const makePostCaptureHttpLayer = (
  posts: Queue.Enqueue<CapturedPost>,
  response: Response | ((post: CapturedPost) => Response) = Response.json({ ok: true }),
) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const rawBody = (request.body as { readonly body?: Uint8Array }).body;
      const body = JSON.parse(decoder.decode(rawBody)) as Pick<CapturedPost, "events"> & {
        readonly client_identity?: CapturedPost["clientIdentity"];
      };
      const post: CapturedPost = {
        url: request.url,
        authorization: request.headers.Authorization,
        bodyKeys: Object.keys(body),
        clientIdentity: body.client_identity,
        events: body.events,
      };
      const webResponse = typeof response === "function" ? response(post) : response;
      return Queue.offer(posts, post).pipe(
        Effect.as(HttpClientResponse.fromWeb(request, webResponse)),
      );
    }),
  );

it("forwards enabled managed-client evidence in capped batches", () =>
  Effect.gen(function* () {
    const providerEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const posts = yield* Queue.unbounded<ReadonlyArray<string>>();
    const requests = yield* Queue.unbounded<{
      readonly url: string;
      readonly authorization: string | undefined;
      readonly schemaVersion: string;
      readonly client: string;
    }>();
    const decoder = new TextDecoder();
    const httpLayer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        const rawBody = (request.body as { readonly body?: Uint8Array }).body;
        const body = JSON.parse(decoder.decode(rawBody)) as {
          readonly events: ReadonlyArray<{
            readonly event_id: string;
            readonly schema_version: string;
            readonly client: string;
          }>;
        };
        return Effect.all([
          Queue.offer(
            posts,
            body.events.map((event) => event.event_id),
          ),
          Queue.offer(requests, {
            url: request.url,
            authorization: request.headers.Authorization,
            schemaVersion: body.events[0]?.schema_version ?? "",
            client: body.events[0]?.client ?? "",
          }),
        ]).pipe(Effect.as(HttpClientResponse.fromWeb(request, Response.json({ ok: true }))));
      }),
    );

    const layer = ManagedClientEvidenceForwarderLive({ flushWithin: "10 millis" }).pipe(
      Layer.provideMerge(makeProviderLayer(providerEvents)),
      Layer.provideMerge(makeOrchestrationLayer()),
      Layer.provideMerge(
        ServerSettingsService.layerTest({
          providers: {
            githubCopilot: {
              managedClientEvidence: {
                enabled: true,
                governanceUrl: "https://orch.example",
                credential: "air_test",
              },
            },
          },
        }),
      ),
      Layer.provideMerge(httpLayer),
    );

    const scope = yield* Scope.make();
    yield* Layer.buildWithScope(layer, scope);

    for (let index = 0; index < 120; index += 1) {
      yield* PubSub.publish(providerEvents, sessionStarted(index));
    }

    const first = yield* Queue.take(posts);
    const second = yield* Queue.take(posts);
    const third = yield* Queue.take(posts);
    const request = yield* Queue.take(requests);

    yield* Scope.close(scope, Exit.void);

    NodeAssert.deepEqual([first.length, second.length, third.length], [50, 50, 20]);
    NodeAssert.deepEqual(first[0], "evt-0");
    NodeAssert.deepEqual(third.at(-1), "evt-119");
    NodeAssert.deepEqual(request, {
      url: "https://orch.example/v1/managed-client/evidence",
      authorization: "Bearer air_test",
      schemaVersion: "v0",
      client: "neokod",
    });
  }));

it("retries a failed batch with the same event ids", () =>
  Effect.gen(function* () {
    const providerEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const attempts = yield* Queue.unbounded<ReadonlyArray<string>>();
    const decoder = new TextDecoder();
    let attemptCount = 0;
    const httpLayer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        const rawBody = (request.body as { readonly body?: Uint8Array }).body;
        const body = JSON.parse(decoder.decode(rawBody)) as {
          readonly events: ReadonlyArray<{ readonly event_id: string }>;
        };
        attemptCount += 1;
        return Queue.offer(
          attempts,
          body.events.map((event) => event.event_id),
        ).pipe(
          Effect.as(
            HttpClientResponse.fromWeb(
              request,
              new Response(null, { status: attemptCount === 1 ? 500 : 200 }),
            ),
          ),
        );
      }),
    );

    const layer = ManagedClientEvidenceForwarderLive({
      backoffBase: "1 second",
      flushWithin: "1 hour",
    }).pipe(
      Layer.provideMerge(makeProviderLayer(providerEvents)),
      Layer.provideMerge(makeOrchestrationLayer()),
      Layer.provideMerge(
        ServerSettingsService.layerTest({
          providers: {
            githubCopilot: {
              managedClientEvidence: {
                enabled: true,
                governanceUrl: "https://orch.example/",
                credential: "air_test",
              },
            },
          },
        }),
      ),
      Layer.provideMerge(httpLayer),
    );

    const scope = yield* Scope.make();
    yield* Layer.buildWithScope(layer, scope);

    for (let index = 0; index < 50; index += 1) {
      yield* PubSub.publish(providerEvents, sessionStarted(index));
    }

    const first = yield* Queue.take(attempts);
    const retryFiber = yield* Queue.take(attempts).pipe(Effect.forkScoped);
    yield* TestClock.adjust("1 second");
    const second = yield* Fiber.join(retryFiber);

    yield* Scope.close(scope, Exit.void);

    NodeAssert.deepEqual(first, second);
  }).pipe(Effect.provide(TestClock.layer())));

it("drops the oldest evidence when the bounded queue overflows", () => {
  const logs: Array<{ readonly message: string; readonly droppedCount: unknown }> = [];
  const logger = Logger.make<unknown, void>(({ fiber, message }) => {
    const annotations = fiber.getRef(References.CurrentLogAnnotations);
    logs.push({
      message: String(message),
      droppedCount: annotations.droppedCount,
    });
  });

  return Effect.gen(function* () {
    const providerEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const posts = yield* Queue.unbounded<CapturedPost>();

    const layer = ManagedClientEvidenceForwarderLive({
      queueCapacity: 3,
      flushWithin: "1 hour",
    }).pipe(
      Layer.provideMerge(makeProviderLayer(providerEvents)),
      Layer.provideMerge(makeOrchestrationLayer()),
      Layer.provideMerge(makeEnabledSettingsLayer()),
      Layer.provideMerge(makePostCaptureHttpLayer(posts)),
    );

    const scope = yield* Scope.make();
    yield* Layer.buildWithScope(layer, scope);

    for (let index = 0; index < 5; index += 1) {
      yield* PubSub.publish(providerEvents, sessionStarted(index));
    }
    yield* flushEffects;
    yield* TestClock.adjust("1 hour");
    const post = yield* Queue.take(posts);

    yield* Scope.close(scope, Exit.void);

    NodeAssert.deepEqual(
      post.events.map((event) => event.event_id),
      ["evt-2", "evt-3", "evt-4"],
    );
    NodeAssert.ok(
      logs.some(
        (log) =>
          log.message.includes("managed-client evidence queue full") && log.droppedCount === 2,
      ),
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(TestClock.layer(), Logger.layer([logger], { mergeWithExisting: false })),
    ),
  );
});

it("keeps consuming provider events while the governance endpoint is permanently failing", () => {
  const logs: Array<{ readonly message: string; readonly droppedCount: unknown }> = [];
  const logger = Logger.make<unknown, void>(({ fiber, message }) => {
    const annotations = fiber.getRef(References.CurrentLogAnnotations);
    logs.push({
      message: String(message),
      droppedCount: annotations.droppedCount,
    });
  });

  return Effect.gen(function* () {
    const providerEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const posts = yield* Queue.unbounded<CapturedPost>();

    const layer = ManagedClientEvidenceForwarderLive({
      queueCapacity: 5,
      backoffBase: "1 hour",
      finalDrainTimeout: "1 millis",
    }).pipe(
      Layer.provideMerge(makeProviderLayer(providerEvents)),
      Layer.provideMerge(makeOrchestrationLayer()),
      Layer.provideMerge(makeEnabledSettingsLayer()),
      Layer.provideMerge(makePostCaptureHttpLayer(posts, new Response(null, { status: 503 }))),
    );

    const scope = yield* Scope.make();
    yield* Layer.buildWithScope(layer, scope);

    for (let index = 0; index < 50; index += 1) {
      yield* PubSub.publish(providerEvents, sessionStarted(index));
    }
    const firstPost = yield* Queue.take(posts);
    const publishExit = yield* Effect.exit(
      Effect.all(
        Array.from({ length: 25 }, (_, index) =>
          PubSub.publish(providerEvents, sessionStarted(50 + index)),
        ),
        { discard: true },
      ).pipe(Effect.timeout("1 second")),
    );
    yield* flushEffects;
    const secondPost = yield* Queue.poll(posts);

    yield* Scope.close(scope, Exit.void);

    NodeAssert.equal(publishExit._tag, "Success");
    NodeAssert.equal(firstPost.events.length, 50);
    NodeAssert.ok(Option.isNone(secondPost));
    NodeAssert.ok(
      logs.some(
        (log) =>
          log.message.includes("managed-client evidence queue full") &&
          typeof log.droppedCount === "number" &&
          log.droppedCount > 0,
      ),
    );
  }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
});

it("reacts to managed-client evidence settings changes at runtime", () =>
  Effect.gen(function* () {
    const providerEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const settingsChanges = yield* PubSub.unbounded<ServerSettings>();
    const posts = yield* Queue.unbounded<CapturedPost>();
    let subscribeCount = 0;
    const settings = makeReactiveSettingsLayer(
      {
        enabled: false,
        gatewayEnabled: false,
        backend: "ai-orch",
        governanceUrl: "",
        credential: "",
        posthogHost: "",
        posthogApiKey: "",
        otlpEndpoint: "",
        otlpHeaders: "",
        includeMachineIdentity: true,
      },
      settingsChanges,
    );

    const layer = ManagedClientEvidenceForwarderLive({ flushWithin: "10 millis" }).pipe(
      Layer.provideMerge(
        makeProviderLayer(providerEvents, () => {
          subscribeCount++;
        }),
      ),
      Layer.provideMerge(makeOrchestrationLayer()),
      Layer.provideMerge(settings.layer),
      Layer.provideMerge(makePostCaptureHttpLayer(posts)),
    );

    const scope = yield* Scope.make();
    yield* Layer.buildWithScope(layer, scope);
    yield* flushEffects;

    NodeAssert.equal(subscribeCount, 0);
    yield* PubSub.publish(providerEvents, sessionStarted(1));
    yield* TestClock.adjust("10 millis");
    NodeAssert.ok(Option.isNone(yield* Queue.poll(posts)));

    yield* settings.publishCurrent({
      enabled: true,
      gatewayEnabled: false,
      backend: "ai-orch",
      governanceUrl: "https://orch.example",
      credential: "air_test",
      posthogHost: "",
      posthogApiKey: "",
      otlpEndpoint: "",
      otlpHeaders: "",
      includeMachineIdentity: true,
    });
    yield* flushEffects;
    NodeAssert.equal(subscribeCount, 1);
    yield* PubSub.publish(providerEvents, sessionStarted(2));
    yield* TestClock.adjust("10 millis");
    const enabledPost = yield* Queue.take(posts);

    yield* settings.publishCurrent({
      enabled: false,
      gatewayEnabled: false,
      backend: "ai-orch",
      governanceUrl: "https://orch.example",
      credential: "air_test",
      posthogHost: "",
      posthogApiKey: "",
      otlpEndpoint: "",
      otlpHeaders: "",
      includeMachineIdentity: true,
    });
    yield* flushEffects;
    yield* PubSub.publish(providerEvents, sessionStarted(3));
    yield* TestClock.adjust("10 millis");
    const disabledPost = yield* Queue.poll(posts);

    yield* Scope.close(scope, Exit.void);

    NodeAssert.deepEqual(
      enabledPost.events.map((event) => event.event_id),
      ["evt-2"],
    );
    NodeAssert.ok(Option.isNone(disabledPost));
  }).pipe(Effect.provide(TestClock.layer())));

it("posts managed-client evidence using the v0 batch envelope", () =>
  Effect.gen(function* () {
    const providerEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const posts = yield* Queue.unbounded<CapturedPost>();

    const layer = ManagedClientEvidenceForwarderLive({ flushWithin: "10 millis" }).pipe(
      Layer.provideMerge(makeProviderLayer(providerEvents)),
      Layer.provideMerge(makeOrchestrationLayer()),
      Layer.provideMerge(makeEnabledSettingsLayer()),
      Layer.provideMerge(makePostCaptureHttpLayer(posts)),
    );

    const scope = yield* Scope.make();
    yield* Layer.buildWithScope(layer, scope);
    yield* PubSub.publish(providerEvents, sessionStarted(1));
    yield* TestClock.adjust("10 millis");
    const post = yield* Queue.take(posts);

    yield* Scope.close(scope, Exit.void);

    NodeAssert.deepEqual([...post.bodyKeys].sort(), ["client_identity", "events"]);
    NodeAssert.equal(post.url, "https://orch.example/v1/managed-client/evidence");
    NodeAssert.equal(post.authorization, "Bearer air_test");
    NodeAssert.equal(post.events.length, 1);
    NodeAssert.deepEqual(
      {
        event_id: post.events[0]?.event_id,
        schema_version: post.events[0]?.schema_version,
        client: post.events[0]?.client,
        event_type: post.events[0]?.event_type,
      },
      {
        event_id: "evt-1",
        schema_version: "v0",
        client: "neokod",
        event_type: "session_start",
      },
    );
  }).pipe(Effect.provide(TestClock.layer())));

it("attaches client_identity at the batch level, present even without a known github login", () =>
  Effect.gen(function* () {
    setKnownGithubLogin(undefined);
    const providerEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const posts = yield* Queue.unbounded<CapturedPost>();

    const layer = ManagedClientEvidenceForwarderLive({ flushWithin: "10 millis" }).pipe(
      Layer.provideMerge(makeProviderLayer(providerEvents)),
      Layer.provideMerge(makeOrchestrationLayer()),
      Layer.provideMerge(makeEnabledSettingsLayer()),
      Layer.provideMerge(makePostCaptureHttpLayer(posts)),
    );

    const scope = yield* Scope.make();
    yield* Layer.buildWithScope(layer, scope);
    yield* PubSub.publish(providerEvents, sessionStarted(1));
    yield* TestClock.adjust("10 millis");
    const post = yield* Queue.take(posts);

    yield* Scope.close(scope, Exit.void);

    NodeAssert.ok(post.clientIdentity, "expected client_identity on the batch");
    NodeAssert.equal(post.clientIdentity?.v, 1);
    NodeAssert.equal(typeof post.clientIdentity?.hostname, "string");
    NodeAssert.ok(post.clientIdentity && post.clientIdentity.hostname.length > 0);
    NodeAssert.equal(post.clientIdentity?.github_login, undefined);
  }).pipe(Effect.provide(TestClock.layer())));

it("includes github_login in client_identity once the Copilot auth probe has resolved one", () =>
  Effect.gen(function* () {
    setKnownGithubLogin("octocat");
    const providerEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const posts = yield* Queue.unbounded<CapturedPost>();

    const layer = ManagedClientEvidenceForwarderLive({ flushWithin: "10 millis" }).pipe(
      Layer.provideMerge(makeProviderLayer(providerEvents)),
      Layer.provideMerge(makeOrchestrationLayer()),
      Layer.provideMerge(makeEnabledSettingsLayer()),
      Layer.provideMerge(makePostCaptureHttpLayer(posts)),
    );

    const scope = yield* Scope.make();
    yield* Layer.buildWithScope(layer, scope);
    yield* PubSub.publish(providerEvents, sessionStarted(1));
    yield* TestClock.adjust("10 millis");
    const post = yield* Queue.take(posts);

    yield* Scope.close(scope, Exit.void);
    setKnownGithubLogin(undefined);

    NodeAssert.equal(post.clientIdentity?.github_login, "octocat");
  }).pipe(Effect.provide(TestClock.layer())));

it("drops a batch permanently on a 400 response and keeps consuming later events", () => {
  const logs: Array<{ readonly message: string; readonly status: unknown }> = [];
  const logger = Logger.make<unknown, void>(({ fiber, message }) => {
    const annotations = fiber.getRef(References.CurrentLogAnnotations);
    logs.push({ message: String(message), status: annotations.status });
  });

  return Effect.gen(function* () {
    const providerEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const posts = yield* Queue.unbounded<CapturedPost>();
    let attemptCount = 0;

    const layer = ManagedClientEvidenceForwarderLive({ flushWithin: "10 millis" }).pipe(
      Layer.provideMerge(makeProviderLayer(providerEvents)),
      Layer.provideMerge(makeOrchestrationLayer()),
      Layer.provideMerge(makeEnabledSettingsLayer()),
      Layer.provideMerge(
        makePostCaptureHttpLayer(posts, () => {
          attemptCount += 1;
          return new Response(null, { status: 400 });
        }),
      ),
    );

    const scope = yield* Scope.make();
    yield* Layer.buildWithScope(layer, scope);

    yield* PubSub.publish(providerEvents, sessionStarted(1));
    yield* TestClock.adjust("10 millis");
    yield* flushEffects;
    const firstPost = yield* Queue.take(posts);

    yield* PubSub.publish(providerEvents, sessionStarted(2));
    yield* TestClock.adjust("10 millis");
    const secondPost = yield* Queue.take(posts);

    yield* Scope.close(scope, Exit.void);

    NodeAssert.deepEqual(
      firstPost.events.map((event) => event.event_id),
      ["evt-1"],
    );
    NodeAssert.deepEqual(
      secondPost.events.map((event) => event.event_id),
      ["evt-2"],
    );
    NodeAssert.equal(attemptCount, 2, "a 400 must not be retried");
    NodeAssert.ok(
      logs.some((log) => log.message.includes("permanent client error") && log.status === 400),
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(TestClock.layer(), Logger.layer([logger], { mergeWithExisting: false })),
    ),
  );
});

it("retries on 429 the same as a 5xx response", () =>
  Effect.gen(function* () {
    const providerEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const attempts = yield* Queue.unbounded<ReadonlyArray<string>>();
    let attemptCount = 0;
    const httpLayer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        const rawBody = (request.body as { readonly body?: Uint8Array }).body;
        const body = JSON.parse(decoder.decode(rawBody)) as {
          readonly events: ReadonlyArray<{ readonly event_id: string }>;
        };
        attemptCount += 1;
        return Queue.offer(
          attempts,
          body.events.map((event) => event.event_id),
        ).pipe(
          Effect.as(
            HttpClientResponse.fromWeb(
              request,
              new Response(null, { status: attemptCount === 1 ? 429 : 200 }),
            ),
          ),
        );
      }),
    );

    const layer = ManagedClientEvidenceForwarderLive({
      backoffBase: "1 second",
      flushWithin: "1 hour",
    }).pipe(
      Layer.provideMerge(makeProviderLayer(providerEvents)),
      Layer.provideMerge(makeOrchestrationLayer()),
      Layer.provideMerge(
        ServerSettingsService.layerTest({
          providers: {
            githubCopilot: {
              managedClientEvidence: {
                enabled: true,
                governanceUrl: "https://orch.example/",
                credential: "air_test",
              },
            },
          },
        }),
      ),
      Layer.provideMerge(httpLayer),
    );

    const scope = yield* Scope.make();
    yield* Layer.buildWithScope(layer, scope);

    for (let index = 0; index < 50; index += 1) {
      yield* PubSub.publish(providerEvents, sessionStarted(index));
    }

    const first = yield* Queue.take(attempts);
    const retryFiber = yield* Queue.take(attempts).pipe(Effect.forkScoped);
    yield* TestClock.adjust("1 second");
    const second = yield* Fiber.join(retryFiber);

    yield* Scope.close(scope, Exit.void);

    NodeAssert.deepEqual(first, second);
  }).pipe(Effect.provide(TestClock.layer())));
