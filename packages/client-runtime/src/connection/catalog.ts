import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { PrimaryConnectionTarget, WslConnectionTarget, type ConnectionTarget } from "./model.ts";

export interface ConnectionCatalogEntry {
  readonly target: ConnectionTarget;
  readonly wslBearerToken: Option.Option<string>;
}

export class PrimaryConnectionRegistration extends Schema.TaggedClass<PrimaryConnectionRegistration>()(
  "PrimaryConnectionRegistration",
  { target: PrimaryConnectionTarget },
) {}

export class WslConnectionRegistration extends Schema.TaggedClass<WslConnectionRegistration>()(
  "WslConnectionRegistration",
  {
    target: WslConnectionTarget,
    wslBearerToken: Schema.String,
  },
) {}

export const PlatformConnectionRegistration = Schema.Union([
  PrimaryConnectionRegistration,
  WslConnectionRegistration,
]);
export type PlatformConnectionRegistration = typeof PlatformConnectionRegistration.Type;

export function connectionRegistrationCatalogEntry(
  registration: PlatformConnectionRegistration,
): ConnectionCatalogEntry {
  return {
    target: registration.target,
    wslBearerToken:
      registration._tag === "WslConnectionRegistration"
        ? Option.some(registration.wslBearerToken)
        : Option.none(),
  };
}
