import * as Schema from "effect/Schema";

const LegacyConnectionCatalogDocument = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  targets: Schema.Array(Schema.Unknown),
  profiles: Schema.Array(Schema.Unknown),
  credentials: Schema.Array(Schema.Unknown),
});

export const ConnectionCatalogDocument = Schema.Struct({
  schemaVersion: Schema.Literal(2),
});
export type ConnectionCatalogDocument = typeof ConnectionCatalogDocument.Type;

export const StoredConnectionCatalogDocument = Schema.Union([
  ConnectionCatalogDocument,
  LegacyConnectionCatalogDocument,
]);
export type StoredConnectionCatalogDocument = typeof StoredConnectionCatalogDocument.Type;

export const EMPTY_CONNECTION_CATALOG_DOCUMENT: ConnectionCatalogDocument = Object.freeze({
  schemaVersion: 2,
});

export function normalizeConnectionCatalogDocument(
  _document: StoredConnectionCatalogDocument,
): ConnectionCatalogDocument {
  return EMPTY_CONNECTION_CATALOG_DOCUMENT;
}
