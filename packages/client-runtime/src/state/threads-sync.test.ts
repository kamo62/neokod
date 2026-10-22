import {
  EnvironmentId,
  EventId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadStreamItem,
} from "@neokod/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import * as RpcSession from "../rpc/session.ts";
import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  makeEnvironmentThreadState,
  ThreadSnapshotLoader,
  type EnvironmentThreadState,
} from "./threads.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
const THREAD_ID = ThreadId.make("thread-1");
const CACHED_SNAPSHOT_SEQUENCE = 7;
const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: TARGET.wsBaseUrl,
  wslBearerAuthorization: null,
  target: TARGET,
};
const BASE_THREAD: OrchestrationThread = {
  id: THREAD_ID,
  projectId: ProjectId.make("project-1"),
  title: "Cached thread",
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "main",
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
  archivedAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};

type TestThreadInput = OrchestrationThreadStreamItem | Error;

function testSession(client: WsRpcProtocolClient): RpcSession.RpcSession {
  return {
    client,
    initialConfig: Effect.never,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

function awaitThreadState(
  observed: Queue.Queue<EnvironmentThreadState>,
  predicate: (state: EnvironmentThreadState) => boolean,
) {
  return Queue.take(observed).pipe(
    Effect.repeat({
      until: predicate,
    }),
  );
}

const makeHarness = Effect.fn("TestEnvironmentThreads.makeHarness")(function* (options?: {
  readonly cached?: OrchestrationThread;
  readonly httpSnapshot?: Option.Option<OrchestrationThreadDetailSnapshot>;
}) {
  const inputs = yield* Queue.unbounded<TestThreadInput>();
  const observed = yield* Queue.unbounded<EnvironmentThreadState>();
  const latest = yield* Ref.make<EnvironmentThreadState>(EMPTY_ENVIRONMENT_THREAD_STATE);
  const retryCount = yield* Ref.make(0);
  const subscriptionCount = yield* Ref.make(0);
  const loaderCalls = yield* Ref.make(0);
  const lastSubscribeAfterSequence = yield* Ref.make<number | undefined>(undefined);
  const savedThreads = yield* Ref.make<ReadonlyArray<OrchestrationThreadDetailSnapshot>>([]);
  const removedThreads = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
  const supervisorState = yield* SubscriptionRef.make<SupervisorConnectionState>(
    AVAILABLE_CONNECTION_STATE,
  );
  const streamFrom = (queue: Queue.Queue<TestThreadInput>) =>
    Stream.fromQueue(queue).pipe(
      Stream.mapEffect((input) =>
        input instanceof Error ? Effect.fail(input) : Effect.succeed(input),
      ),
    );
  const client = {
    [ORCHESTRATION_WS_METHODS.subscribeThread]: (input: { readonly afterSequence?: number }) =>
      Stream.unwrap(
        Ref.updateAndGet(subscriptionCount, (count) => count + 1).pipe(
          Effect.andThen(Ref.set(lastSubscribeAfterSequence, input.afterSequence)),
          Effect.as(streamFrom(inputs)),
        ),
      ),
  } as unknown as WsRpcProtocolClient;
  const supervisorSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
    Option.some(testSession(client)),
  );
  const prepared = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
    Option.some(PREPARED),
  );
  const snapshotLoader = ThreadSnapshotLoader.of({
    load: (_prepared, threadId) =>
      Ref.update(loaderCalls, (count) => count + 1).pipe(
        Effect.as(
          threadId === THREAD_ID
            ? (options?.httpSnapshot ?? Option.none<OrchestrationThreadDetailSnapshot>())
            : Option.none<OrchestrationThreadDetailSnapshot>(),
        ),
      ),
  });
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: supervisorState,
    session: supervisorSession,
    prepared,
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Ref.update(retryCount, (count) => count + 1),
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const cache = Persistence.EnvironmentCacheStore.of({
    loadShell: () => Effect.succeed(Option.none()),
    saveShell: () => Effect.void,
    loadThread: (_environmentId, threadId) =>
      Effect.succeed(
        threadId === THREAD_ID && options?.cached !== undefined
          ? Option.some({
              snapshotSequence: CACHED_SNAPSHOT_SEQUENCE,
              thread: options.cached,
            })
          : Option.none(),
      ),
    saveThread: (_environmentId, thread) =>
      Ref.update(savedThreads, (current) => [...current, thread]),
    removeThread: (_environmentId, threadId) =>
      Ref.update(removedThreads, (current) => [...current, threadId]),
    clear: () => Effect.void,
  });
  const threadState = yield* makeEnvironmentThreadState(THREAD_ID).pipe(
    Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    Effect.provideService(Persistence.EnvironmentCacheStore, cache),
    Effect.provideService(ThreadSnapshotLoader, snapshotLoader),
  );
  yield* SubscriptionRef.changes(threadState).pipe(
    Stream.runForEach((state) =>
      Ref.set(latest, state).pipe(Effect.andThen(Queue.offer(observed, state))),
    ),
    Effect.forkScoped,
  );

  return {
    inputs,
    observed,
    latest,
    retryCount,
    subscriptionCount,
    loaderCalls,
    lastSubscribeAfterSequence,
    supervisorState,
    supervisorSession,
    savedThreads,
    removedThreads,
    replaceSession: SubscriptionRef.set(supervisorSession, Option.some(testSession(client))),
  };
});

