import * as Effect from "effect/Effect";
import type { PreparedWslBearerAuthorization } from "../connection/model.ts";

export interface WslHttpAuthorizationHeaders {
  readonly authorization?: string;
}

export const buildWslAuthorizationHeaders = (
  authorization: PreparedWslBearerAuthorization | null,
): Effect.Effect<WslHttpAuthorizationHeaders> =>
  Effect.succeed(authorization === null ? {} : { authorization: `Bearer ${authorization.token}` });
