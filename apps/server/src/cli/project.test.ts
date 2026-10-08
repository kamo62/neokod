import { assert, expect, it } from "@effect/vitest";

import { EnvironmentInternalError } from "@neokod/contracts";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as NodeServices from "@effect/platform-node/NodeServices";

import {
  ProjectLiveServerDeclaredResponseError,
  ProjectLiveServerRequestError,
  fetchLiveOrchestrationSnapshot,
  projectCommandErrorFromLiveServerRequest,
  tryResolveLiveProjectExecutionMode,
} from "./project.ts";
import type * as ServerConfig from "../config.ts";

it("maps declared server failures into structural project command errors", () => {
  const cause = new EnvironmentInternalError({
    code: "internal_error",
    reason: "orchestration_snapshot_failed",
    traceId: "trace-123",
  });

  const error = projectCommandErrorFromLiveServerRequest(cause);

  assert.instanceOf(error, ProjectLiveServerDeclaredResponseError);
  assert.strictEqual(error.operation, "callLiveServer");
  assert.strictEqual(error.code, "internal_error");
  assert.strictEqual(error.traceId, "trace-123");
  assert.strictEqual(error.message, "Server request failed (internal_error, trace trace-123).");
  assert.strictEqual(error.cause, cause);
});

it("preserves unexpected server failures without deriving the message from them", () => {
  const cause = new Error("credential abc123 was rejected");

  const error = projectCommandErrorFromLiveServerRequest(cause);

  assert.instanceOf(error, ProjectLiveServerRequestError);
  assert.strictEqual(error.operation, "callLiveServer");
  assert.strictEqual(error.message, "Failed to call the running server.");
  assert.strictEqual(error.cause, cause);
});

const stubLiveClient = (
  captured: Array<string | null>,
  status: number,
  body: unknown,
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const headers = request.headers as unknown as Record<string, string | undefined>;
      captured.push(headers["authorization"] ?? null);
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body, { status })));
    }),
  );

it.effect("sends the bearer header to the live server", () =>
  Effect.gen(function* () {
    const captured: Array<string | null> = [];
    const unauthorized = {
      _tag: "EnvironmentWslBearerInvalidError",
      code: "wsl_bearer_invalid",
      reason: "invalid_credential",
      traceId: "trace-1",
    };
    const result = yield* fetchLiveOrchestrationSnapshot("http://127.0.0.1:9", "t".repeat(40)).pipe(
      Effect.provide(stubLiveClient(captured, 401, unauthorized)),
      Effect.result,
    );
    expect(result._tag).toBe("Failure");
    assert.deepStrictEqual(captured, [`Bearer ${"t".repeat(40)}`]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a 401 from the live server fails the command and keeps the runtime state file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectory({ prefix: "neokod-project-cli-" });
    const statePath = `${dir}/server-runtime.json`;
    const origin = "http://127.0.0.1:9";
    yield* fs.writeFileString(
      statePath,
      `{"version":1,"pid":1,"port":9,"origin":"${origin}","startedAt":"2026-01-01T00:00:00.000Z"}`,
    );
    const captured: Array<string | null> = [];
    const unauthorized = {
      _tag: "EnvironmentWslBearerInvalidError",
      code: "wsl_bearer_invalid",
      reason: "invalid_credential",
      traceId: "trace-1",
    };
    const config = { serverRuntimeStatePath: statePath } as ServerConfig.ServerConfig["Service"];
    const result = yield* tryResolveLiveProjectExecutionMode(config).pipe(
      Effect.provide(stubLiveClient(captured, 401, unauthorized)),
      Effect.result,
    );
    assert.strictEqual(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.strictEqual(result.failure._tag, "ProjectLiveServerUnauthorizedError");
    }
    assert.strictEqual(yield* fs.exists(statePath), true);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("no token set sends no header", () =>
  Effect.gen(function* () {
    const captured: Array<string | null> = [];
    const unauthorized = {
      _tag: "EnvironmentWslBearerInvalidError",
      code: "wsl_bearer_invalid",
      reason: "invalid_credential",
      traceId: "trace-1",
    };
    yield* fetchLiveOrchestrationSnapshot("http://127.0.0.1:9", undefined).pipe(
      Effect.provide(stubLiveClient(captured, 401, unauthorized)),
      Effect.result,
    );
    assert.deepStrictEqual(captured, [null]);
  }).pipe(Effect.provide(NodeServices.layer)),
);
