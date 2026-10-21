/**
 * CopilotRuntimeSupervisor — liveness probe and serialized restart for the
 * one `CopilotClient` process shared by every Copilot thread of an instance.
 *
 * The SDK flips its private state to `"disconnected"` when the CLI child
 * dies and emits nothing, and it only auto-starts from `createSession` /
 * `resumeSession` while `connection` is null. A dead child therefore leaves
 * the client object looking usable while every request rejects. This
 * supervisor owns the recovery decision: ping is proof of liveness only when
 * it answers, a timeout is `"unknown"` (a busy child is not a dead child),
 * and only a rejecting ping permits a restart.
 *
 * Restarts are serialized with a one-permit semaphore and re-probe inside the
 * permit, so concurrent callers (watchdog, Stop, provider refresh) cannot
 * double-start the runtime.
 *
 * @module provider/copilot/CopilotRuntimeSupervisor
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as SubscriptionRef from "effect/SubscriptionRef";

export interface CopilotRuntimeClient {
  readonly ping: (message?: string) => Promise<unknown>;
  readonly start: () => Promise<void>;
  readonly forceStop: () => Promise<void>;
}

export type CopilotRuntimeLiveness = "alive" | "dead" | "unknown";

export interface CopilotRuntimeSupervisor {
  /** "dead" only when ping rejects; a ping that times out is "unknown" and never triggers a restart. */
  readonly probe: Effect.Effect<CopilotRuntimeLiveness>;
  /** Under a one-permit semaphore: re-probe; when dead, forceStop (errors ignored) then start. True when a restart succeeded. */
  readonly restartIfDead: Effect.Effect<boolean>;
  readonly restartCount: SubscriptionRef.SubscriptionRef<number>;
}

export const makeCopilotRuntimeSupervisor = (
  client: CopilotRuntimeClient,
): Effect.Effect<CopilotRuntimeSupervisor> =>
  Effect.gen(function* () {
    const restartSemaphore = yield* Semaphore.make(1);
    const restartCount = yield* SubscriptionRef.make(0);

    const probe: Effect.Effect<CopilotRuntimeLiveness> = Effect.tryPromise(() =>
      client.ping(),
    ).pipe(
      Effect.timeoutOption("5 seconds"),
      Effect.result,
      Effect.map((result): CopilotRuntimeLiveness => {
        if (Result.isFailure(result)) return "dead";
        return Option.isNone(result.success) ? "unknown" : "alive";
      }),
    );

    const restartIfDead = restartSemaphore.withPermits(1)(
      Effect.gen(function* () {
        if ((yield* probe) !== "dead") return false;
        yield* Effect.tryPromise(() => client.forceStop()).pipe(Effect.ignore);
        return yield* Effect.tryPromise(() => client.start()).pipe(
          Effect.tap(() => SubscriptionRef.update(restartCount, (count) => count + 1)),
          Effect.tap(() => Effect.logInfo("GitHub Copilot runtime restarted.")),
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("GitHub Copilot runtime restart failed.", { cause }).pipe(
              Effect.as(false),
            ),
          ),
        );
      }),
    );

    return { probe, restartIfDead, restartCount } satisfies CopilotRuntimeSupervisor;
  });
