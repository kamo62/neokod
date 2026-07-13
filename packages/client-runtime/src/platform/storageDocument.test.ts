import { describe, expect, it } from "@effect/vitest";

import {
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
  normalizeConnectionCatalogDocument,
} from "./storageDocument.ts";

describe("ConnectionCatalogDocument", () => {
  it("keeps the canonical local-only document empty", () => {
    expect(normalizeConnectionCatalogDocument({ schemaVersion: 2 })).toEqual(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
    );
  });

  it("discards legacy targets, profiles, and credentials", () => {
    expect(
      normalizeConnectionCatalogDocument({
        schemaVersion: 1,
        targets: [{ environmentId: "remote" }],
        profiles: [{ token: "must-not-survive" }],
        credentials: [{ token: "must-not-survive" }],
      }),
    ).toEqual(EMPTY_CONNECTION_CATALOG_DOCUMENT);
  });
});
