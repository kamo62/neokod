import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
} from "../connection/catalog.ts";
import { BearerConnectionTarget } from "../connection/model.ts";
import {
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
  registerConnectionInCatalog,
  removeConnectionFromCatalog,
} from "./storageDocument.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const TARGET = new BearerConnectionTarget({
  environmentId: ENVIRONMENT_ID,
  label: "Remote",
  connectionId: "bearer-1",
});
const PROFILE = new BearerConnectionProfile({
  connectionId: TARGET.connectionId,
  environmentId: ENVIRONMENT_ID,
  label: TARGET.label,
  httpBaseUrl: "https://remote.example.test",
  wsBaseUrl: "wss://remote.example.test",
});
const CREDENTIAL = new BearerConnectionCredential({ token: "bearer-token" });

describe("ConnectionCatalogDocument", () => {
  it("registers and removes a bearer connection atomically", () => {
    const registered = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      new BearerConnectionRegistration({
        target: TARGET,
        profile: PROFILE,
        credential: CREDENTIAL,
      }),
    );

    expect(registered.targets).toEqual([TARGET]);
    expect(registered.profiles).toEqual([PROFILE]);
    expect(registered.credentials).toEqual([
      { connectionId: TARGET.connectionId, credential: CREDENTIAL },
    ]);
    expect(removeConnectionFromCatalog(registered, TARGET)).toEqual(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
    );
  });
});
