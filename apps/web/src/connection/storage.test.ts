import { ConnectionTransientError } from "@neokod/client-runtime/connection";
import { ConnectionCatalogDocument } from "@neokod/client-runtime/platform";
import { EnvironmentId, ThreadId } from "@neokod/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { afterEach, vi } from "vite-plus/test";

import {
  makeCatalogBackend,
  makeCatalogStore,
  StoredThreadSnapshotJson,
  THREAD_SNAPSHOT_CACHE_SCHEMA_VERSION,
} from "./storage";

const emptyCatalog = {
  schemaVersion: 2,
} as const;
const decodeCatalog = Schema.decodeUnknownSync(Schema.fromJsonString(ConnectionCatalogDocument));
const encodeStoredThreadSnapshot = Schema.encodeSync(StoredThreadSnapshotJson);
const decodeStoredThreadSnapshot = Schema.decodeUnknownExit(StoredThreadSnapshotJson);

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

describe("StoredThreadSnapshot", () => {
  it("rejects a thread cache written before server-owned settlement", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const threadId = ThreadId.make("thread-1");
    const snapshot = {
      snapshotSequence: 1,
      thread: {
        id: threadId,
        projectId: "project-1" as never,
        title: "Recovered thread",
        modelSelection: { instanceId: "codex" as never, model: "gpt-5.4" },
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        // A legacy cache could hold a client-inferred completion here.
        latestTurn: {
          turnId: "turn-1" as never,
          state: "interrupted" as const,
          requestedAt: "2026-04-01T00:00:00.000Z",
          startedAt: "2026-04-01T00:00:00.000Z",
          completedAt: "2026-04-02T00:00:00.000Z",
          assistantMessageId: null,
        },
        createdAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-02T00:00:00.000Z",
        archivedAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    };
    const encoded = encodeStoredThreadSnapshot({
      schemaVersion: THREAD_SNAPSHOT_CACHE_SCHEMA_VERSION,
      environmentId,
      threadId,
      snapshot,
    });

    // The current format decodes.
    expect(Exit.isSuccess(decodeStoredThreadSnapshot(encoded))).toBe(true);

    // A previous-format cache is rejected, so the client fetches an
    // authoritative snapshot instead of trusting a client-inferred record.
    const legacy = JSON.stringify({ ...JSON.parse(encoded), schemaVersion: 2 });
    expect(Exit.isFailure(decodeStoredThreadSnapshot(legacy))).toBe(true);
  });
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
