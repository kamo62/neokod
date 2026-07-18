import { ConnectionTransientError } from "@neokod/client-runtime/connection";
import { ConnectionCatalogDocument } from "@neokod/client-runtime/platform";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { afterEach, vi } from "vite-plus/test";

import { makeCatalogBackend, makeCatalogStore } from "./storage";

const emptyCatalog = {
  schemaVersion: 2,
} as const;
const decodeCatalog = Schema.decodeUnknownSync(Schema.fromJsonString(ConnectionCatalogDocument));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("makeCatalogStore", () => {
  it.effect("quarantines malformed catalogs and starts from an empty document", () =>
    Effect.gen(function* () {
      const writes: string[] = [];
      const quarantined: string[] = [];
      const store = yield* makeCatalogStore({
        read: Effect.succeed("{not-json"),
        write: (raw) => Effect.sync(() => writes.push(raw)),
        quarantine: (raw) => Effect.sync(() => quarantined.push(raw)),
      });

      expect(yield* store.read).toEqual(emptyCatalog);
      expect(quarantined).toEqual(["{not-json"]);
      expect(writes).toHaveLength(1);
      expect(decodeCatalog(writes[0]!)).toEqual(emptyCatalog);
    }),
  );

  it.effect("recovers IPC catalog read failures with an empty document", () =>
    Effect.gen(function* () {
      const getConnectionCatalog = vi.fn().mockRejectedValue(new Error("permission denied"));
      const setConnectionCatalog = vi.fn().mockResolvedValue(true);
      vi.stubGlobal("window", {
        desktopBridge: {
          getConnectionCatalog,
          setConnectionCatalog,
        },
      });
      const store = yield* makeCatalogStore(makeCatalogBackend({} as IDBDatabase));

      expect(yield* store.read).toEqual(emptyCatalog);
      expect(getConnectionCatalog).toHaveBeenCalledOnce();
      expect(setConnectionCatalog).toHaveBeenCalledOnce();
      expect(decodeCatalog(setConnectionCatalog.mock.calls[0]![0])).toEqual(emptyCatalog);
    }),
  );

  it.effect("recovers catalog persistence failures with an empty document", () =>
    Effect.gen(function* () {
      const failure = new ConnectionTransientError({
        reason: "remote-unavailable",
        detail: "permission denied",
      });
      const store = yield* makeCatalogStore({
        read: Effect.succeed(null),
        write: () => Effect.fail(failure),
      });

      expect(yield* store.read).toEqual(emptyCatalog);
    }),
  );
});

describe("makeCatalogBackend", () => {
  it.effect("fails writes when desktop secure storage declines the catalog", () =>
    Effect.gen(function* () {
      const setConnectionCatalog = vi.fn().mockResolvedValue(false);
      vi.stubGlobal("window", {
        desktopBridge: {
          getConnectionCatalog: vi.fn().mockResolvedValue(null),
          setConnectionCatalog,
        },
      });
      const backend = makeCatalogBackend({} as IDBDatabase);

      const error = yield* backend.write("{}").pipe(Effect.flip);

      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error.message).toContain("Desktop secure storage is unavailable");
      expect(setConnectionCatalog).toHaveBeenCalledWith("{}");
    }),
  );
});
