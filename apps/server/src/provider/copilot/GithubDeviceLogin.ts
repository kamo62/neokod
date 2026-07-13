// @effect-diagnostics globalFetchInEffect:off unknownInEffectCatch:off anyUnknownInErrorContext:off cryptoRandomUUIDInEffect:off - This isolated OAuth boundary is intentionally fetch-backed and tested with a stubbed global transport until the inherited device-flow client is moved behind an injectable service.
import { CopilotDeviceLoginError, ProviderDriverKind } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

import * as ServerSecretStore from "../../secrets/ServerSecretStore.ts";
import * as ProviderRegistry from "../Services/ProviderRegistry.ts";

/** Public Copilot editor-integration device-flow client id, proven 2026-07-10. */
export const GITHUB_COPILOT_DEVICE_CLIENT_ID = "Iv1.b507a08c87ecfe98";
export const COPILOT_GITHUB_TOKEN_SECRET = "copilot.githubToken";

export type GithubDeviceLoginStatus = "pending" | "success" | "expired" | "denied" | "error";

export interface GithubDeviceLoginStartResult {
  readonly flowId: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresInSeconds: number;
  readonly intervalSeconds: number;
}

export interface GithubDeviceLoginStatusResult {
  readonly flowId: string;
  readonly status: GithubDeviceLoginStatus;
}

interface Flow extends GithubDeviceLoginStartResult {
  deadlineEpochMillis: number;
  status: GithubDeviceLoginStatus;
  fiber: Fiber.Fiber<void, never> | undefined;
}

const flows = new Map<string, Flow>();
let activeFlowId: string | undefined;
const startSemaphore = Semaphore.makeUnsafe(1);

