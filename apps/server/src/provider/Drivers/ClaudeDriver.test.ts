import { assert, describe, it } from "@effect/vitest";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";

import { claudeCapabilitiesProbeCacheTimeToLive } from "./ClaudeDriver.ts";

describe("claudeCapabilitiesProbeCacheTimeToLive", () => {
  it("expires a probe miss immediately instead of pinning it for the TTL", () => {
    // `probeClaudeCapabilities` maps both errors and timeouts to `undefined`,
    // so a retained miss would keep the panel on "could not verify" for the
    // whole TTL even after the user hits Refresh.
    assert.ok(Duration.isZero(claudeCapabilitiesProbeCacheTimeToLive(Exit.succeed(undefined))));
    assert.ok(Duration.isZero(claudeCapabilitiesProbeCacheTimeToLive(Exit.fail("probe error"))));
  });

  it("keeps a successful probe for the full TTL", () => {
    const ttl = claudeCapabilitiesProbeCacheTimeToLive(Exit.succeed({ email: "user@example.com" }));
    assert.strictEqual(Duration.toMillis(ttl), Duration.toMillis(Duration.minutes(5)));
  });

  it.effect("makes the next cache get re-probe after a miss but not after a hit", () =>
    Effect.gen(function* () {
      const lookups = yield* Ref.make(0);
      const results: ReadonlyArray<string | undefined> = [undefined, undefined, "probe"];
      const cache = yield* Cache.makeWith(
        (_key: string) =>
          Ref.updateAndGet(lookups, (count) => count + 1).pipe(
            Effect.map((count) => results[count - 1]),
          ),
        { capacity: 1, timeToLive: claudeCapabilitiesProbeCacheTimeToLive },
      );

      // Two misses in a row: each get re-runs the lookup because the miss is
      // not retained.
      assert.strictEqual(yield* Cache.get(cache, "key"), undefined);
      assert.strictEqual(yield* Cache.get(cache, "key"), undefined);
      assert.strictEqual(yield* Ref.get(lookups), 2);

      // A hit is retained: further gets inside the TTL do not re-probe.
      assert.strictEqual(yield* Cache.get(cache, "key"), "probe");
      assert.strictEqual(yield* Cache.get(cache, "key"), "probe");
      assert.strictEqual(yield* Ref.get(lookups), 3);
    }),
  );
});
