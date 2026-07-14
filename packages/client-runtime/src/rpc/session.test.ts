import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  KeybindingsConfigError,
  ServerConfig,
  TerminalEvent,
  type ServerConfig as ServerConfigType,
  WS_METHODS,
  WsRpcGroup,
  WsServerGetConfigRpc,
  WsSubscribeTerminalEventsRpc,
} from "@neokod/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { RpcMessage } from "effect/unstable/rpc";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";

import {
  ConnectionTransientError,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as RpcSession from "./session.ts";

type SocketEventType = "open" | "message" | "close" | "error";
type SocketEvent = {
  readonly code?: number;
  readonly data?: unknown;
  readonly reason?: string;
  readonly type: SocketEventType;
};
type SocketListener = (event: SocketEvent) => void;

class TestWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = TestWebSocket.CONNECTING;
  readonly sent: string[] = [];
  readonly url: string;
  private readonly listeners = new Map<SocketEventType, Set<SocketListener>>();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: SocketEventType, listener: SocketListener) {
    const listeners = this.listeners.get(type) ?? new Set<SocketListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: SocketEventType, listener: SocketListener) {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code = 1000, reason = "") {
    if (this.readyState === TestWebSocket.CLOSED) {
      return;
    }
    this.readyState = TestWebSocket.CLOSED;
    this.emit("close", { code, reason, type: "close" });
  }

  open() {
    this.readyState = TestWebSocket.OPEN;
    this.emit("open", { type: "open" });
  }

  serverMessage(data: string) {
    this.emit("message", { data, type: "message" });
  }

  private emit(type: SocketEventType, event: SocketEvent) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "http://127.0.0.1:3773",
  wsBaseUrl: "ws://127.0.0.1:3773",
});

const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: "ws://127.0.0.1:3773/ws",
  wslBearerAuthorization: null,
  target: TARGET,
};

const SERVER_CONFIG: ServerConfigType = {
  environment: {
    environmentId: TARGET.environmentId,
    label: TARGET.label,
    platform: {
      os: "darwin",
      arch: "arm64",
    },
    serverVersion: "0.0.0-test",
    capabilities: {
      repositoryIdentity: true,
    },
  },
  cwd: "/tmp/workspace",
  keybindingsConfigPath: "/tmp/workspace/keybindings.json",
  keybindings: [],
  issues: [],
  providers: [],
  availableEditors: [],
  observability: {
    logsDirectoryPath: "/tmp/logs",
    localTracingEnabled: false,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
  },
  settings: DEFAULT_SERVER_SETTINGS,
};

const RpcRequest = Schema.TaggedStruct("Request", {
  headers: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
  id: Schema.String,
  payload: Schema.Unknown,
  sampled: Schema.optional(Schema.Boolean),
  spanId: Schema.optional(Schema.String),
  tag: Schema.String,
  traceId: Schema.optional(Schema.String),
});
const decodeJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);
const decodeRpcRequest = Schema.decodeUnknownSync(RpcRequest);
const encodeJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);
const encodeServerConfig = Schema.encodeSync(ServerConfig);
const encodeWsServerConfig = Schema.encodeSync(WsServerGetConfigRpc.successSchema);
const encodeWsServerConfigError = Schema.encodeSync(WsServerGetConfigRpc.errorSchema);
const encodeWsServerGetConfigPayload = Schema.encodeSync(WsServerGetConfigRpc.payloadSchema);
const encodeTerminalEvent = Schema.encodeSync(TerminalEvent);

const decodeFrame = (frame: string): unknown => decodeJson(frame);

const frameTag = (frame: unknown): string | undefined =>
  typeof frame === "object" && frame !== null && "_tag" in frame && typeof frame._tag === "string"
    ? frame._tag
    : undefined;

const makeFactory = Effect.fn("TestRpcSessionFactory.make")(function* () {
  const sockets: TestWebSocket[] = [];
  const constructorLayer = Layer.succeed(Socket.WebSocketConstructor, (url) => {
    const socket = new TestWebSocket(url);
    sockets.push(socket);
    return socket as unknown as globalThis.WebSocket;
  });
  const layer = RpcSession.layer.pipe(Layer.provide(constructorLayer));
  const factory = yield* RpcSession.RpcSessionFactory.pipe(Effect.provide(layer));
  return { factory, sockets };
});

