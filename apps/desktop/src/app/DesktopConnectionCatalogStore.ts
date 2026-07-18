import {
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
  ConnectionCatalogDocument,
} from "@neokod/client-runtime/platform";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";

const EncryptedConnectionCatalogDocument = Schema.Struct({
  version: Schema.Literal(1),
  encryptedCatalog: Schema.String,
});
type EncryptedConnectionCatalogDocument = typeof EncryptedConnectionCatalogDocument.Type;

const encodeEncryptedDocument = Schema.encodeEffect(
  Schema.fromJsonString(EncryptedConnectionCatalogDocument),
);
const encodeEmptyCatalog = Schema.encodeEffect(Schema.fromJsonString(ConnectionCatalogDocument));

const { logWarning: logCatalogWarning } = makeComponentLogger("desktop-connection-catalog");

export class DesktopConnectionCatalogStoreWriteError extends Schema.TaggedErrorClass<DesktopConnectionCatalogStoreWriteError>()(
  "DesktopConnectionCatalogStoreWriteError",
  {
    operation: Schema.Literals([
      "create-temporary-file-name",
      "encode-document",
      "create-directory",
      "write-temporary-file",
      "replace-catalog-file",
    ]),
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop connection catalog write failed during ${this.operation} at ${this.path}.`;
  }
}

export class DesktopConnectionCatalogStoreReadError extends Schema.TaggedErrorClass<DesktopConnectionCatalogStoreReadError>()(
  "DesktopConnectionCatalogStoreReadError",
  { catalogPath: Schema.String, cause: Schema.Defect() },
) {}

export class DesktopConnectionCatalogStoreDocumentDecodeError extends Schema.TaggedErrorClass<DesktopConnectionCatalogStoreDocumentDecodeError>()(
  "DesktopConnectionCatalogStoreDocumentDecodeError",
  { catalogPath: Schema.String, cause: Schema.Defect() },
) {}

export class DesktopConnectionCatalogStoreProtectionError extends Schema.TaggedErrorClass<DesktopConnectionCatalogStoreProtectionError>()(
  "DesktopConnectionCatalogStoreProtectionError",
  {
    operation: Schema.Literals([
      "check-encryption-availability",
      "encrypt-catalog",
      "decrypt-catalog",
    ]),
    catalogPath: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class DesktopConnectionCatalogStore extends Context.Service<
  DesktopConnectionCatalogStore,
  {
    readonly get: Effect.Effect<
      Option.Option<string>,
      | DesktopConnectionCatalogStoreReadError
      | DesktopConnectionCatalogStoreDocumentDecodeError
      | DesktopConnectionCatalogStoreWriteError
      | DesktopConnectionCatalogStoreProtectionError
    >;
    readonly set: (
      catalog: string,
    ) => Effect.Effect<
      boolean,
      DesktopConnectionCatalogStoreWriteError | DesktopConnectionCatalogStoreProtectionError
    >;
    readonly clear: Effect.Effect<void>;
  }
>()("@neokod/desktop/app/DesktopConnectionCatalogStore") {}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const crypto = yield* Crypto.Crypto;
  const catalogPath = path.join(environment.stateDir, "connection-catalog.json");

  const encryptionAvailable = safeStorage.isEncryptionAvailable.pipe(
    Effect.mapError(
      (cause) =>
        new DesktopConnectionCatalogStoreProtectionError({
          operation: "check-encryption-availability",
          catalogPath,
          cause,
        }),
    ),
  );

  const writeCatalog = Effect.fn("desktop.connectionCatalogStore.writeCatalog")(function* (
    catalog: string,
  ) {
    const encryptedCatalog = Encoding.encodeBase64(
      yield* safeStorage.encryptString(catalog).pipe(
        Effect.mapError(
          (cause) =>
            new DesktopConnectionCatalogStoreProtectionError({
              operation: "encrypt-catalog",
              catalogPath,
              cause,
            }),
        ),
      ),
    );
    const suffix = (yield* crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new DesktopConnectionCatalogStoreWriteError({
            operation: "create-temporary-file-name",
            path: catalogPath,
            cause,
          }),
      ),
    )).replaceAll("-", "");
    const encoded = yield* encodeEncryptedDocument({ version: 1, encryptedCatalog }).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopConnectionCatalogStoreWriteError({
            operation: "encode-document",
            path: catalogPath,
            cause,
          }),
      ),
    );
    const directory = path.dirname(catalogPath);
    const temporaryPath = `${catalogPath}.${process.pid}.${suffix}.tmp`;
    yield* fileSystem.makeDirectory(directory, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopConnectionCatalogStoreWriteError({
            operation: "create-directory",
            path: directory,
            cause,
          }),
      ),
    );
    yield* Effect.gen(function* () {
      yield* fileSystem.writeFileString(temporaryPath, `${encoded}\n`).pipe(
        Effect.mapError(
          (cause) =>
            new DesktopConnectionCatalogStoreWriteError({
              operation: "write-temporary-file",
              path: temporaryPath,
              cause,
            }),
        ),
      );
      yield* fileSystem.rename(temporaryPath, catalogPath).pipe(
        Effect.mapError(
          (cause) =>
            new DesktopConnectionCatalogStoreWriteError({
              operation: "replace-catalog-file",
              path: catalogPath,
              cause,
            }),
        ),
      );
    }).pipe(Effect.ensuring(fileSystem.remove(temporaryPath, { force: true }).pipe(Effect.ignore)));
  });

  const canonicalEmptyCatalog = yield* encodeEmptyCatalog(EMPTY_CONNECTION_CATALOG_DOCUMENT).pipe(
    Effect.orDie,
  );
  const purgeLegacyRegistry = fileSystem
    .remove(environment.savedEnvironmentRegistryPath, { force: true })
    .pipe(Effect.ignore);

  return DesktopConnectionCatalogStore.of({
    get: Effect.gen(function* () {
      yield* purgeLegacyRegistry;
      const canEncrypt = yield* encryptionAvailable.pipe(
        Effect.catch((cause) =>
          logCatalogWarning("encryption availability probe failed; treating as unavailable", {
            cause: String(cause),
          }).pipe(Effect.as(false)),
        ),
      );
      if (canEncrypt) {
        yield* writeCatalog(canonicalEmptyCatalog);
      }
      return Option.some(canonicalEmptyCatalog);
    }).pipe(Effect.withSpan("desktop.connectionCatalogStore.get")),
    set: () =>
      Effect.gen(function* () {
        yield* purgeLegacyRegistry;
        if (!(yield* encryptionAvailable)) return false;
        yield* writeCatalog(canonicalEmptyCatalog);
        return true;
      }),
    clear: Effect.all(
      [
        fileSystem.remove(catalogPath, { force: true }),
        fileSystem.remove(environment.savedEnvironmentRegistryPath, { force: true }),
      ],
      { discard: true },
    ).pipe(Effect.ignore, Effect.withSpan("desktop.connectionCatalogStore.clear")),
  });
});

export const layer = Layer.effect(DesktopConnectionCatalogStore, make);
