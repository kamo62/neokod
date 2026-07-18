import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { beforeEach, vi } from "vite-plus/test";

const { handleMock, netFetchMock, registerSchemesAsPrivilegedMock, unhandleMock } = vi.hoisted(
  () => ({
    handleMock: vi.fn(),
    netFetchMock: vi.fn(),
    registerSchemesAsPrivilegedMock: vi.fn(),
    unhandleMock: vi.fn(),
  }),
);

vi.mock("electron", () => ({
  net: { fetch: netFetchMock },
  protocol: {
    handle: handleMock,
    registerSchemesAsPrivileged: registerSchemesAsPrivilegedMock,
    unhandle: unhandleMock,
  },
}));

import * as ElectronProtocol from "./ElectronProtocol.ts";

describe("ElectronProtocol", () => {
  beforeEach(() => {
    handleMock.mockReset();
    netFetchMock.mockReset();
    registerSchemesAsPrivilegedMock.mockReset();
    unhandleMock.mockReset();
  });

  it("registers standard scheme privileges for both desktop schemes", () => {
    ElectronProtocol.registerDesktopSchemePrivileges();

    assert.deepEqual(registerSchemesAsPrivilegedMock.mock.calls, [
      [
        [
          {
            scheme: "neokod",
            privileges: {
              standard: true,
              secure: true,
              supportFetchAPI: true,
              corsEnabled: true,
              stream: true,
            },
          },
          {
            scheme: "neokod-dev",
            privileges: {
              standard: true,
              secure: true,
              supportFetchAPI: true,
              corsEnabled: true,
              stream: true,
            },
          },
        ],
      ],
    ]);
  });

  it.effect("proxies the stable renderer origin to the current app server", () =>
    Effect.gen(function* () {
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });
      netFetchMock.mockResolvedValue(new Response("ok"));

      yield* Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* ElectronProtocol.ElectronProtocol;
          yield* protocol.registerDesktopProtocol({
            scheme: "neokod-dev",
            targetOrigin: new URL("http://127.0.0.1:3773/"),
            backendOrigin: new URL("http://127.0.0.1:3774/"),
          });
          assert.isDefined(handler);

          const response = yield* Effect.promise(() =>
            handler!(
              new Request("neokod-dev://app/api/health?verbose=1", {
                headers: {
                  accept: "application/json",
                  origin: "neokod-dev://app",
                  referer: "neokod-dev://app/",
                  "sec-fetch-site": "same-origin",
                },
              }),
            ),
          );
          assert.equal(yield* Effect.promise(() => response.text()), "ok");
          assert.include(
            response.headers.get("content-security-policy") ?? "",
            "script-src 'self' 'unsafe-inline'",
          );
          assert.include(
            response.headers.get("content-security-policy") ?? "",
            "connect-src 'self' http://127.0.0.1:3773 http://127.0.0.1:3774 http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:*",
          );
          assert.include(
            response.headers.get("content-security-policy") ?? "",
            "img-src 'self' neokod-dev: blob: data: http://127.0.0.1:3773 http://127.0.0.1:3774",
          );
          assert.include(
            response.headers.get("content-security-policy") ?? "",
            "font-src 'self' neokod-dev: data:",
          );
        }),
      );

      assert.deepEqual(
        handleMock.mock.calls.map((call) => call[0]),
        ["neokod-dev"],
      );
      assert.equal(netFetchMock.mock.calls[0]?.[0], "http://127.0.0.1:3773/api/health?verbose=1");
      const forwardedHeaders = new Headers(netFetchMock.mock.calls[0]?.[1]?.headers);
      assert.equal(forwardedHeaders.get("accept"), "application/json");
      assert.isNull(forwardedHeaders.get("origin"));
      assert.isNull(forwardedHeaders.get("referer"));
      assert.isNull(forwardedHeaders.get("sec-fetch-site"));
      assert.deepEqual(unhandleMock.mock.calls, [["neokod-dev"]]);
    }).pipe(Effect.provide(ElectronProtocol.layer)),
  );

  it.effect("rejects custom protocol requests for another host", () =>
    Effect.gen(function* () {
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });

      const response = yield* Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* ElectronProtocol.ElectronProtocol;
          yield* protocol.registerDesktopProtocol({
            scheme: "neokod",
            targetOrigin: new URL("http://127.0.0.1:3773/"),
            backendOrigin: new URL("http://127.0.0.1:3773/"),
          });
          return yield* Effect.promise(() => handler!(new Request("neokod://other/")));
        }),
      );

      assert.equal(response.status, 404);
      assert.equal(netFetchMock.mock.calls.length, 0);
    }).pipe(Effect.provide(ElectronProtocol.layer)),
  );

  it.effect("retries transient renderer target failures", () =>
    Effect.gen(function* () {
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });
      netFetchMock
        .mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:5733"))
        .mockResolvedValueOnce(new Response("ready"));

      const response = yield* Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* ElectronProtocol.ElectronProtocol;
          yield* protocol.registerDesktopProtocol({
            scheme: "neokod-dev",
            targetOrigin: new URL("http://127.0.0.1:5733/"),
            backendOrigin: new URL("http://127.0.0.1:3773/"),
          });
          return yield* Effect.promise(() => handler!(new Request("neokod-dev://app/")));
        }),
      );

      assert.equal(yield* Effect.promise(() => response.text()), "ready");
      assert.equal(netFetchMock.mock.calls.length, 2);
    }).pipe(Effect.provide(ElectronProtocol.layer)),
  );

  it.effect("preserves protocol registration failures", () =>
    Effect.gen(function* () {
      const cause = new Error("protocol registration failed");
      handleMock.mockImplementationOnce(() => {
        throw cause;
      });

      const protocol = yield* ElectronProtocol.ElectronProtocol;
      const error = yield* Effect.scoped(
        protocol.registerDesktopProtocol({
          scheme: "neokod-dev",
          targetOrigin: new URL("http://127.0.0.1:3773/"),
          backendOrigin: new URL("http://127.0.0.1:3774/"),
        }),
      ).pipe(Effect.flip);

      assert.instanceOf(error, ElectronProtocol.ElectronProtocolRegistrationError);
      assert.equal(error.scheme, "neokod-dev");
      assert.strictEqual(error.cause, cause);
      assert.equal(error.message, 'Failed to register Electron protocol scheme "neokod-dev".');
    }).pipe(Effect.provide(ElectronProtocol.layer)),
  );

  it.effect("preserves protocol unregistration failures", () =>
    Effect.gen(function* () {
      const cause = new Error("protocol unregistration failed");
      unhandleMock.mockImplementationOnce(() => {
        throw cause;
      });

      const protocol = yield* ElectronProtocol.ElectronProtocol;
      const exit = yield* Effect.exit(
        Effect.scoped(
          protocol.registerDesktopProtocol({
            scheme: "neokod",
            targetOrigin: new URL("http://127.0.0.1:3773/"),
            backendOrigin: new URL("http://127.0.0.1:3773/"),
          }),
        ),
      );

      assert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause);
        assert.instanceOf(error, ElectronProtocol.ElectronProtocolUnregistrationError);
        assert.equal(error.scheme, "neokod");
        assert.strictEqual(error.cause, cause);
        assert.equal(error.message, 'Failed to unregister Electron protocol scheme "neokod".');
      }
    }).pipe(Effect.provide(ElectronProtocol.layer)),
  );

  it("restricts executable and network sources to local runtime origins", () => {
    const policy = ElectronProtocol.makeDesktopContentSecurityPolicy({
      scheme: "neokod",
      targetOrigin: new URL("http://127.0.0.1:3773/"),
      backendOrigin: new URL("http://127.0.0.1:3773/"),
    });
    const directives = Object.fromEntries(
      policy.split("; ").map((directive) => {
        const [name, ...sources] = directive.split(" ");
        return [name, sources];
      }),
    );

    assert.deepEqual(directives["script-src"], ["'self'", "'unsafe-inline'"]);
    assert.deepEqual(directives["connect-src"], [
      "'self'",
      "http://127.0.0.1:3773",
      "http://127.0.0.1:*",
      "ws://127.0.0.1:*",
      "http://localhost:*",
      "ws://localhost:*",
    ]);
    assert.deepEqual(directives["img-src"], [
      "'self'",
      "neokod:",
      "blob:",
      "data:",
      "http://127.0.0.1:3773",
    ]);
    assert.isUndefined(directives["frame-src"]);
    assert.deepEqual(directives["font-src"], ["'self'", "neokod:", "data:"]);
  });

  it("allows only explicit HTTP and WebSocket WSL origins", () => {
    const policy = ElectronProtocol.makeDesktopContentSecurityPolicy(
      {
        scheme: "neokod",
        targetOrigin: new URL("http://127.0.0.1:3773/"),
        backendOrigin: new URL("http://127.0.0.1:3773/"),
      },
      [
        "http://172.24.16.1:4888/path",
        "ws://172.24.16.1:4888/ws",
        "https://public.example.test",
        "not-a-url",
      ],
    );

    assert.include(policy, "http://172.24.16.1:4888");
    assert.include(policy, "ws://172.24.16.1:4888");
    assert.notInclude(policy, "public.example.test");
  });
});
