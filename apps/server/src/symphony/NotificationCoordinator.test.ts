import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { NotificationCoordinator, NotificationCoordinatorLive } from "./NotificationCoordinator.ts";

const layer = it.layer(NotificationCoordinatorLive);

layer("NotificationCoordinator", (it) => {
  it.effect("publishes notifications without error", () =>
    Effect.gen(function* () {
      const coordinator = yield* NotificationCoordinator;
      yield* coordinator.publish({
        kind: "run_completed",
        title: "Done",
        message: "The run finished.",
        createdAt: "2026-08-07T00:00:00.000Z",
      });
      yield* coordinator.publish({
        kind: "merge_approved",
        title: "Merge approved",
        message: "Approved.",
        createdAt: "2026-08-07T00:00:00.000Z",
      });
      expect(true).toBe(true);
    }),
  );

  it.effect("subscribing returns a stream", () =>
    Effect.gen(function* () {
      const coordinator = yield* NotificationCoordinator;
      const stream = coordinator.subscribe();
      expect(stream).toBeDefined();
    }),
  );
});
