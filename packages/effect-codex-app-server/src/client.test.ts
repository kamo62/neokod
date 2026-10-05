import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";

import * as CodexClient from "./client.ts";
import { makeInMemoryStdio } from "./_internal/stdio.ts";

const encoder = new TextEncoder();
const encodeJsonLine = Schema.encodeSync(Schema.UnknownFromJsonString);
const decodeJsonLine = Schema.decodeEffect(Schema.UnknownFromJsonString);
const encodeJsonl = (value: unknown) => encoder.encode(`${encodeJsonLine(value)}\n`);

const mockPeerPath = Effect.map(Effect.service(Path.Path), (path) =>
  path.join(import.meta.dirname, "../test/fixtures/codex-app-server-mock-peer.ts"),
);
const mockPeerArgs = (path: string) => [path];

it.layer(NodeServices.layer)("effect-codex-app-server client", (it) => {
  const makeHandle = (env?: Record<string, string>) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const peerCwd = path.join(import.meta.dirname, "..");
      const command = ChildProcess.make(process.execPath, mockPeerArgs(yield* mockPeerPath), {
        cwd: peerCwd,
        ...(env ? { env: { ...process.env, ...env } } : {}),
      });
      return yield* spawner.spawn(command);
    });

  it.effect("initializes, handles typed server requests, and reads account and skills data", () =>
    Effect.gen(function* () {
      const userInputRequests = yield* Ref.make<Array<unknown>>([]);
      const messageDeltas = yield* Ref.make<Array<unknown>>([]);
      const handle = yield* makeHandle();
      const scope = yield* Scope.make();
      const clientLayer = CodexClient.layerChildProcess(handle);
      const context = yield* Layer.buildWithScope(clientLayer, scope);

      const result = yield* Effect.gen(function* () {
        const client = yield* CodexClient.CodexAppServerClient;

        yield* client.handleServerRequest("item/tool/requestUserInput", (payload) =>
          Ref.update(userInputRequests, (current) => [...current, payload]).pipe(
            Effect.as({
              answers: {
                approved: {
                  answers: ["yes"],
                },
              },
            }),
          ),
        );

        yield* client.handleServerNotification("item/agentMessage/delta", (payload) =>
          Ref.update(messageDeltas, (current) => [...current, payload]),
        );

        const initialized = yield* client.request("initialize", {
          clientInfo: {
            name: "effect-codex-app-server-test",
            title: "Effect Codex App Server Test",
            version: "0.0.0",
          },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: null,
          },
        });
        assert.equal(initialized.userAgent, "mock-codex-app-server");

        yield* client.notify("initialized", undefined);

        const account = yield* client.request("account/read", {});
        assert.equal(account.requiresOpenaiAuth, false);
        assert.deepEqual(account.account, {
          type: "chatgpt",
          email: "mock@example.com",
          planType: "plus",
        });

        const path = yield* Path.Path;
        const peerCwd = path.join(import.meta.dirname, "..");
        const skills = yield* client.request("skills/list", { cwds: [peerCwd] });
        assert.equal(skills.data.length, 1);
        assert.equal(skills.data[0]?.cwd, peerCwd);

        return {
          account,
          skills,
        };
      }).pipe(Effect.provide(context), Effect.ensuring(Scope.close(scope, Exit.void)));

      assert.equal(result.skills.data[0]?.skills.length, 0);
      assert.deepEqual(yield* Ref.get(userInputRequests), [
        {
          itemId: "item-approval-1",
          threadId: "thread-1",
          turnId: "turn-1",
          questions: [
            {
              id: "approved",
              header: "Approve",
              question: "Continue with the mock skills request?",
              options: [
                {
                  label: "yes",
                  description: "Approve the request",
                },
              ],
            },
          ],
        },
      ]);
      assert.deepEqual(yield* Ref.get(messageDeltas), [
        {
          delta: "Mock server is ready.",
          itemId: "item-1",
          threadId: "thread-1",
          turnId: "turn-1",
        },
      ]);
    }),
  );
  it.effect("drains child stderr so large diagnostics cannot block protocol responses", () =>
    Effect.gen(function* () {
      const handle = yield* makeHandle({
        CODEX_APP_SERVER_TEST_STDERR_BYTES: String(512 * 1024),
      });
      const scope = yield* Scope.make();
      const clientLayer = CodexClient.layerChildProcess(handle);
      const context = yield* Layer.buildWithScope(clientLayer, scope);

      const initialized = yield* Effect.gen(function* () {
        const client = yield* CodexClient.CodexAppServerClient;
        return yield* client.request("initialize", {
          clientInfo: {
            name: "effect-codex-app-server-test",
            title: "Effect Codex App Server Test",
            version: "0.0.0",
          },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: null,
          },
        });
      }).pipe(
        Effect.timeout("5 seconds"),
        Effect.provide(context),
        Effect.ensuring(Scope.close(scope, Exit.void)),
      );

      assert.equal(initialized.userAgent, "mock-codex-app-server");
    }),
  );

  it.effect("typed-only sessions retain no raw history", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { stdio, input } = yield* makeInMemoryStdio();
        const client = yield* CodexClient.make(stdio);
        const seen = yield* Deferred.make<void>();
        yield* client.handleServerNotification("item/agentMessage/delta", () =>
          Deferred.succeed(seen, undefined).pipe(Effect.asVoid),
        );
        const delta = { delta: "x", itemId: "i-1", threadId: "t-1", turnId: "u-1" };
        yield* Queue.offer(
          input,
          encodeJsonl({ method: "item/agentMessage/delta", params: delta }),
        );
        yield* Queue.offer(
          input,
          encodeJsonl({ method: "item/agentMessage/delta", params: delta }),
        );
        yield* Queue.offer(
          input,
          encodeJsonl({ method: "item/agentMessage/delta", params: delta }),
        );
        yield* Deferred.await(seen);
        const notificationsFiber = yield* Stream.runCollect(client.raw.notifications).pipe(
          Effect.forkScoped,
        );
        const requestsFiber = yield* Stream.runCollect(client.raw.requests).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        assert.isDefined(notificationsFiber.pollUnsafe());
        assert.isDefined(requestsFiber.pollUnsafe());
      }),
    ),
  );

  it.effect("raw mode does not auto-reply and a raw consumer can answer an approval", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { stdio, input, output } = yield* makeInMemoryStdio();
        const client = yield* CodexClient.make(stdio, { rawStreams: true });
        const requestFiber = yield* Stream.runHead(client.raw.requests).pipe(Effect.forkScoped);
        yield* Queue.offer(
          input,
          encodeJsonl({
            id: 0,
            method: "item/commandExecution/requestApproval",
            params: { threadId: "t-1", turnId: "u-1", itemId: "i-1", command: "echo hi" },
          }),
        );
        const head = yield* Fiber.join(requestFiber);
        assert.isTrue(Option.isSome(head));
        if (Option.isNone(head)) return;
        yield* client.raw.respond(head.value.id, { decision: "accept" });
        const line = yield* Queue.take(output);
        const decoded = yield* decodeJsonLine(line);
        assert.deepStrictEqual(decoded, { id: 0, result: { decision: "accept" } });
        assert.strictEqual(yield* Queue.size(output), 0);
      }),
    ),
  );

  it.effect("raw mode rejects typed handler registration", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { stdio } = yield* makeInMemoryStdio();
        const client = yield* CodexClient.make(stdio, { rawStreams: true });
        const exit = yield* Effect.exit(
          client.handleServerRequest("item/tool/requestUserInput", () =>
            Effect.succeed({ answers: {} }),
          ),
        );
        assert.strictEqual(Exit.isFailure(exit), true);
      }),
    ),
  );
});
