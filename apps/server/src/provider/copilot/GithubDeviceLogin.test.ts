import * as NodeAssert from "node:assert/strict";
import { afterEach, beforeEach, it, vi } from "vite-plus/test";

import { ProviderDriverKind } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../../secrets/ServerSecretStore.ts";
import * as ProviderRegistry from "../Services/ProviderRegistry.ts";
import {
  COPILOT_GITHUB_TOKEN_SECRET,
  getGithubDeviceLoginStatus,
  getStoredGithubToken,
  resetGithubDeviceLoginForTests,
  signOutGithubDeviceLogin,
  startGithubDeviceLogin,
} from "./GithubDeviceLogin.ts";

const token = "github-device-token-that-must-not-leak";

let fetchResponses: Array<Record<string, unknown> | Error>;
let secrets: Map<string, Uint8Array>;
let refreshes: Array<ProviderDriverKind | undefined>;
let failRemove: boolean;

const unused = () => Effect.die(new Error("unused"));

const testLayer = () =>
  Layer.mergeAll(
    Layer.succeed(ServerSecretStore.ServerSecretStore, {
      get: (name) => Effect.succeed(Option.fromNullishOr(secrets.get(name))),
      set: (name, value) =>
        Effect.sync(() => {
          secrets.set(name, value);
        }),
      create: unused,
      getOrCreateRandom: unused,
      remove: (name) =>
        failRemove
          ? Effect.fail(
              new ServerSecretStore.SecretStoreRemoveError({
                resource: `secret ${name}`,
                cause: new Error("remove failed"),
              }),
            )
          : Effect.sync(() => {
              secrets.delete(name);
            }),
    } satisfies ServerSecretStore.ServerSecretStore["Service"]),
    Layer.succeed(ProviderRegistry.ProviderRegistry, {
      getProviders: Effect.succeed([]),
      refresh: (provider) =>
        Effect.sync(() => {
          refreshes.push(provider);
          return [];
        }),
      refreshInstance: unused,
      getProviderMaintenanceCapabilitiesForInstance: unused,
      setProviderMaintenanceActionState: unused,
      streamChanges: Stream.empty,
    } satisfies ProviderRegistry.ProviderRegistryShape),
  );

const deviceCodeResponse = {
  device_code: "device-code",
  user_code: "ABCD-EFGH",
  verification_uri: "https://github.com/login/device",
  expires_in: 900,
  interval: 2,
};

const advance = (seconds: number) =>
  Effect.gen(function* () {
    yield* Effect.yieldNow;
    yield* TestClock.adjust(Duration.seconds(seconds));
    yield* Effect.yieldNow;
  });

const withTestRuntime = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    ServerSecretStore.ServerSecretStore | ProviderRegistry.ProviderRegistry
  >,
) =>
  // Reset inside the test's own runtime: the lint rule forbids manual
  // Effect.runPromise in hooks, and leftover pollers only matter to the
  // next effect test, which resets before running.
  resetGithubDeviceLoginForTests().pipe(
    Effect.andThen(effect),
    Effect.provide(Layer.mergeAll(testLayer(), TestClock.layer())),
  );