const awaitSocket = Effect.fn("TestRpcSessionFactory.awaitSocket")(function* (
  sockets: ReadonlyArray<TestWebSocket>,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const socket = sockets[0];
    if (socket) {
      return socket;
    }
    yield* Effect.yieldNow;
  }
  return yield* Effect.die(new Error("Expected the RPC protocol to create a websocket."));
});

const awaitRequest = Effect.fn("TestRpcSessionFactory.awaitRequest")(function* (
  socket: TestWebSocket,
  previousId?: string,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const frame = [...socket.sent]
      .toReversed()
      .find((frame) => frameTag(decodeFrame(frame)) === "Request");
    if (frame) {
      const request = decodeRpcRequest(decodeJson(frame));
      if (request.id !== previousId) {
        return request;
      }
    }
    yield* Effect.yieldNow;
  }
  return yield* Effect.die(new Error("Expected the RPC protocol to send a request."));
});

const awaitFrame = Effect.fn("TestRpcSessionFactory.awaitFrame")(function* (
  socket: TestWebSocket,
  tag: string,
  occurrence = 1,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const frame = socket.sent.map(decodeFrame).filter((candidate) => frameTag(candidate) === tag)[
      occurrence - 1
    ];
    if (frame) {
      return frame;
    }
    yield* Effect.yieldNow;
  }
  return yield* Effect.die(
    new Error(`Expected the RPC protocol to send a ${tag} frame; sent ${encodeJson(socket.sent)}.`),
  );
});

const completeInitialConfig = Effect.fn("TestRpcSessionFactory.completeInitialConfig")(function* (
  socket: TestWebSocket,
) {
  const request = yield* awaitRequest(socket);
  expect(request).toMatchObject({
    _tag: "Request",
    tag: WS_METHODS.serverGetConfig,
    payload: {},
  });
  socket.serverMessage(
    encodeJson({
      _tag: "Exit",
      requestId: request.id,
      exit: {
        _tag: "Success",
        value: encodeServerConfig(SERVER_CONFIG),
      },
    }),
  );
});

