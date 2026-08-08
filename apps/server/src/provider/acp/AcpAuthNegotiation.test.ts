// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const mockAgentCommand = "node";
const mockAgentArgs = [mockAgentPath];

const authenticateEvents = (events: ReadonlyArray<AcpSessionRuntime.AcpSessionRequestLogEvent>) =>
  events.filter((event) => event.method === "authenticate");

describe("AcpSessionRuntime auth negotiation", () => {
  it.effect(
    "starts without sending authenticate when the agent advertises no auth methods (Kiro)",
    () => {
      const requestEvents: Array<AcpSessionRuntime.AcpSessionRequestLogEvent> = [];
      return Effect.gen(function* () {
        const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
        const started = yield* runtime.start();

        expect(started.sessionId).toBe("mock-session-1");
        expect(started.initializeResult.authMethods ?? []).toEqual([]);
        // Kiro relies on CLI login state: no ACP authenticate call is issued.
        expect(authenticateEvents(requestEvents)).toHaveLength(0);
      }).pipe(
        Effect.provide(
          AcpSessionRuntime.layer({
            spawn: {
              command: mockAgentCommand,
              args: mockAgentArgs,
              env: { NEOKOD_ACP_AUTH_METHOD_IDS: "" },
            },
            cwd: process.cwd(),
            clientInfo: { name: "neokod-test", version: "0.0.0" },
            // No authMethodId configured, mirroring the Kiro adapter.
            requestLogger: (event) =>
              Effect.sync(() => {
                requestEvents.push(event);
              }),
          }),
        ),
        Effect.scoped,
        Effect.provide(NodeServices.layer),
      );
    },
  );

  it.effect("fails startup when a configured auth method is not advertised", () => {
    const requestEvents: Array<AcpSessionRuntime.AcpSessionRequestLogEvent> = [];
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      const error = yield* runtime.start().pipe(Effect.flip);

      expect(error._tag).toBe("AcpRequestError");
      if (error._tag === "AcpRequestError") {
        expect(error.code).toBe(-32601);
        expect(error.data).toMatchObject({
          reason: "auth_method_unadvertised",
          configuredMethodId: "cursor_login",
          advertisedMethodIds: ["kiro_login"],
        });
      }
      // Negotiation fails before any authenticate call is sent.
      expect(authenticateEvents(requestEvents)).toHaveLength(0);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: mockAgentCommand,
            args: mockAgentArgs,
            env: { NEOKOD_ACP_AUTH_METHOD_IDS: "kiro_login" },
          },
          cwd: process.cwd(),
          clientInfo: { name: "neokod-test", version: "0.0.0" },
          authMethodId: "cursor_login",
          requestLogger: (event) =>
            Effect.sync(() => {
              requestEvents.push(event);
            }),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("allows an explicitly pre-authenticated agent to advertise login methods", () => {
    const requestEvents: Array<AcpSessionRuntime.AcpSessionRequestLogEvent> = [];
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      const started = yield* runtime.start();

      expect(started.sessionId).toBe("mock-session-1");
      expect(started.initializeResult.authMethods?.map((method) => method.id)).toEqual([
        "aws-builder-id",
      ]);
      expect(authenticateEvents(requestEvents)).toHaveLength(0);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: mockAgentCommand,
            args: mockAgentArgs,
            env: {
              NEOKOD_ACP_AUTH_METHOD_IDS: "aws-builder-id",
              KIRO_API_KEY: "kiro-test-key",
            },
          },
          cwd: process.cwd(),
          clientInfo: { name: "neokod-test", version: "0.0.0" },
          preAuthenticatedByEnvironmentVariable: "KIRO_API_KEY",
          requestLogger: (event) =>
            Effect.sync(() => {
              requestEvents.push(event);
            }),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("rejects a pre-authentication claim without filtered child credential evidence", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      const error = yield* runtime.start().pipe(Effect.flip);

      expect(error._tag).toBe("AcpRequestError");
      if (error._tag === "AcpRequestError") {
        expect(error.data).toMatchObject({
          reason: "preauthentication_credential_missing",
          environmentVariable: "KIRO_API_KEY",
        });
      }
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: mockAgentCommand,
            args: mockAgentArgs,
            env: { NEOKOD_ACP_AUTH_METHOD_IDS: "aws-builder-id" },
          },
          cwd: process.cwd(),
          clientInfo: { name: "neokod-test", version: "0.0.0" },
          preAuthenticatedByEnvironmentVariable: "KIRO_API_KEY",
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("fails startup when the agent advertises auth methods but none is configured", () => {
    const requestEvents: Array<AcpSessionRuntime.AcpSessionRequestLogEvent> = [];
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      const error = yield* runtime.start().pipe(Effect.flip);

      expect(error._tag).toBe("AcpRequestError");
      if (error._tag === "AcpRequestError") {
        expect(error.code).toBe(-32000);
        expect(error.data).toMatchObject({
          reason: "authentication_required",
          advertisedMethodIds: ["cursor_login"],
        });
      }
      expect(authenticateEvents(requestEvents)).toHaveLength(0);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: mockAgentCommand,
            args: mockAgentArgs,
            env: { NEOKOD_ACP_AUTH_METHOD_IDS: "cursor_login" },
          },
          cwd: process.cwd(),
          clientInfo: { name: "neokod-test", version: "0.0.0" },
          // No authMethodId configured.
          requestLogger: (event) =>
            Effect.sync(() => {
              requestEvents.push(event);
            }),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("authenticates with the configured Cursor method when it is advertised", () => {
    const requestEvents: Array<AcpSessionRuntime.AcpSessionRequestLogEvent> = [];
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      const started = yield* runtime.start();

      expect(started.sessionId).toBe("mock-session-1");
      const authenticate = authenticateEvents(requestEvents);
      expect(authenticate.some((event) => event.status === "started")).toBe(true);
      expect(authenticate.some((event) => event.status === "succeeded")).toBe(true);
      const startedAuthenticate = authenticate.find((event) => event.status === "started");
      expect(startedAuthenticate?.payload).toMatchObject({ methodId: "cursor_login" });
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: mockAgentCommand,
            args: mockAgentArgs,
            env: { NEOKOD_ACP_AUTH_METHOD_IDS: "cursor_login" },
          },
          cwd: process.cwd(),
          clientInfo: { name: "neokod-test", version: "0.0.0" },
          authMethodId: "cursor_login",
          requestLogger: (event) =>
            Effect.sync(() => {
              requestEvents.push(event);
            }),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("authenticates with the configured Grok method when it is advertised", () => {
    const requestEvents: Array<AcpSessionRuntime.AcpSessionRequestLogEvent> = [];
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      const started = yield* runtime.start();

      expect(started.sessionId).toBe("mock-session-1");
      const startedAuthenticate = authenticateEvents(requestEvents).find(
        (event) => event.status === "started",
      );
      expect(startedAuthenticate?.payload).toMatchObject({ methodId: "cached_token" });
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: mockAgentCommand,
            args: mockAgentArgs,
            env: { NEOKOD_ACP_AUTH_METHOD_IDS: "xai.api_key,cached_token" },
          },
          cwd: process.cwd(),
          clientInfo: { name: "neokod-test", version: "0.0.0" },
          authMethodId: "cached_token",
          requestLogger: (event) =>
            Effect.sync(() => {
              requestEvents.push(event);
            }),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });
});
