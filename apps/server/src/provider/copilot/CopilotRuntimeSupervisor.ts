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
 * A replacement invalidates every adapter-owned SDK session, and the SDK's
 * `forceStop` disconnects them without telling the adapter. The registered
 * settlement effect therefore runs exactly once per actual replacement,
 * inside the permit and before `forceStop`, so active turns, pending
 * approvals, and pending user inputs close before the process underneath
 * them disappears. Settlement lives here, not in each caller, so a provider
 * refresh and the adapter watchdog cannot disagree about who closes them.
 *
 * @module provider/copilot/CopilotRuntimeSupervisor
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
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
  /**
   * Under a one-permit semaphore: re-probe; when dead, run the registered
   * settlement effect once, forceStop (errors ignored), then start. True when
   * a restart succeeded.
   */
  readonly restartIfDead: Effect.Effect<boolean>;
  readonly restartCount: SubscriptionRef.SubscriptionRef<number>;
  /**
   * Registers the adapter settlement effect run before each replacement's
   * `forceStop`. The effect must only close sessions; it must not call
   * `restartIfDead`, which would re-enter the restart permit. Failures are
   * logged by the supervisor so they cannot block recovery.
   */
  readonly registerSettlement: (settle: Effect.Effect<void, never>) => Effect.Effect<void>;
}

export const makeCopilotRuntimeSupervisor = (
  client: CopilotRuntimeClient,
): Effect.Effect<CopilotRuntimeSupervisor> =>
  Effect.gen(function* () {
    const restartSemaphore = yield* Semaphore.make(1);
    const restartCount = yield* SubscriptionRef.make(0);
    const settlement = yield* Ref.make<Effect.Effect<void, never>>(Effect.void);

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
        // Close adapter-owned sessions before forceStop disconnects them. A
        // settlement failure must not block recovery; the adapter logs its
        // own terminal events and the new runtime can still be started.
        const settle = yield* Ref.get(settlement);
        yield* settle.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("GitHub Copilot runtime settlement failed.", { cause }),
          ),
        );
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

    return {
      probe,
      restartIfDead,
      restartCount,
      registerSettlement: (settle) => Ref.set(settlement, settle),
    } satisfies CopilotRuntimeSupervisor;
  });