describe("RpcSessionFactory", () => {
  it("encodes the WsRpcGroup socket protocol in each message direction", () => {
    const parser = RpcSerialization.json.makeUnsafe();
    const encodedConfig = encodeWsServerConfig(SERVER_CONFIG);
    const encodedConfigError = encodeWsServerConfigError(
      new KeybindingsConfigError({
        configPath: "/tmp/keybindings.json",
        detail: "invalid JSON",
      }),
    );
    const encodedTerminalEvent = encodeTerminalEvent({
      type: "output",
      threadId: "thread-1",
      terminalId: "term-1",
      data: "hello",
    });
    const clientFrames = [
      {
        _tag: "Request",
        id: "42",
        tag: WS_METHODS.serverGetConfig,
        payload: encodeWsServerGetConfigPayload({}),
        headers: [["x-neokod-contract", "codec"]],
      },
      { _tag: "Ping" },
      { _tag: "Ack", requestId: "42" },
      { _tag: "Interrupt", requestId: "42" },
    ] satisfies ReadonlyArray<Exclude<RpcMessage.FromClientEncoded, RpcMessage.Eof>>;
    const serverFrames = [
      { _tag: "Pong" },
      { _tag: "Chunk", requestId: "42", values: [encodedTerminalEvent] },
      { _tag: "Exit", requestId: "42", exit: { _tag: "Success", value: encodedConfig } },
      {
        _tag: "Exit",
        requestId: "42",
        exit: {
          _tag: "Failure",
          cause: [
            {
              _tag: "Fail",
              error: encodedConfigError,
            },
          ],
        },
      },
      { _tag: "Defect", defect: { message: "connection lost" } },
    ] satisfies ReadonlyArray<RpcMessage.FromServerEncoded>;

    expect(WsRpcGroup.requests.get(WS_METHODS.serverGetConfig)).toBe(WsServerGetConfigRpc);
    expect(WsRpcGroup.requests.get(WS_METHODS.subscribeTerminalEvents)).toBe(
      WsSubscribeTerminalEventsRpc,
    );

    for (const frame of [...clientFrames, ...serverFrames]) {
      const encoded = parser.encode(frame);
      expect(typeof encoded).toBe("string");
      expect(JSON.parse(encoded as string)).toEqual(frame);
      expect(parser.decode(encoded as string)).toEqual([frame]);
    }
    expect(() => parser.decode("{")).toThrow();
  });

  it.effect("owns one scoped websocket attempt and exposes readiness and closure", () =>
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();
      const session = yield* factory.connect(PREPARED);
      const readyFiber = yield* Effect.forkChild(session.ready);
      const socket = yield* awaitSocket(sockets);

      expect(socket.url).toBe(PREPARED.socketUrl);
      socket.open();
      yield* completeInitialConfig(socket);
      yield* Fiber.join(readyFiber);

      const config = yield* session.initialConfig;
      expect(config).toEqual(SERVER_CONFIG);
      expect(socket.sent).toHaveLength(1);

      socket.close(1012, "service restart");
      const error = yield* Effect.flip(session.closed);

      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error).toMatchObject({
        reason: "transport",
        message: "Test environment disconnected.",
      });
      yield* Effect.yieldNow;
      expect(sockets).toHaveLength(1);
    }),
  );

  it.effect("closes the websocket when the session scope is released", () =>
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* factory.connect(PREPARED);
          const readyFiber = yield* Effect.forkChild(session.ready);
          const socket = yield* awaitSocket(sockets);
          socket.open();
          yield* completeInitialConfig(socket);
          yield* Fiber.join(readyFiber);
        }),
      );

      expect(sockets[0]?.readyState).toBe(TestWebSocket.CLOSED);
    }),
  );

  it.effect("fails readiness when the websocket never opens", () =>
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();

      const error = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* factory.connect(PREPARED);
          const readyFiber = yield* Effect.forkChild(Effect.flip(session.ready));
          yield* awaitSocket(sockets);

          yield* TestClock.adjust("15 seconds");
          return yield* Fiber.join(readyFiber);
        }),
      );

      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error).toMatchObject({
        reason: "transport",
        message: "Test environment could not establish a WebSocket connection.",
      });
      expect(sockets[0]?.readyState).toBe(TestWebSocket.CLOSED);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("encodes client request tags, payloads, and headers through the live socket", () =>
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();
      const session = yield* factory.connect(PREPARED);
      const socket = yield* awaitSocket(sockets);
      socket.open();

      const resultFiber = yield* session.client[WS_METHODS.serverGetConfig](
        {},
        { headers: { "x-neokod-contract": "codec" } },
      ).pipe(Effect.forkChild);
      const request = yield* awaitRequest(socket);

      expect(request).toEqual({
        _tag: "Request",
        id: request.id,
        tag: WS_METHODS.serverGetConfig,
        payload: {},
        headers: [["x-neokod-contract", "codec"]],
        traceId: expect.any(String),
        spanId: expect.any(String),
        sampled: expect.any(Boolean),
      });
      socket.serverMessage(
        encodeJson({
          _tag: "Exit",
          requestId: request.id,
          exit: { _tag: "Success", value: encodeServerConfig(SERVER_CONFIG) },
        }),
      );

      expect(yield* Fiber.join(resultFiber)).toEqual(SERVER_CONFIG);
    }),
  );

  it.effect(
    "decodes streamed chunks, acknowledges them, and sends interrupts on cancellation",
    () =>
      Effect.gen(function* () {
        const { factory, sockets } = yield* makeFactory();
        const session = yield* factory.connect(PREPARED);
        const socket = yield* awaitSocket(sockets);
        socket.open();
        const received: unknown[] = [];
        const streamFiber = yield* session.client[WS_METHODS.subscribeTerminalEvents]({}).pipe(
          Stream.runForEach((event) => Effect.sync(() => received.push(event))),
          Effect.forkChild,
        );
        const request = yield* awaitRequest(socket);

        expect(request).toMatchObject({
          _tag: "Request",
          tag: WS_METHODS.subscribeTerminalEvents,
          payload: {},
        });
        socket.serverMessage(
          encodeJson({
            _tag: "Chunk",
            requestId: request.id,
            values: [{ type: "output", threadId: "thread-1", terminalId: "term-1", data: "hello" }],
          }),
        );

        const ack = yield* awaitFrame(socket, "Ack");
        expect(ack).toEqual({ _tag: "Ack", requestId: request.id });
        expect(socket.sent).toContain(encodeJson(ack));
        socket.serverMessage(
          encodeJson({
            _tag: "Exit",
            requestId: request.id,
            exit: { _tag: "Success", value: null },
          }),
        );
        yield* Fiber.join(streamFiber);
        expect(received).toEqual([
          { type: "output", threadId: "thread-1", terminalId: "term-1", data: "hello" },
        ]);

        const cancelledRequest = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* session.client[WS_METHODS.subscribeTerminalEvents]({}).pipe(
              Stream.runDrain,
              Effect.forkScoped,
            );
            return yield* awaitRequest(socket, request.id);
          }),
        );

        const interrupt = yield* awaitFrame(socket, "Interrupt");
        expect(interrupt).toEqual({ _tag: "Interrupt", requestId: cancelledRequest.id });
        expect(socket.sent).toContain(encodeJson(interrupt));
      }),
  );

  it.effect("sends Ping and accepts Pong on the live socket", () =>
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();
      yield* factory.connect(PREPARED);
      const socket = yield* awaitSocket(sockets);
      socket.open();

      yield* TestClock.adjust("5 seconds");
      const ping = yield* awaitFrame(socket, "Ping");
      expect(ping).toEqual({ _tag: "Ping" });
      expect(socket.sent).toContain(encodeJson(ping));
      socket.serverMessage(encodeJson({ _tag: "Pong" }));

      yield* TestClock.adjust("5 seconds");
      expect(yield* awaitFrame(socket, "Ping", 2)).toEqual({ _tag: "Ping" });
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("decodes typed failure exits and rejects malformed socket frames", () =>
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();
      const session = yield* factory.connect(PREPARED);
      const socket = yield* awaitSocket(sockets);
      socket.open();
      const failureFiber = yield* session.client[WS_METHODS.serverGetConfig]({}).pipe(
        Effect.flip,
        Effect.forkChild,
      );
      const request = yield* awaitRequest(socket);
      socket.serverMessage(
        encodeJson({
          _tag: "Exit",
          requestId: request.id,
          exit: {
            _tag: "Failure",
            cause: [
              {
                _tag: "Fail",
                error: {
                  _tag: "KeybindingsConfigParseError",
                  configPath: "/tmp/keybindings.json",
                  detail: "invalid JSON",
                },
              },
            ],
          },
        }),
      );

      expect(yield* Fiber.join(failureFiber)).toMatchObject({
        _tag: "KeybindingsConfigParseError",
        configPath: "/tmp/keybindings.json",
        detail: "invalid JSON",
      });

      const malformedFiber = yield* session.client[WS_METHODS.serverGetConfig]({}).pipe(
        Effect.flip,
        Effect.forkChild,
      );
      yield* awaitRequest(socket, request.id);
      socket.serverMessage("{");
      expect(yield* Fiber.join(malformedFiber)).toMatchObject({ _tag: "RpcClientError" });
    }),
  );

  it.effect("ignores unknown inbound envelopes and continues live RPCs", () =>
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();
      const session = yield* factory.connect(PREPARED);
      const socket = yield* awaitSocket(sockets);
      socket.open();

      const requestFiber = yield* session.client[WS_METHODS.serverGetConfig]({}).pipe(
        Effect.forkChild,
      );
      const request = yield* awaitRequest(socket);
      // Stage 2's MSW mock treats unknown traffic as fatal; the production client stays forward-compatible.
      socket.serverMessage(encodeJson({ _tag: "NotAThing", requestId: request.id }));
      yield* Effect.yieldNow;
      expect(requestFiber.pollUnsafe()).toBeUndefined();
      expect(socket.readyState).toBe(TestWebSocket.OPEN);

      socket.serverMessage(
        encodeJson({
          _tag: "Exit",
          requestId: request.id,
          exit: { _tag: "Success", value: encodeServerConfig(SERVER_CONFIG) },
        }),
      );
      expect(yield* Fiber.join(requestFiber)).toEqual(SERVER_CONFIG);

      const probeFiber = yield* session.probe.pipe(Effect.forkChild);
      const probeRequest = yield* awaitRequest(socket, request.id);
      socket.serverMessage(
        encodeJson({
          _tag: "Exit",
          requestId: probeRequest.id,
          exit: { _tag: "Success", value: encodeServerConfig(SERVER_CONFIG) },
        }),
      );
      yield* Fiber.join(probeFiber);
    }),
  );
});
