import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

export const DESKTOP_LOOPBACK_HOST = "127.0.0.1";

export interface DesktopLocalServerConfig {
  readonly port: number;
  readonly bindHost: typeof DESKTOP_LOOPBACK_HOST;
  readonly httpBaseUrl: URL;
}

export class DesktopLocalServer extends Context.Service<
  DesktopLocalServer,
  {
    readonly config: Effect.Effect<DesktopLocalServerConfig>;
    readonly configure: (port: number) => Effect.Effect<DesktopLocalServerConfig>;
  }
>()("@t3tools/desktop/backend/DesktopLocalServer") {}

const makeConfig = (port: number): DesktopLocalServerConfig => ({
  port,
  bindHost: DESKTOP_LOOPBACK_HOST,
  httpBaseUrl: new URL(`http://${DESKTOP_LOOPBACK_HOST}:${port}`),
});

export const layer = Layer.effect(
  DesktopLocalServer,
  Effect.gen(function* () {
    const configRef = yield* Ref.make(makeConfig(0));
    return DesktopLocalServer.of({
      config: Ref.get(configRef),
      configure: (port) => {
        const config = makeConfig(port);
        return Ref.set(configRef, config).pipe(Effect.as(config));
      },
    });
  }),
);
