import * as Effect from "effect/Effect";
import type {
  PreparedLoopbackAuthorization,
  PreparedWslBearerAuthorization,
} from "../connection/model.ts";

export interface WslHttpAuthorizationHeaders {
  readonly authorization?: string;
}

/**
 * Build the `Authorization: Bearer <token>` header for an HTTP request against
 * an authenticated environment. Covers both the WSL bearer transport and the
 * authenticated loopback transport (plan WS-A2); a null authorization means the
 * legacy loopback trust model and sends no header.
 */
export const buildAuthorizationHeaders = (
  authorization: PreparedWslBearerAuthorization | PreparedLoopbackAuthorization | null,
): Effect.Effect<WslHttpAuthorizationHeaders> =>
  Effect.succeed(authorization === null ? {} : { authorization: `Bearer ${authorization.token}` });

/** @deprecated Use {@link buildAuthorizationHeaders}. */
export const buildWslAuthorizationHeaders = (
  authorization: PreparedWslBearerAuthorization | null,
): Effect.Effect<WslHttpAuthorizationHeaders> => buildAuthorizationHeaders(authorization);
