import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as DesktopLocalServer from "./DesktopLocalServer.ts";

describe("DesktopLocalServer", () => {
  it.effect("always configures the primary backend on IPv4 loopback", () =>
    Effect.gen(function* () {
      const server = yield* DesktopLocalServer.DesktopLocalServer;
      const config = yield* server.configure(4173);

      assert.equal(config.bindHost, "127.0.0.1");
      assert.equal(config.httpBaseUrl.href, "http://127.0.0.1:4173/");
      assert.deepEqual(yield* server.config, config);
    }).pipe(Effect.provide(DesktopLocalServer.layer)),
  );
});
