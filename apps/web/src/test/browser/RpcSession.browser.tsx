import { WS_METHODS, type TerminalEvent } from "@neokod/contracts";
import { rpcSessionLayer, RpcSessionFactory } from "@neokod/client-runtime/rpc";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Socket from "effect/unstable/socket/Socket";
import { useEffect, useState } from "react";

import { browserConnectionFixture, browserTerminalOutputFixture } from "./fixtures";
import { createMockEnvironmentServer } from "./mockEnvironmentServer";
import { renderBrowserHarness } from "./render";
import { resetBrowserAppHarness } from "./reset";

const environmentServer = createMockEnvironmentServer();
const browserRpcSessionLayer = rpcSessionLayer.pipe(
  Layer.provide(Socket.layerWebSocketConstructorGlobal),
);
function RpcSessionSurface({
  onRuntimeDispose,
}: {
  readonly onRuntimeDispose: (dispose: () => Promise<void>) => void;
}) {
  const [environmentLabel, setEnvironmentLabel] = useState<string | null>(null);
  const [terminalLines, setTerminalLines] = useState<string[]>([]);

  useEffect(() => {
    const fiber = Effect.runFork(
      Effect.scoped(
        Effect.gen(function* () {
          const factory = yield* RpcSessionFactory;
          const session = yield* factory.connect(browserConnectionFixture);
          const config = yield* session.initialConfig;
          yield* Effect.sync(() => setEnvironmentLabel(config.environment.label));
          yield* session.client[WS_METHODS.subscribeTerminalEvents]({}).pipe(
            Stream.runForEach((event: TerminalEvent) =>
              Effect.sync(() => {
                if (event.type === "output") {
                  setTerminalLines((lines) => [...lines, event.data]);
                }
              }),
            ),
          );
        }),
      ).pipe(Effect.provide(browserRpcSessionLayer)),
    );

    let disposePromise: Promise<void> | undefined;
    const dispose = () => (disposePromise ??= Effect.runPromise(Fiber.interrupt(fiber)));
    onRuntimeDispose(dispose);

    return () => {
      void dispose();
    };
  }, [onRuntimeDispose]);

  return (
    <section aria-label="RPC session">
      <p role="status" aria-label="connection status">
        {environmentLabel ? `${environmentLabel} connected` : "Connecting"}
      </p>
      <output aria-label="Terminal output">{terminalLines.join("\n")}</output>
    </section>
  );
}

describe("RpcSession browser harness", () => {
  let mounted: Awaited<ReturnType<typeof renderBrowserHarness>> | undefined;
  let disposeRuntime: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    await environmentServer.start();
  });

  afterEach(async () => {
    await resetBrowserAppHarness({
      server: environmentServer,
      ...(disposeRuntime ? { disposeRuntime } : {}),
      ...(mounted ? { unmount: mounted.unmount } : {}),
    });
    environmentServer.reset();
    disposeRuntime = undefined;
    mounted = undefined;
  });

  afterAll(async () => {
    await environmentServer.stop();
  });

  it("renders a codec-encoded terminal event from the real client runtime", async () => {
    mounted = await renderBrowserHarness(
      <RpcSessionSurface onRuntimeDispose={(dispose) => (disposeRuntime = dispose)} />,
    );

    const status = page.getByRole("status", { name: "connection status" });
    await expect.element(status).toBeVisible();
    await expect.element(status).toHaveTextContent("Browser environment connected");
    await environmentServer.waitForSubscription(WS_METHODS.subscribeTerminalEvents);
    environmentServer.emitTerminal(browserTerminalOutputFixture);

    await expect
      .element(page.getByLabelText("Terminal output"))
      .toHaveTextContent("browser RPC round-trip");
    expect(environmentServer.state.requests.map((request) => request.tag)).toEqual([
      WS_METHODS.serverGetConfig,
      WS_METHODS.subscribeTerminalEvents,
    ]);
  });
});
