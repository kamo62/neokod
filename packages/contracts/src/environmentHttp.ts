import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpServerRespondable from "effect/unstable/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ExecutionEnvironmentDescriptor } from "./environment.ts";
import {
  ClientOrchestrationCommand,
  DispatchResult,
  OrchestrationReadModel,
  OrchestrationShellSnapshot,
  OrchestrationThreadDetailSnapshot,
} from "./orchestration.ts";

const OptionalAuthorizationHeaders = Schema.Struct({
  authorization: Schema.optionalKey(Schema.String),
});

export const EnvironmentRequestInvalidReason = Schema.Literal("invalid_command");
export type EnvironmentRequestInvalidReason = typeof EnvironmentRequestInvalidReason.Type;

export const EnvironmentWslBearerInvalidReason = Schema.Literals([
  "missing_credential",
  "invalid_credential",
  "missing_websocket_ticket",
  "invalid_websocket_ticket",
]);
export type EnvironmentWslBearerInvalidReason = typeof EnvironmentWslBearerInvalidReason.Type;

export const EnvironmentInternalErrorReason = Schema.Literals([
  "orchestration_snapshot_failed",
  "orchestration_thread_snapshot_failed",
  "orchestration_dispatch_failed",
  "internal_error",
]);
export type EnvironmentInternalErrorReason = typeof EnvironmentInternalErrorReason.Type;

export class EnvironmentRequestInvalidError extends Schema.TaggedErrorClass<EnvironmentRequestInvalidError>()(
  "EnvironmentRequestInvalidError",
  {
    code: Schema.Literal("invalid_request"),
    reason: EnvironmentRequestInvalidReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 400 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentRequestInvalidError)(this, { status: 400 });
  }
}

export class EnvironmentWslBearerInvalidError extends Schema.TaggedErrorClass<EnvironmentWslBearerInvalidError>()(
  "EnvironmentWslBearerInvalidError",
  {
    code: Schema.Literal("wsl_bearer_invalid"),
    reason: EnvironmentWslBearerInvalidReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 401 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentWslBearerInvalidError)(this, { status: 401 });
  }
}

export class EnvironmentInternalError extends Schema.TaggedErrorClass<EnvironmentInternalError>()(
  "EnvironmentInternalError",
  {
    code: Schema.Literal("internal_error"),
    reason: EnvironmentInternalErrorReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 500 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentInternalError)(this, { status: 500 });
  }
}

export const EnvironmentResourceNotFoundReason = Schema.Literal("thread_not_found");
export type EnvironmentResourceNotFoundReason = typeof EnvironmentResourceNotFoundReason.Type;

export class EnvironmentResourceNotFoundError extends Schema.TaggedErrorClass<EnvironmentResourceNotFoundError>()(
  "EnvironmentResourceNotFoundError",
  {
    code: Schema.Literal("not_found"),
    reason: EnvironmentResourceNotFoundReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 404 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentResourceNotFoundError)(this, { status: 404 });
  }
}

export const EnvironmentHttpCommonError = Schema.Union([
  EnvironmentRequestInvalidError,
  EnvironmentWslBearerInvalidError,
  EnvironmentResourceNotFoundError,
  EnvironmentInternalError,
]);
export type EnvironmentHttpCommonError = typeof EnvironmentHttpCommonError.Type;

const EnvironmentOrchestrationSnapshotErrors = [
  EnvironmentWslBearerInvalidError,
  EnvironmentInternalError,
] as const;
const EnvironmentOrchestrationThreadSnapshotErrors = [
  EnvironmentWslBearerInvalidError,
  EnvironmentResourceNotFoundError,
  EnvironmentInternalError,
] as const;
const EnvironmentOrchestrationDispatchErrors = [
  EnvironmentRequestInvalidError,
  EnvironmentWslBearerInvalidError,
  EnvironmentInternalError,
] as const;

export const WslWebSocketTicketResult = Schema.Struct({
  ticket: TrimmedNonEmptyString,
  expiresAt: Schema.DateTimeUtc,
});
export type WslWebSocketTicketResult = typeof WslWebSocketTicketResult.Type;

export class EnvironmentMetadataHttpApi extends HttpApiGroup.make("metadata").add(
  HttpApiEndpoint.get("descriptor", "/.well-known/t3/environment", {
    success: ExecutionEnvironmentDescriptor,
    error: EnvironmentWslBearerInvalidError,
  }),
) {}

const EnvironmentOrchestrationThreadSnapshotParams = Schema.Struct({
  threadId: ThreadId,
});

export class EnvironmentOrchestrationHttpApi extends HttpApiGroup.make("orchestration")
  .add(
    HttpApiEndpoint.get("snapshot", "/api/orchestration/snapshot", {
      headers: OptionalAuthorizationHeaders,
      success: OrchestrationReadModel,
      error: EnvironmentOrchestrationSnapshotErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("shellSnapshot", "/api/orchestration/shell", {
      headers: OptionalAuthorizationHeaders,
      success: OrchestrationShellSnapshot,
      error: EnvironmentOrchestrationSnapshotErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("threadSnapshot", "/api/orchestration/threads/:threadId", {
      headers: OptionalAuthorizationHeaders,
      params: EnvironmentOrchestrationThreadSnapshotParams,
      success: OrchestrationThreadDetailSnapshot,
      error: EnvironmentOrchestrationThreadSnapshotErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("dispatch", "/api/orchestration/dispatch", {
      headers: OptionalAuthorizationHeaders,
      payload: ClientOrchestrationCommand,
      success: DispatchResult,
      error: EnvironmentOrchestrationDispatchErrors,
    }),
  ) {}

export class EnvironmentHttpApi extends HttpApi.make("environment")
  .add(EnvironmentMetadataHttpApi)
  .add(EnvironmentOrchestrationHttpApi) {}
