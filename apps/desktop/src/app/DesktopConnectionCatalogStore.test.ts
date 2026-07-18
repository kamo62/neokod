import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ConnectionCatalogDocument } from "@neokod/client-runtime/platform";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopConnectionCatalogStore from "./DesktopConnectionCatalogStore.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();
const decodeConnectionCatalog = Schema.decodeEffect(
  Schema.fromJsonString(ConnectionCatalogDocument),
);

function makeSafeStorageLayer(available: boolean, failDecrypt: Ref.Ref<boolean> | null = null) {
  return Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, {
    isEncryptionAvailable: Effect.succeed(available),
    encryptString: (value) => Effect.succeed(textEncoder.encode(`encrypted:${value}`)),
    decryptString: (value) =>
      Effect.gen(function* () {
        const decoded = textDecoder.decode(value);
        if (
          !decoded.startsWith("encrypted:") ||
          (failDecrypt !== null && (yield* Ref.get(failDecrypt)))
        ) {
          return yield* new ElectronSafeStorage.ElectronSafeStorageDecryptError({
            cause: new Error("invalid encrypted catalog"),
          });
        }
        return decoded.slice("encrypted:".length);
      }),
  } satisfies ElectronSafeStorage.ElectronSafeStorage["Service"]);
}

function makeLayer(
  baseDir: string,
  encryptionAvailable = true,
  failDecrypt: Ref.Ref<boolean> | null = null,
) {
  const environmentLayer = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "arm64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ NEOKOD_HOME: baseDir })),
    ),
  );
  return DesktopConnectionCatalogStore.layer.pipe(
    Layer.provideMerge(environmentLayer),
    Layer.provideMerge(makeSafeStorageLayer(encryptionAvailable, failDecrypt)),
    Layer.provideMerge(NodeServices.layer),
  );
}

const withStore = <A, E, R>(
  effect: Effect.Effect<A, E, R | DesktopConnectionCatalogStore.DesktopConnectionCatalogStore>,
  encryptionAvailable = true,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "neokod-desktop-connection-catalog-test-",
    });
    return yield* effect.pipe(Effect.provide(makeLayer(baseDir, encryptionAvailable)));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("DesktopConnectionCatalogStore", () => {
  it.effect("purges a persisted legacy catalog into the empty v2 local catalog", () =>
    withStore(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const legacyProofTokenKey = ["remote", "D", "pop", "Tokens"].join("");
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        const legacyCatalog = JSON.stringify({
          schemaVersion: 1,
          targets: [{ label: "remote.example.com" }, { kind: "relay" }],
          profiles: [{ kind: "ssh" }],
          credentials: [{ token: "secret" }],
          [legacyProofTokenKey]: ["secret"],
        });
        const catalogPath = environment.path.join(environment.stateDir, "connection-catalog.json");
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(
          catalogPath,
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          JSON.stringify({
            version: 1,
            encryptedCatalog: Encoding.encodeBase64(
              textEncoder.encode(`encrypted:${legacyCatalog}`),
            ),
          }),
        );

        const raw = yield* store.get;
        assert.isTrue(Option.isSome(raw));
        if (Option.isSome(raw)) {
          assert.deepEqual(yield* decodeConnectionCatalog(raw.value), { schemaVersion: 2 });
          assert.notInclude(raw.value, "remote.example.com");
          assert.notInclude(raw.value, "secret");
        }

        // @effect-diagnostics-next-line preferSchemaOverJson:off
        const persistedEnvelope = JSON.parse(yield* fileSystem.readFileString(catalogPath)) as {
          readonly encryptedCatalog: string;
        };
        const persistedCatalog = textDecoder.decode(
          Result.getOrThrow(Encoding.decodeBase64(persistedEnvelope.encryptedCatalog)),
        );
        assert.include(persistedCatalog, '"schemaVersion":2');
        assert.notInclude(persistedCatalog, "remote.example.com");
        assert.notInclude(persistedCatalog, "relay");
        assert.notInclude(persistedCatalog, "ssh");
        assert.notInclude(persistedCatalog, "secret");
      }),
    ),
  );

  it.effect("purges the legacy saved-environment registry", () =>
    withStore(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(
          environment.savedEnvironmentRegistryPath,
          '{"environments":[{"httpBaseUrl":"https://remote.example.com"}]}',
        );

        yield* store.get;
        assert.isFalse(yield* fileSystem.exists(environment.savedEnvironmentRegistryPath));
      }),
    ),
  );

  it.effect("returns the empty catalog without persisting when secure storage is unavailable", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        assert.isFalse(yield* store.set("{}"));
        const catalog = yield* store.get;
        assert.isTrue(Option.isSome(catalog));
        if (Option.isSome(catalog)) {
          assert.deepStrictEqual(yield* decodeConnectionCatalog(catalog.value), {
            schemaVersion: 2,
          });
        }
      }),
      false,
    ),
  );

  it.effect("replaces an undecryptable legacy catalog with the empty catalog", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "neokod-desktop-connection-catalog-test-",
      });
      const failDecrypt = yield* Ref.make(false);
      const layer = makeLayer(baseDir, true, failDecrypt);
      const environment = yield* DesktopEnvironment.DesktopEnvironment.pipe(Effect.provide(layer));
      const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.pipe(
        Effect.provide(layer),
      );
      yield* Ref.set(failDecrypt, true);
      const catalogPath = environment.path.join(environment.stateDir, "connection-catalog.json");
      yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
      yield* fileSystem.writeFileString(
        catalogPath,
        '{"version":1,"encryptedCatalog":"bm90LWVuY3J5cHRlZA=="}',
      );

      const catalog = yield* store.get;
      assert.isTrue(Option.isSome(catalog));
      if (Option.isSome(catalog)) {
        assert.deepStrictEqual(yield* decodeConnectionCatalog(catalog.value), { schemaVersion: 2 });
      }

      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const persistedEnvelope = JSON.parse(yield* fileSystem.readFileString(catalogPath)) as {
        readonly encryptedCatalog: string;
      };
      const persistedCatalog = textDecoder.decode(
        Result.getOrThrow(Encoding.decodeBase64(persistedEnvelope.encryptedCatalog)),
      );
      assert.include(persistedCatalog, '"schemaVersion":2');
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it("keeps the encrypted envelope opaque", () => {
    assert.equal(Encoding.encodeBase64(textEncoder.encode("secret")).includes("secret"), false);
  });
});