beforeEach(() => {
  fetchResponses = [];
  secrets = new Map();
  refreshes = [];
  failRemove = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const response = fetchResponses.shift();
      if (response instanceof Error) throw response;
      if (response === undefined) throw new Error("unexpected fetch call");
      return new Response(JSON.stringify(response), {
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("polls through slow_down, stores the token, and refreshes Copilot", () =>
  Effect.gen(function* () {
    fetchResponses = [
      deviceCodeResponse,
      { error: "authorization_pending" },
      { error: "slow_down" },
      { access_token: token },
    ];

    const flow = yield* startGithubDeviceLogin();
    yield* advance(2);
    yield* advance(2);
    yield* advance(6);
    NodeAssert.equal(getGithubDeviceLoginStatus(flow.flowId).status, "pending");
    yield* advance(1);

    NodeAssert.equal(getGithubDeviceLoginStatus(flow.flowId).status, "success");
    NodeAssert.deepEqual(secrets.get(COPILOT_GITHUB_TOKEN_SECRET), new TextEncoder().encode(token));
    NodeAssert.deepEqual(refreshes, [ProviderDriverKind.make("githubCopilot")]);
  }).pipe(withTestRuntime));

it("treats expired_token as terminal", () =>
  Effect.gen(function* () {
    fetchResponses = [deviceCodeResponse, { error: "expired_token" }];
    const flow = yield* startGithubDeviceLogin();
    yield* advance(2);
    NodeAssert.equal(getGithubDeviceLoginStatus(flow.flowId).status, "expired");
  }).pipe(withTestRuntime));

it("treats access_denied as terminal", () =>
  Effect.gen(function* () {
    fetchResponses = [deviceCodeResponse, { error: "access_denied" }];
    const flow = yield* startGithubDeviceLogin();
    yield* advance(2);
    NodeAssert.equal(getGithubDeviceLoginStatus(flow.flowId).status, "denied");
  }).pipe(withTestRuntime));

it("treats polling transport failures as terminal errors", () =>
  Effect.gen(function* () {
    fetchResponses = [deviceCodeResponse, new Error("offline")];
    const flow = yield* startGithubDeviceLogin();
    yield* advance(2);
    NodeAssert.equal(getGithubDeviceLoginStatus(flow.flowId).status, "error");
  }).pipe(withTestRuntime));

it("supersedes the previous pending flow when a new flow starts", () =>
  Effect.gen(function* () {
    fetchResponses = [deviceCodeResponse, { ...deviceCodeResponse, user_code: "IJKL-MNOP" }];
    const first = yield* startGithubDeviceLogin();
    const second = yield* startGithubDeviceLogin();

    NodeAssert.equal(getGithubDeviceLoginStatus(first.flowId).status, "error");
    NodeAssert.equal(getGithubDeviceLoginStatus(second.flowId).status, "pending");
  }).pipe(withTestRuntime));

it("serializes concurrent starts so the superseded flow cannot succeed", () =>
  Effect.gen(function* () {
    fetchResponses = [
      deviceCodeResponse,
      { ...deviceCodeResponse, user_code: "IJKL-MNOP" },
      { access_token: token },
    ];

    const [first, second] = yield* Effect.all(
      [startGithubDeviceLogin(), startGithubDeviceLogin()],
      { concurrency: 2 },
    );
    yield* advance(2);

    NodeAssert.equal(getGithubDeviceLoginStatus(first.flowId).status, "error");
    NodeAssert.equal(getGithubDeviceLoginStatus(second.flowId).status, "success");
    NodeAssert.deepEqual(secrets.get(COPILOT_GITHUB_TOKEN_SECRET), new TextEncoder().encode(token));
  }).pipe(withTestRuntime));

it("expires locally when authorization remains pending past the device-code lifetime", () =>
  Effect.gen(function* () {
    fetchResponses = [{ ...deviceCodeResponse, expires_in: 3 }, { error: "authorization_pending" }];
    const flow = yield* startGithubDeviceLogin();

    yield* advance(4);

    NodeAssert.equal(getGithubDeviceLoginStatus(flow.flowId).status, "expired");
  }).pipe(withTestRuntime));

it("keeps polling after the scope that starts the flow closes", () =>
  Effect.gen(function* () {
    fetchResponses = [deviceCodeResponse, { access_token: token }];
    const flow = yield* Effect.scoped(startGithubDeviceLogin());

    yield* advance(2);
    NodeAssert.equal(getGithubDeviceLoginStatus(flow.flowId).status, "success");
  }).pipe(withTestRuntime));

it("never exposes the raw GitHub token through device-login status", () =>
  Effect.gen(function* () {
    fetchResponses = [deviceCodeResponse, { access_token: token }];
    const flow = yield* startGithubDeviceLogin();
    const pending = getGithubDeviceLoginStatus(flow.flowId);
    yield* advance(2);
    const success = getGithubDeviceLoginStatus(flow.flowId);

    // @effect-diagnostics-next-line preferSchemaOverJson:off - Serialization is intentional: this regression checks that the transport DTO cannot leak the raw token.
    NodeAssert.equal(JSON.stringify(pending).includes(token), false);
    // @effect-diagnostics-next-line preferSchemaOverJson:off - Serialization is intentional: this regression checks that the transport DTO cannot leak the raw token.
    NodeAssert.equal(JSON.stringify(success).includes(token), false);
  }).pipe(withTestRuntime));

it("round trips the stored token and returns undefined when absent", () =>
  Effect.gen(function* () {
    NodeAssert.equal(yield* getStoredGithubToken(), undefined);
    secrets.set(COPILOT_GITHUB_TOKEN_SECRET, new TextEncoder().encode(token));
    NodeAssert.equal(yield* getStoredGithubToken(), token);
  }).pipe(Effect.provide(testLayer())));

it("signs out by removing the token and refreshing Copilot", () =>
  Effect.gen(function* () {
    secrets.set(COPILOT_GITHUB_TOKEN_SECRET, new TextEncoder().encode(token));

    NodeAssert.deepEqual(yield* signOutGithubDeviceLogin(), { signedOut: true });
    NodeAssert.equal(secrets.has(COPILOT_GITHUB_TOKEN_SECRET), false);
    NodeAssert.deepEqual(refreshes, [ProviderDriverKind.make("githubCopilot")]);
  }).pipe(withTestRuntime));

it("reports failed sign-out without refreshing Copilot when token removal fails", () =>
  Effect.gen(function* () {
    secrets.set(COPILOT_GITHUB_TOKEN_SECRET, new TextEncoder().encode(token));
    failRemove = true;

    NodeAssert.deepEqual(yield* signOutGithubDeviceLogin(), { signedOut: false });
    NodeAssert.equal(secrets.has(COPILOT_GITHUB_TOKEN_SECRET), true);
    NodeAssert.deepEqual(refreshes, []);
  }).pipe(withTestRuntime));
