import {
  ORCHESTRATION_WS_METHODS,
  OrchestrationThreadStreamItem,
  TerminalEvent,
  WS_METHODS,
  WsOrchestrationDispatchCommandRpc,
  WsOrchestrationSubscribeThreadRpc,
  WsRpcGroup,
  WsServerGetConfigRpc,
  WsSubscribeTerminalEventsRpc,
  type ClientOrchestrationCommand,
  type ServerConfig,
} from "@neokod/contracts";
import * as Schema from "effect/Schema";
import { setupWorker } from "msw/browser";
import { ws } from "msw";

import { browserServerConfigFixture, browserThreadEventFixtures, BROWSER_WS_URL } from "./fixtures";
import {
  decodeEffectRpcClientFrames,
  sendEffectRpcChunk,
  sendEffectRpcExit,
  sendEffectRpcServerFrame,
  type EffectRpcWebSocketClient,
} from "./effectRpcWebSocketMock";

type Subscription = {
  readonly client: EffectRpcWebSocketClient;
  readonly id: string;
  readonly tag: string;
};

export interface MockEnvironmentServer {
  readonly state: {
    readonly approvalCommands: ClientOrchestrationCommand[];
    readonly inputCommands: ClientOrchestrationCommand[];
    readonly requests: ReadonlyArray<{ readonly id: string; readonly tag: string }>;
    readonly subscriptions: ReadonlyArray<{ readonly id: string; readonly tag: string }>;
  };
  acceptReconnect(): void;
  assertNoLeaks(): Promise<void>;
  closeClients(): void;
  disconnect(): void;
  emitTerminal(event: TerminalEvent): void;
  emitThread(event: OrchestrationThreadStreamItem): void;
  exitSubscriptions(tag: string): void;
  reset(): void;
  setConfig(config: ServerConfig): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  waitForSubscription(tag: string): Promise<void>;
}

const decodeGetConfig = Schema.decodeUnknownSync(WsServerGetConfigRpc.payloadSchema);
const encodeGetConfig = Schema.encodeSync(WsServerGetConfigRpc.successSchema);
const decodeTerminalSubscription = Schema.decodeUnknownSync(
  WsSubscribeTerminalEventsRpc.payloadSchema,
);
const encodeTerminalEvent = Schema.encodeSync(TerminalEvent);
const decodeThreadSubscription = Schema.decodeUnknownSync(
  WsOrchestrationSubscribeThreadRpc.payloadSchema,
);
const encodeThreadEvent = Schema.encodeSync(OrchestrationThreadStreamItem);
const decodeCommand = Schema.decodeUnknownSync(WsOrchestrationDispatchCommandRpc.payloadSchema);
const encodeCommandResult = Schema.encodeSync(WsOrchestrationDispatchCommandRpc.successSchema);

