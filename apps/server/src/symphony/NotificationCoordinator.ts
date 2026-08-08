import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

export interface SymphonyNotification {
  readonly kind:
    | "run_completed"
    | "run_failed"
    | "attention_raised"
    | "merge_approved"
    | "workflow_invalid";
  readonly title: string;
  readonly message: string;
  readonly workItemId?: string;
  readonly runAttemptId?: string;
  readonly createdAt: string;
}

export interface NotificationCoordinatorShape {
  readonly publish: (notification: SymphonyNotification) => Effect.Effect<void>;
  readonly subscribe: () => Stream.Stream<SymphonyNotification>;
}

export class NotificationCoordinator extends Context.Service<
  NotificationCoordinator,
  NotificationCoordinatorShape
>()("neokod/symphony/NotificationCoordinator") {}

export const makeNotificationCoordinator: Effect.Effect<
  NotificationCoordinatorShape,
  never,
  never
> = Effect.gen(function* () {
  const hub = yield* PubSub.unbounded<SymphonyNotification>();
  const publish: NotificationCoordinatorShape["publish"] = (notification) =>
    PubSub.publish(hub, notification).pipe(Effect.asVoid);
  const subscribe: NotificationCoordinatorShape["subscribe"] = () => Stream.fromPubSub(hub);
  return { publish, subscribe };
});

export const NotificationCoordinatorLive: Layer.Layer<NotificationCoordinator, never, never> =
  Layer.effect(NotificationCoordinator, makeNotificationCoordinator);