const snapshot = (thread: OrchestrationThread): OrchestrationThreadStreamItem => ({
  kind: "snapshot",
  snapshot: {
    snapshotSequence: 1,
    thread,
  },
});

const titleUpdated = (title: string, sequence = 2): OrchestrationThreadStreamItem => ({
  kind: "event",
  event: {
    eventId: EventId.make("event-title"),
    sequence,
    occurredAt: "2026-04-01T01:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    type: "thread.meta-updated",
    payload: {
      threadId: THREAD_ID,
      title,
      updatedAt: "2026-04-01T01:00:00.000Z",
    },
  },
});

const runningTurnSession = (
  turnId: string,
  updatedAt: string,
  settledTurnCompletions?: Record<TurnId, string | null>,
): OrchestrationThreadStreamItem => ({
  kind: "event",
  event: {
    eventId: EventId.make(`event-session-${turnId}`),
    sequence: 2,
    occurredAt: updatedAt,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    type: "thread.session-set",
    payload: {
      threadId: THREAD_ID,
      session: {
        threadId: THREAD_ID,
        status: "running",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: TurnId.make(turnId),
        lastError: null,
        updatedAt,
      },
      ...(settledTurnCompletions === undefined ? {} : { settledTurnCompletions }),
    },
  },
});

const deleted = (): OrchestrationThreadStreamItem => ({
  kind: "event",
  event: {
    eventId: EventId.make("event-deleted"),
    sequence: 3,
    occurredAt: "2026-04-01T02:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    type: "thread.deleted",
    payload: {
      threadId: THREAD_ID,
      deletedAt: "2026-04-01T02:00:00.000Z",
    },
  },
});

