import type { CopilotManagedClientEvidenceSettings } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import type * as Fiber from "effect/Fiber";
import * as FiberRuntime from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  evidenceFromOrchestrationEvent,
  evidenceFromProviderRuntimeEvent,
  makeManagedClientEvidenceBatch,
  type ManagedClientEvidenceEvent,
} from "./ManagedClientEvidence.ts";

const DEFAULT_QUEUE_CAPACITY = 1_000;
const DEFAULT_FLUSH_WITHIN = "2 seconds";
const DEFAULT_BACKOFF_BASE = "1 second";
const DEFAULT_BACKOFF_MAX = "60 seconds";
const DEFAULT_FINAL_DRAIN_TIMEOUT = "2 seconds";

export interface ManagedClientEvidenceForwarderOptions {
  readonly queueCapacity?: number | undefined;
  readonly flushWithin?: Duration.Input | undefined;
  readonly backoffBase?: Duration.Input | undefined;
  readonly backoffMax?: Duration.Input | undefined;
  readonly finalDrainTimeout?: Duration.Input | undefined;
}

interface NormalizedManagedClientEvidenceForwarderOptions {
  readonly queueCapacity: number;
  readonly flushWithin: Duration.Input;
  readonly backoffBase: Duration.Input;
  readonly backoffMax: Duration.Input;
  readonly finalDrainTimeout: Duration.Input;
}

function isEnabled(settings: CopilotManagedClientEvidenceSettings): boolean {
  return settings.enabled && settings.governanceUrl.length > 0 && settings.credential.length > 0;
}

function nextBackoffMs(currentMs: number, maxMs: number): number {
  return Math.min(currentMs * 2, maxMs);
}

const postWithBackoff = (
  settings: CopilotManagedClientEvidenceSettings,
  events: ReadonlyArray<ManagedClientEvidenceEvent>,
  options: NormalizedManagedClientEvidenceForwarderOptions,
) =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const body = makeManagedClientEvidenceBatch(events);
    const baseMs = Duration.toMillis(options.backoffBase);
    const maxMs = Duration.toMillis(options.backoffMax);
    let delayMs = baseMs;

    while (true) {
      const exit = yield* Effect.exit(
        HttpClientRequest.post(
          `${settings.governanceUrl.replace(/\/+$/, "")}/v1/managed-client/evidence`,
        ).pipe(
          HttpClientRequest.bearerToken(settings.credential),
          HttpClientRequest.setHeader("content-type", "application/json"),
          HttpClientRequest.bodyJson(body),
          Effect.flatMap(httpClient.execute),
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.asVoid,
        ),
      );
      if (exit._tag === "Success") {
        return;
      }
      yield* Effect.logWarning("managed-client evidence POST failed; retrying", {
        eventCount: body.events.length,
        nextRetryMs: delayMs,
      });
      yield* Effect.sleep(Duration.millis(delayMs));
      delayMs = nextBackoffMs(delayMs, maxMs);
    }
  });

const runForwarder = (
  settings: CopilotManagedClientEvidenceSettings,
  options: NormalizedManagedClientEvidenceForwarderOptions,
) =>
  Effect.gen(function* () {
    const provider = yield* ProviderService;
    const orchestration = yield* OrchestrationEngineService;
    const queue = yield* Queue.sliding<ManagedClientEvidenceEvent>(options.queueCapacity);
    const dropped = yield* Ref.make(0);

    const enqueue = (event: ManagedClientEvidenceEvent | undefined) =>
      event
        ? Effect.gen(function* () {
            const size = yield* Queue.size(queue);
            if (size >= options.queueCapacity) {
              const droppedCount = yield* Ref.updateAndGet(dropped, (count) => count + 1);
              yield* Effect.logWarning("managed-client evidence queue full; dropped oldest event", {
                droppedCount,
              });
            }
            yield* Queue.offer(queue, event);
          })
        : Effect.void;

    yield* provider.streamEvents.pipe(
      Stream.runForEach((event) => enqueue(evidenceFromProviderRuntimeEvent(event))),
      Effect.forkScoped,
    );
    yield* orchestration.streamDomainEvents.pipe(
      Stream.runForEach((event) => enqueue(evidenceFromOrchestrationEvent(event))),
      Effect.forkScoped,
    );
    yield* Stream.fromQueue(queue).pipe(
      Stream.groupedWithin(50, options.flushWithin),
      Stream.runForEach((batch) => postWithBackoff(settings, batch, options)),
      Effect.forkScoped,
    );

    yield* Effect.addFinalizer(() =>
      Queue.clear(queue).pipe(
        Effect.flatMap((events) =>
          events.length === 0
            ? Effect.void
            : postWithBackoff(settings, events.slice(0, 50), options).pipe(
                Effect.timeout(options.finalDrainTimeout),
                Effect.catch(() => Effect.void),
              ),
        ),
      ),
    );

    return yield* Effect.never;
  });

const normalizeOptions = (
  options: ManagedClientEvidenceForwarderOptions = {},
): NormalizedManagedClientEvidenceForwarderOptions => ({
  queueCapacity: options.queueCapacity ?? DEFAULT_QUEUE_CAPACITY,
  flushWithin: options.flushWithin ?? DEFAULT_FLUSH_WITHIN,
  backoffBase: options.backoffBase ?? DEFAULT_BACKOFF_BASE,
  backoffMax: options.backoffMax ?? DEFAULT_BACKOFF_MAX,
  finalDrainTimeout: options.finalDrainTimeout ?? DEFAULT_FINAL_DRAIN_TIMEOUT,
});

export const ManagedClientEvidenceForwarderLive = (
  inputOptions: ManagedClientEvidenceForwarderOptions = {},
) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const options = normalizeOptions(inputOptions);
      const settings = yield* ServerSettingsService;
      const active = yield* Ref.make<Fiber.Fiber<never, never> | null>(null);
      const last = yield* Ref.make<CopilotManagedClientEvidenceSettings | null>(null);

      const applySettings = (next: CopilotManagedClientEvidenceSettings) =>
        Effect.gen(function* () {
          const previous = yield* Ref.get(last);
          if (previous && Equal.equals(previous, next)) {
            return;
          }
          yield* Ref.set(last, next);
          const current = yield* Ref.get(active);
          if (current) {
            yield* FiberRuntime.interrupt(current);
            yield* Ref.set(active, null);
          }
          if (!isEnabled(next)) {
            return;
          }
          const fiber = yield* Effect.forkScoped(runForwarder(next, options));
          yield* Ref.set(active, fiber);
        });

      const readManagedClientEvidenceSettings = settings.getSettings.pipe(
        Effect.map(
          (serverSettings) => serverSettings.providers.githubCopilot.managedClientEvidence,
        ),
      );

      yield* readManagedClientEvidenceSettings.pipe(Effect.flatMap(applySettings));
      yield* settings.streamChanges.pipe(
        Stream.map(
          (serverSettings) => serverSettings.providers.githubCopilot.managedClientEvidence,
        ),
        Stream.runForEach(applySettings),
        Effect.forkScoped,
      );
    }),
  );
