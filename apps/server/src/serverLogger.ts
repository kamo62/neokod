import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Layer from "effect/Layer";

import { ServerConfig } from "./config.ts";
import { extractErrorName, publishAnalyticsErrorEvent } from "./telemetry/errorEvents.ts";

// Error-and-above entries also feed analytics as coarse `server.error`
// events (class name and level only; the message never travels — it can
// embed user paths or content). Delivery is pull-based through
// telemetry/errorEvents.ts so the logger keeps zero service dependencies.
const analyticsErrorTap = Logger.make((options) => {
  const level = String((options as { logLevel?: unknown }).logLevel);
  if (level !== "Error" && level !== "Fatal") {
    return;
  }
  publishAnalyticsErrorEvent({
    errorName: extractErrorName((options as { cause?: unknown }).cause),
    level,
  });
});

export const ServerLoggerLive = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const minimumLogLevelLayer = Layer.succeed(References.MinimumLogLevel, config.logLevel);
  const loggerLayer = Logger.layer(
    [Logger.consolePretty(), Logger.tracerLogger, analyticsErrorTap],
    {
      mergeWithExisting: false,
    },
  );

  return Layer.mergeAll(loggerLayer, minimumLogLevelLayer);
}).pipe(Layer.unwrap);