describe("EnvironmentThreads", () => {
  it.effect("publishes cached data immediately from a warm cache", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });
      const state = yield* awaitThreadState(harness.observed, (value) => Option.isSome(value.data));

      expect(Option.getOrThrow(state.data)).toEqual(BASE_THREAD);
      expect(Option.isNone(state.error)).toBe(true);
    }),
  );

  it.effect("does not seed a provisional interrupt boundary from the warm cache", () =>
    Effect.gen(function* () {
      const cachedThread: OrchestrationThread = {
        ...BASE_THREAD,
        latestTurn: {
          turnId: TurnId.make("turn-pending"),
          state: "interrupted",
          requestedAt: "2026-04-01T00:00:00.000Z",
          startedAt: "2026-04-01T00:00:00.000Z",
          completedAt: "2026-04-01T00:00:10.000Z",
          assistantMessageId: null,
        },
        session: {
          threadId: THREAD_ID,
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: TurnId.make("turn-pending"),
          lastError: null,
          updatedAt: "2026-04-01T00:00:00.000Z",
        },
      };
      const harness = yield* makeHarness({ cached: cachedThread });
      const state = yield* awaitThreadState(harness.observed, (value) => Option.isSome(value.data));

      // The session still runs the turn, so the cached terminal state is only
      // an interrupt request boundary, not settlement evidence.
      expect(Option.getOrThrow(state.data).settledTurnCompletions).toBeUndefined();
    }),
  );

  it.effect("resumes a warm cache via afterSequence without an HTTP fetch", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });

      // The warm cache reaches live from the cached data, and a live event
      // applies on top of it.
      yield* Queue.offer(harness.inputs, titleUpdated("Live title", CACHED_SNAPSHOT_SEQUENCE + 1));
      yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.title === "Live title",
      );

      // The subscription resumed from the cached sequence and never fetched the
      // full snapshot over HTTP.
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(CACHED_SNAPSHOT_SEQUENCE);
      expect(yield* Ref.get(harness.loaderCalls)).toBe(0);
    }),
  );

  it.effect("reduces live events and persists the latest thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });
      yield* Queue.offer(harness.inputs, snapshot(BASE_THREAD));
      yield* Queue.offer(harness.inputs, titleUpdated("Live title"));

      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.title === "Live title",
      );
      yield* TestClock.adjust("500 millis");
      yield* Effect.yieldNow;

      expect(Option.getOrThrow(state.data).title).toBe("Live title");
      expect((yield* Ref.get(harness.savedThreads)).at(-1)?.thread.title).toBe("Live title");
      expect((yield* Ref.get(harness.savedThreads)).at(-1)?.snapshotSequence).toBe(2);
    }),
  );

  it.effect("seeds the thread from the HTTP snapshot and resumes live events", () =>
    Effect.gen(function* () {
      const httpThread: OrchestrationThread = { ...BASE_THREAD, title: "HTTP title" };
      const harness = yield* makeHarness({
        httpSnapshot: Option.some({ snapshotSequence: 1, thread: httpThread }),
      });
      // No socket snapshot is pushed; only a live event arrives over the socket.
      // It can only be applied if the HTTP snapshot already seeded the thread.
      yield* Queue.offer(harness.inputs, titleUpdated("Live title", 2));

      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.title === "Live title",
      );

      expect(Option.getOrThrow(state.data).title).toBe("Live title");
      // Cold cache: the full snapshot was loaded over HTTP and the socket
      // resumed from that snapshot's sequence.
      expect(yield* Ref.get(harness.loaderCalls)).toBeGreaterThanOrEqual(1);
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(1);
    }),
  );

  it.effect("ignores replayed thread events at or below the snapshot sequence", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });
      yield* Queue.offer(harness.inputs, snapshot(BASE_THREAD));
      yield* Queue.offer(harness.inputs, titleUpdated("Replayed title", 1));
      yield* Queue.offer(harness.inputs, titleUpdated("Live title", 2));

      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.title === "Live title",
      );

      expect(Option.getOrThrow(state.data).title).toBe("Live title");
    }),
  );

  it.effect("removes cached data when the thread is deleted", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });
      yield* Queue.offer(harness.inputs, snapshot(BASE_THREAD));
      yield* Queue.offer(harness.inputs, deleted());

      const state = yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "deleted",
      );

      expect(Option.isNone(state.data)).toBe(true);
      expect(yield* Ref.get(harness.removedThreads)).toEqual([THREAD_ID]);
    }),
  );

  it.effect("preserves data after a domain failure and resumes on a replacement session", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });
      yield* Queue.offer(harness.inputs, snapshot(BASE_THREAD));
      yield* Queue.offer(harness.inputs, new Error("stream failed"));

      const state = yield* awaitThreadState(harness.observed, (value) =>
        Option.isSome(value.error),
      );

      expect(Option.getOrThrow(state.data)).toEqual(BASE_THREAD);
      expect(Option.getOrThrow(state.error)).toBe("stream failed");
      expect(yield* Ref.get(harness.retryCount)).toBe(0);

      yield* harness.replaceSession;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 2) {
          break;
        }
        yield* Effect.yieldNow;
      }
      yield* Queue.offer(
        harness.inputs,
        snapshot({
          ...BASE_THREAD,
          title: "Recovered thread",
        }),
      );
      const recovered = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.title === "Recovered thread",
      );

      expect(Option.isNone(recovered.error)).toBe(true);
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
    }),
  );

  it.effect("recovers from a transient domain failure without replacing the session", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Queue.offer(harness.inputs, new Error("thread not found yet"));

      const failed = yield* awaitThreadState(harness.observed, (value) =>
        Option.isSome(value.error),
      );
      expect(Option.getOrThrow(failed.error)).toBe("thread not found yet");
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(1);

      yield* TestClock.adjust("250 millis");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 2) {
          break;
        }
        yield* Effect.yieldNow;
      }
      yield* Queue.offer(
        harness.inputs,
        snapshot({
          ...BASE_THREAD,
          title: "Materialized thread",
        }),
      );

      const recovered = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.title === "Materialized thread",
      );

      expect(Option.isNone(recovered.error)).toBe(true);
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
      expect(yield* Ref.get(harness.retryCount)).toBe(0);
    }),
  );

  it.effect("seeds and preserves per-turn settlement evidence across snapshots", () =>
    Effect.gen(function* () {
      const turnA = TurnId.make("turn-a");
      const turnB = TurnId.make("turn-b");
      const completedAt = "2026-04-01T00:01:00.000Z";
      const recoveredThread: OrchestrationThread = {
        ...BASE_THREAD,
        latestTurn: {
          turnId: turnA,
          state: "interrupted",
          requestedAt: "2026-04-01T00:00:00.000Z",
          startedAt: "2026-04-01T00:00:00.000Z",
          completedAt,
          assistantMessageId: null,
        },
        settledTurnCompletions: { [turnA]: completedAt },
      };
      const harness = yield* makeHarness({
        httpSnapshot: Option.some({ snapshotSequence: 1, thread: recoveredThread }),
      });

      // The snapshot carries the server's per-turn settlement record.
      const loaded = yield* awaitThreadState(harness.observed, (value) =>
        Option.isSome(value.data),
      );
      expect(Option.getOrThrow(loaded.data).settledTurnCompletions).toEqual({
        [turnA]: completedAt,
      });

      // A later turn supersedes it without losing the settlement.
      yield* Queue.offer(
        harness.inputs,
        runningTurnSession("turn-b", "2026-04-01T00:03:00.000Z", { [turnA]: completedAt }),
      );
      const next = yield* awaitThreadState(
        harness.observed,
        (value) => Option.isSome(value.data) && value.data.value.latestTurn?.turnId === turnB,
      );
      expect(Option.getOrThrow(next.data).settledTurnCompletions).toEqual({
        [turnA]: completedAt,
      });

      // A fresh snapshot taken after the next turn started still reports the
      // settled turn, so replacement keeps the server's record.
      yield* Queue.offer(
        harness.inputs,
        snapshot({
          ...recoveredThread,
          latestTurn: {
            turnId: turnB,
            state: "running",
            requestedAt: "2026-04-01T00:03:00.000Z",
            startedAt: "2026-04-01T00:03:00.000Z",
            completedAt: null,
            assistantMessageId: null,
          },
        }),
      );
      const refreshed = yield* awaitThreadState(
        harness.observed,
        (value) =>
          Option.isSome(value.data) && value.data.value.updatedAt === BASE_THREAD.updatedAt,
      );
      expect(Option.getOrThrow(refreshed.data).settledTurnCompletions).toEqual({
        [turnA]: completedAt,
      });
    }),
  );

  it.effect(
    "records explicit unknown when a reconnect snapshot supersedes a provisional turn",
    () =>
      Effect.gen(function* () {
        const turnA = TurnId.make("turn-provisional");
        const turnB = TurnId.make("turn-next");
        const provisional: OrchestrationThread = {
          ...BASE_THREAD,
          latestTurn: {
            turnId: turnA,
            state: "interrupted",
            requestedAt: "2026-04-01T00:00:00.000Z",
            startedAt: "2026-04-01T00:00:00.000Z",
            completedAt: "2026-04-01T00:00:10.000Z",
            assistantMessageId: null,
          },
          session: {
            threadId: THREAD_ID,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: turnA,
            lastError: null,
            updatedAt: "2026-04-01T00:00:00.000Z",
          },
        };
        const harness = yield* makeHarness({ cached: provisional });
        yield* awaitThreadState(harness.observed, (value) => Option.isSome(value.data));

        // Reconnect: the snapshot names only the new turn and cannot supply the
        // superseded turn's completion.
        yield* Queue.offer(
          harness.inputs,
          snapshot({
            ...BASE_THREAD,
            latestTurn: {
              turnId: turnB,
              state: "running",
              requestedAt: "2026-04-01T00:03:00.000Z",
              startedAt: "2026-04-01T00:03:00.000Z",
              completedAt: null,
              assistantMessageId: null,
            },
            settledTurnCompletions: {},
          }),
        );
        const refreshed = yield* awaitThreadState(
          harness.observed,
          (value) => Option.isSome(value.data) && value.data.value.latestTurn?.turnId === turnB,
        );
        expect(Option.getOrThrow(refreshed.data).settledTurnCompletions).toEqual({
          [turnA]: null,
        });
      }),
  );

  it.effect("does not overwrite a live snapshot when the supervisor becomes ready", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });
      yield* SubscriptionRef.set(harness.supervisorState, {
        desired: true,
        network: "online",
        phase: "connecting",
        stage: "synchronizing",
        attempt: 1,
        generation: 0,
        lastFailure: null,
        retryAt: null,
      });
      yield* Queue.offer(harness.inputs, snapshot(BASE_THREAD));
      yield* awaitThreadState(harness.observed, (value) => value.status === "live");

      yield* SubscriptionRef.set(harness.supervisorState, {
        desired: true,
        network: "online",
        phase: "connected",
        stage: null,
        attempt: 1,
        generation: 1,
        lastFailure: null,
        retryAt: null,
      });
      for (let index = 0; index < 10; index += 1) {
        yield* Effect.yieldNow;
      }

      expect((yield* Ref.get(harness.latest)).status).toBe("live");
    }),
  );
});