const postForm = (url: string, body: URLSearchParams) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      });
      if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}.`);
      return (await response.json()) as Record<string, unknown>;
    },
    catch: (cause) => cause,
  });

const asNonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const setError = (flow: Flow) =>
  Effect.sync(() => {
    flow.status = "error";
  });

const setExpired = (flow: Flow) =>
  Effect.sync(() => {
    flow.status = "expired";
  });

const poll = (
  flow: Flow,
  secretStore: ServerSecretStore.ServerSecretStore["Service"],
  providerRegistry: ProviderRegistry.ProviderRegistryShape,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    let intervalSeconds = flow.intervalSeconds;
    while (flow.status === "pending") {
      const remainingBeforeSleep = flow.deadlineEpochMillis - (yield* Clock.currentTimeMillis);
      if (remainingBeforeSleep <= 0) {
        yield* setExpired(flow);
        continue;
      }
      yield* Effect.sleep(Math.min(intervalSeconds * 1_000, remainingBeforeSleep));
      if (flow.status !== "pending") continue;

      const remainingBeforePoll = flow.deadlineEpochMillis - (yield* Clock.currentTimeMillis);
      if (remainingBeforePoll <= 0) {
        yield* setExpired(flow);
        continue;
      }
      const result = yield* postForm(
        "https://github.com/login/oauth/access_token",
        new URLSearchParams({
          client_id: GITHUB_COPILOT_DEVICE_CLIENT_ID,
          device_code: (flow as Flow & { readonly deviceCode: string }).deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      ).pipe(
        Effect.timeoutOption(remainingBeforePoll),
        Effect.matchEffect({
          onFailure: () => setError(flow).pipe(Effect.as(undefined)),
          onSuccess: Option.match({
            onNone: () => setExpired(flow).pipe(Effect.as(undefined)),
            onSome: Effect.succeed,
          }),
        }),
      );
      if (result === undefined || flow.status !== "pending") continue;

      const token = asNonEmptyString(result.access_token);
      if (token !== undefined) {
        yield* secretStore.set(COPILOT_GITHUB_TOKEN_SECRET, new TextEncoder().encode(token)).pipe(
          Effect.matchEffect({
            onFailure: () => setError(flow),
            onSuccess: () =>
              Effect.sync(() => {
                flow.status = "success";
              }).pipe(
                Effect.andThen(providerRegistry.refresh(ProviderDriverKind.make("githubCopilot"))),
                Effect.asVoid,
              ),
          }),
        );
        continue;
      }
      switch (result.error) {
        case "authorization_pending":
          break;
        case "slow_down":
          intervalSeconds += 5;
          break;
        case "expired_token":
          flow.status = "expired";
          break;
        case "access_denied":
          flow.status = "denied";
          break;
        default:
          flow.status = "error";
      }
    }
  }).pipe(Effect.catch(() => Effect.void));

export const startGithubDeviceLogin = (): Effect.Effect<
  GithubDeviceLoginStartResult,
  CopilotDeviceLoginError,
  ServerSecretStore.ServerSecretStore | ProviderRegistry.ProviderRegistry
> =>
  startSemaphore.withPermit(
    Effect.gen(function* () {
      if (activeFlowId !== undefined) {
        const active = flows.get(activeFlowId);
        if (active?.fiber !== undefined) yield* Fiber.interrupt(active.fiber).pipe(Effect.ignore);
        if (active !== undefined && active.status === "pending") active.status = "error";
      }
      const secretStore = yield* ServerSecretStore.ServerSecretStore;
      const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
      const result = yield* postForm(
        "https://github.com/login/device/code",
        new URLSearchParams({ client_id: GITHUB_COPILOT_DEVICE_CLIENT_ID }),
      ).pipe(
        Effect.mapError(
          () => new CopilotDeviceLoginError({ message: "Could not start GitHub device login." }),
        ),
      );
      const deviceCode = asNonEmptyString(result.device_code);
      const userCode = asNonEmptyString(result.user_code);
      const verificationUri = asNonEmptyString(result.verification_uri);
      const expiresInSeconds =
        typeof result.expires_in === "number" ? result.expires_in : undefined;
      const intervalSeconds = typeof result.interval === "number" ? result.interval : 5;
      if (
        !deviceCode ||
        !userCode ||
        !verificationUri ||
        !expiresInSeconds ||
        intervalSeconds <= 0
      ) {
        return yield* new CopilotDeviceLoginError({
          message: "GitHub returned an invalid device login response.",
        });
      }
      const flow: Flow & { deviceCode: string } = {
        flowId: crypto.randomUUID(),
        userCode,
        verificationUri,
        expiresInSeconds,
        intervalSeconds,
        deadlineEpochMillis: (yield* Clock.currentTimeMillis) + expiresInSeconds * 1_000,
        deviceCode,
        status: "pending",
        fiber: undefined,
      };
      flows.clear();
      flows.set(flow.flowId, flow);
      activeFlowId = flow.flowId;
      flow.fiber = yield* poll(flow, secretStore, providerRegistry).pipe(Effect.forkDetach);
      return flow;
    }),
  );

export const getGithubDeviceLoginStatus = (flowId: string): GithubDeviceLoginStatusResult => {
  const flow = flows.get(flowId);
  // Unknown flow IDs are intentionally indistinguishable from terminal errors.
  return { flowId, status: flow?.status ?? "error" };
};

export const resetGithubDeviceLoginForTests = (): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (const flow of flows.values()) {
      if (flow.fiber !== undefined) yield* Fiber.interrupt(flow.fiber).pipe(Effect.ignore);
    }
    flows.clear();
    activeFlowId = undefined;
  });

export const signOutGithubDeviceLogin = (): Effect.Effect<
  { readonly signedOut: boolean },
  never,
  ServerSecretStore.ServerSecretStore | ProviderRegistry.ProviderRegistry
> =>
  Effect.gen(function* () {
    const secretStore = yield* ServerSecretStore.ServerSecretStore;
    const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
    const removed = yield* secretStore
      .remove(COPILOT_GITHUB_TOKEN_SECRET)
      .pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }));
    if (!removed) return { signedOut: false };
    yield* providerRegistry.refresh(ProviderDriverKind.make("githubCopilot")).pipe(Effect.ignore);
    return { signedOut: true };
  });

export const getStoredGithubToken = (): Effect.Effect<string | undefined, never, never> =>
  Effect.gen(function* () {
    const secretStore = yield* Effect.serviceOption(ServerSecretStore.ServerSecretStore);
    if (Option.isNone(secretStore)) return undefined;
    const token = yield* secretStore.value.get(COPILOT_GITHUB_TOKEN_SECRET).pipe(Effect.orDie);
    return Option.isSome(token) ? new TextDecoder().decode(token.value) : undefined;
  });
