import type { EnvironmentId } from "@neokod/contracts";
import type { RemoteEnvironmentRequestError } from "../rpc/http.ts";
import {
  ConnectionBlockedError,
  type ConnectionAttemptError,
  ConnectionTransientError,
} from "./model.ts";

export function credentialMissingError(connectionId: string): ConnectionBlockedError {
  return new ConnectionBlockedError({
    reason: "authentication",
    detail: `Connection credential ${connectionId} is unavailable.`,
  });
}

export function environmentMismatchError(input: {
  readonly expected: EnvironmentId;
  readonly actual: EnvironmentId;
}): ConnectionBlockedError {
  return new ConnectionBlockedError({
    reason: "configuration",
    detail: `Connected environment ${input.actual} does not match ${input.expected}.`,
  });
}

export function mapRemoteEnvironmentError(
  error: RemoteEnvironmentRequestError,
): ConnectionAttemptError {
  switch (error._tag) {
    case "EnvironmentWslBearerInvalidError":
      return new ConnectionBlockedError({
        reason: "authentication",
        detail: "The WSL environment credential is invalid.",
        traceId: error.traceId,
      });
    case "EnvironmentRequestInvalidError":
      return new ConnectionBlockedError({
        reason: "configuration",
        detail: "The environment rejected the authentication request.",
        traceId: error.traceId,
      });
    case "EnvironmentResourceNotFoundError":
      return new ConnectionBlockedError({
        reason: "configuration",
        detail: "The environment endpoint could not be found.",
        traceId: error.traceId,
      });
    case "RemoteEnvironmentRequestTimeoutError":
      return new ConnectionTransientError({ reason: "timeout", detail: error.message });
    case "RemoteEnvironmentRequestFetchError":
      return new ConnectionTransientError({ reason: "network", detail: error.message });
    case "EnvironmentInternalError":
      return new ConnectionTransientError({
        reason: "remote-unavailable",
        detail: "The environment could not authorize the connection.",
        traceId: error.traceId,
      });
    case "RemoteEnvironmentRequestUndeclaredStatusError":
      return error.status === 401
        ? new ConnectionBlockedError({
            reason: "authentication",
            detail: "The WSL environment rejected its bearer credential.",
          })
        : new ConnectionTransientError({ reason: "remote-unavailable", detail: error.message });
    case "RemoteEnvironmentRequestInvalidJsonError":
      return new ConnectionTransientError({
        reason: "remote-unavailable",
        detail: error.message,
      });
  }
}