export function createMockEnvironmentServer(
  input: { readonly initialConfig?: ServerConfig } = {},
): MockEnvironmentServer {
  if (WsRpcGroup.requests.get(WS_METHODS.serverGetConfig) !== WsServerGetConfigRpc) {
    throw new Error("WsRpcGroup no longer exposes server.getConfig through its real RPC codec.");
  }

  const link = ws.link(BROWSER_WS_URL);
  const clients = new Set<EffectRpcWebSocketClient>();
  const subscriptions = new Map<string, Subscription>();
  const subscriptionWaiters = new Map<string, Set<() => void>>();
  const requests: Array<{ readonly id: string; readonly tag: string }> = [];
  const approvalCommands: ClientOrchestrationCommand[] = [];
  const inputCommands: ClientOrchestrationCommand[] = [];
  let config = input.initialConfig ?? browserServerConfigFixture;
  let fatalError: Error | undefined;
  let acceptingReconnect = true;
  const clientCloseWaiters = new Set<() => void>();

  const fail = (message: string, cause?: unknown): never => {
    const error = new Error(message, cause === undefined ? undefined : { cause });
    fatalError ??= error;
    throw error;
  };

  const emit = <Value>(tag: string, value: Value, encode: (value: Value) => unknown) => {
    for (const subscription of subscriptions.values()) {
      if (subscription.tag === tag) {
        sendEffectRpcChunk(subscription.client, subscription.id, encode(value));
      }
    }
  };

  const removeClient = (client: EffectRpcWebSocketClient) => {
    clients.delete(client);
    for (const [id, subscription] of subscriptions) {
      if (subscription.client === client) subscriptions.delete(id);
    }
    if (clients.size === 0) {
      for (const resolve of clientCloseWaiters) resolve();
      clientCloseWaiters.clear();
    }
  };

  const leakError = () =>
    new Error(
      `Mock environment leaked ${clients.size} WebSocket client(s) and ${subscriptions.size} RPC subscription(s).`,
    );

  const waitForClientsToClose = () => {
    if (clients.size === 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const onClose = () => {
        window.clearTimeout(timeout);
        resolve();
      };
      const timeout = window.setTimeout(() => {
        clientCloseWaiters.delete(onClose);
        reject(leakError());
      }, 1_000);
      clientCloseWaiters.add(onClose);
    });
  };

  const handleRequest = (
    client: EffectRpcWebSocketClient,
    frame: {
      readonly id: string;
      readonly payload: unknown;
      readonly tag: string;
    },
  ) => {
    requests.push({ id: frame.id, tag: frame.tag });
    if (!WsRpcGroup.requests.has(frame.tag)) {
      return fail(`Unhandled WsRpcGroup request tag: ${frame.tag}`);
    }
    switch (frame.tag) {
      case WS_METHODS.serverGetConfig:
        decodeGetConfig(frame.payload);
        sendEffectRpcExit(client, frame.id, encodeGetConfig(config));
        return;
      case WS_METHODS.subscribeTerminalEvents:
        decodeTerminalSubscription(frame.payload);
        subscriptions.set(frame.id, { client, id: frame.id, tag: frame.tag });
        subscriptionWaiters.get(frame.tag)?.forEach((resolve) => resolve());
        subscriptionWaiters.delete(frame.tag);
        return;
      case ORCHESTRATION_WS_METHODS.subscribeThread:
        decodeThreadSubscription(frame.payload);
        subscriptions.set(frame.id, { client, id: frame.id, tag: frame.tag });
        subscriptionWaiters.get(frame.tag)?.forEach((resolve) => resolve());
        subscriptionWaiters.delete(frame.tag);
        for (const event of browserThreadEventFixtures) {
          sendEffectRpcChunk(client, frame.id, encodeThreadEvent(event));
        }
        return;
      case ORCHESTRATION_WS_METHODS.dispatchCommand: {
        const command = decodeCommand(frame.payload);
        if (command.type === "thread.approval.respond") approvalCommands.push(command);
        if (command.type === "thread.user-input.respond") inputCommands.push(command);
        sendEffectRpcExit(client, frame.id, encodeCommandResult({ sequence: requests.length }));
        return;
      }
      default:
        return fail(`Unhandled WsRpcGroup request tag: ${frame.tag}`);
    }
  };

  const worker = setupWorker(
    link.addEventListener("connection", ({ client }) => {
      const socket = client as unknown as EffectRpcWebSocketClient;
      if (!acceptingReconnect) {
        socket.close(1013, "reconnect not accepted");
        return;
      }
      clients.add(socket);
      socket.addEventListener("close", () => removeClient(socket));
      socket.addEventListener("message", (event) => {
        try {
          if (!("data" in event)) {
            return fail("Effect RPC client sent a non-message WebSocket frame.");
          }
          const data = (event as MessageEvent<unknown>).data;
          if (typeof data !== "string") {
            return fail("Effect RPC client sent a non-string WebSocket frame.");
          }
          for (const frame of decodeEffectRpcClientFrames(data)) {
            switch (frame._tag) {
              case "Ping":
                sendEffectRpcServerFrame(socket, { _tag: "Pong" });
                break;
              case "Request":
                handleRequest(socket, frame);
                break;
              case "Ack":
                break;
              case "Interrupt":
                subscriptions.delete(frame.requestId);
                break;
              case "Eof":
                subscriptions.clear();
                break;
              default:
                fail(`Unhandled Effect RPC client frame: ${(frame as { _tag: string })._tag}`);
            }
          }
        } catch (cause) {
          fail("Malformed or unknown Effect RPC client traffic.", cause);
        }
      });
    }),
  );

  return {
    state: {
      approvalCommands,
      inputCommands,
      requests,
      get subscriptions() {
        return [...subscriptions.values()].map(({ id, tag }) => ({ id, tag }));
      },
    },
    acceptReconnect() {
      acceptingReconnect = true;
    },
    async assertNoLeaks() {
      if (fatalError) throw fatalError;
      await waitForClientsToClose();
      if (fatalError) throw fatalError;
      if (clients.size !== 0 || subscriptions.size !== 0) {
        throw leakError();
      }
    },
    closeClients() {
      for (const client of Array.from(clients)) client.close(1000, "browser test teardown");
      subscriptionWaiters.clear();
    },
    disconnect() {
      acceptingReconnect = false;
      for (const client of Array.from(clients)) client.close(1012, "test disconnect");
    },
    emitTerminal(event) {
      emit(WS_METHODS.subscribeTerminalEvents, event, encodeTerminalEvent);
    },
    emitThread(event) {
      emit(ORCHESTRATION_WS_METHODS.subscribeThread, event, encodeThreadEvent);
    },
    exitSubscriptions(tag) {
      for (const [id, subscription] of subscriptions) {
        if (subscription.tag === tag) {
          sendEffectRpcExit(subscription.client, id);
          subscriptions.delete(id);
        }
      }
    },
    reset() {
      config = input.initialConfig ?? browserServerConfigFixture;
      requests.splice(0);
      approvalCommands.splice(0);
      inputCommands.splice(0);
      subscriptionWaiters.clear();
      fatalError = undefined;
      acceptingReconnect = true;
    },
    setConfig(nextConfig) {
      config = nextConfig;
    },
    async start() {
      await worker.start({
        onUnhandledRequest: "error",
        quiet: true,
        serviceWorker: { url: "/mockServiceWorker.js" },
      });
    },
    async stop() {
      try {
        await this.assertNoLeaks();
      } finally {
        this.closeClients();
        worker.resetHandlers();
        await worker.stop();
      }
    },
    waitForSubscription(tag) {
      if ([...subscriptions.values()].some((subscription) => subscription.tag === tag)) {
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        const waiters = subscriptionWaiters.get(tag) ?? new Set<() => void>();
        waiters.add(resolve);
        subscriptionWaiters.set(tag, waiters);
      });
    },
  };
}
