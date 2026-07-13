import {
  EnvironmentOwnedDataCleanup,
  PlatformConnectionSource,
} from "@neokod/client-runtime/platform";
import {
  ConnectionBlockedError,
  Connectivity,
  mapRemoteEnvironmentError,
  type PlatformConnectionRegistration,
  PrimaryConnectionRegistration,
  PrimaryConnectionTarget,
  Wakeups,
  WslConnectionRegistration,
  WslConnectionTarget,
} from "@neokod/client-runtime/connection";
import { fetchRemoteEnvironmentDescriptor } from "@neokod/client-runtime/environment";
import { EnvironmentRpcRequestObserver, remoteHttpClientLayer } from "@neokod/client-runtime/rpc";
import { type DesktopEnvironmentBootstrap, PRIMARY_LOCAL_ENVIRONMENT_ID } from "@neokod/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import {
  readPrimaryEnvironmentTarget,
  resolveDesktopEnvironmentBootstrapTarget,
  type PrimaryEnvironmentTarget,
} from "../environments/primary/target";
import { clearComposerDraftsEnvironment } from "../composerDraftStore";
import { acknowledgeRpcRequest, trackRpcRequestSent } from "../rpc/requestLatencyState";
import {
  desktopLocalConnectionId,
  readDesktopSecondaryBootstrapsResult,
  type DesktopSecondaryBootstrapsRead,
} from "./desktopLocal";
import { connectionStorageLayer } from "./storage";

let nextObservedRpcRequestId = 0;
const PLATFORM_POLL_INTERVAL = "3 seconds";

function currentNetworkStatus(): "unknown" | "offline" | "online" {
  if (typeof navigator === "undefined") return "unknown";
  return navigator.onLine ? "online" : "offline";
}

const connectivityLayer = Connectivity.layer({
  status: Effect.sync(currentNetworkStatus),
  changes: Stream.callback((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const online = () => Queue.offerUnsafe(queue, "online");
        const offline = () => Queue.offerUnsafe(queue, "offline");
        window.addEventListener("online", online);
        window.addEventListener("offline", offline);
        return { online, offline };
      }),
      ({ online, offline }) =>
        Effect.sync(() => {
          window.removeEventListener("online", online);
          window.removeEventListener("offline", offline);
        }),
    ).pipe(Effect.asVoid),
  ),
});

const wakeupsLayer = Wakeups.layer({
  changes: Stream.callback<"application-active">((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const listener = () => {
          if (document.visibilityState === "visible") {
            Queue.offerUnsafe(queue, "application-active");
          }
        };
        document.addEventListener("visibilitychange", listener);
        return listener;
      }),
      (listener) => Effect.sync(() => document.removeEventListener("visibilitychange", listener)),
    ).pipe(Effect.asVoid),
  ),
});

const descriptorFor = (httpBaseUrl: string, wslBearerToken?: string) => {
  const baseLayer = remoteHttpClientLayer(globalThis.fetch);
  const clientLayer =
    wslBearerToken === undefined
      ? baseLayer
      : Layer.effect(
          HttpClient.HttpClient,
          Effect.map(HttpClient.HttpClient, (client) =>
            client.pipe(
              HttpClient.mapRequest((request) =>
                HttpClientRequest.bearerToken(request, wslBearerToken),
              ),
            ),
          ),
        ).pipe(Layer.provide(baseLayer));
  return fetchRemoteEnvironmentDescriptor({ httpBaseUrl }).pipe(
    Effect.provide(clientLayer),
    Effect.mapError(mapRemoteEnvironmentError),
  );
};

const loadPrimaryConnectionRegistration = Effect.fn(
  "web.connectionPlatform.loadPrimaryConnectionRegistration",
)(function* (resolved: PrimaryEnvironmentTarget) {
  const descriptor = yield* descriptorFor(
    resolved.target.httpBaseUrl,
    resolved.transport._tag === "WslBearer" ? resolved.transport.token : undefined,
  );
  if (resolved.transport._tag === "Loopback") {
    return new PrimaryConnectionRegistration({
      target: new PrimaryConnectionTarget({
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        ...resolved.target,
      }),
    });
  }
  const connectionId = desktopLocalConnectionId(PRIMARY_LOCAL_ENVIRONMENT_ID);
  return new WslConnectionRegistration({
    target: new WslConnectionTarget({
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      connectionId,
      ...resolved.target,
    }),
    wslBearerToken: resolved.transport.token,
  });
});

const loadWslConnectionRegistration = Effect.fn(
  "web.connectionPlatform.loadWslConnectionRegistration",
)(function* (entry: DesktopEnvironmentBootstrap) {
  if (entry.transport !== "wsl-bearer") {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      detail: `Desktop-local backend ${entry.id} is not a WSL bearer target.`,
    });
  }
  const resolved = yield* Effect.try({
    try: () => resolveDesktopEnvironmentBootstrapTarget(entry),
    catch: (cause) =>
      new ConnectionBlockedError({
        reason: "configuration",
        detail: cause instanceof Error ? cause.message : "Desktop-local endpoint rejected.",
      }),
  });
  const descriptor = yield* descriptorFor(resolved.target.httpBaseUrl, entry.wslBearerToken);
  const connectionId = desktopLocalConnectionId(entry.id);
  return new WslConnectionRegistration({
    target: new WslConnectionTarget({
      environmentId: descriptor.environmentId,
      label: entry.label || descriptor.label,
      connectionId,
      ...resolved.target,
    }),
    wslBearerToken: entry.wslBearerToken,
  });
});

interface CachedPlatformRegistration {
  readonly signature: string;
  readonly registration: PlatformConnectionRegistration;
}

export type PrimaryEnvironmentTargetRead =
  | { readonly _tag: "Success"; readonly target: PrimaryEnvironmentTarget | null }
  | { readonly _tag: "Failure"; readonly cause: unknown };

export function readPrimaryEnvironmentTargetResult(
  readTarget: () => PrimaryEnvironmentTarget | null = readPrimaryEnvironmentTarget,
): PrimaryEnvironmentTargetRead {
  try {
    return { _tag: "Success", target: readTarget() };
  } catch (cause) {
    return { _tag: "Failure", cause };
  }
}

export function primaryRegistrationToRetainAfterTopologyRead(
  previous: ReadonlyMap<string, CachedPlatformRegistration>,
  topologyRead: PrimaryEnvironmentTargetRead,
): CachedPlatformRegistration | undefined {
  return topologyRead._tag === "Failure" ? previous.get(PRIMARY_LOCAL_ENVIRONMENT_ID) : undefined;
}

export function secondaryRegistrationsToRetainAfterTopologyRead(
  previous: ReadonlyMap<string, CachedPlatformRegistration>,
  topologyRead: DesktopSecondaryBootstrapsRead,
): ReadonlyMap<string, CachedPlatformRegistration> {
  return topologyRead._tag === "Failure"
    ? new Map([...previous].filter(([id]) => id !== PRIMARY_LOCAL_ENVIRONMENT_ID))
    : new Map();
}

const platformConnectionSourceLayer = Layer.effect(
  PlatformConnectionSource,
  Effect.gen(function* () {
    const cacheRef = yield* Ref.make(new Map<string, CachedPlatformRegistration>());
    const buildPlatformRegistrations = Effect.gen(function* () {
      const previous = yield* Ref.get(cacheRef);
      const next = new Map<string, CachedPlatformRegistration>();
      const registrations: PlatformConnectionRegistration[] = [];

      const primaryRead = readPrimaryEnvironmentTargetResult();
      const retainedPrimary = primaryRegistrationToRetainAfterTopologyRead(previous, primaryRead);
      if (retainedPrimary !== undefined) {
        next.set(PRIMARY_LOCAL_ENVIRONMENT_ID, retainedPrimary);
        registrations.push(retainedPrimary.registration);
      } else if (primaryRead._tag === "Success" && primaryRead.target !== null) {
        const target = primaryRead.target;
        const signature = `${target.transport._tag}|${target.target.httpBaseUrl}|${target.target.wsBaseUrl}|${target.transport._tag === "WslBearer" ? target.transport.token : ""}`;
        const cached = previous.get(PRIMARY_LOCAL_ENVIRONMENT_ID);
        const registration =
          cached?.signature === signature
            ? Option.some(cached.registration)
            : yield* loadPrimaryConnectionRegistration(target).pipe(
                Effect.tapError((error) =>
                  Effect.logWarning("Could not discover the primary environment.", { error }),
                ),
                Effect.option,
              );
        if (Option.isSome(registration)) {
          const entry = { signature, registration: registration.value };
          next.set(PRIMARY_LOCAL_ENVIRONMENT_ID, entry);
          registrations.push(registration.value);
        }
      }

      const secondaryRead = readDesktopSecondaryBootstrapsResult();
      for (const [id, cached] of secondaryRegistrationsToRetainAfterTopologyRead(
        previous,
        secondaryRead,
      )) {
        next.set(id, cached);
        registrations.push(cached.registration);
      }
      if (secondaryRead._tag === "Success") {
        for (const bootstrap of secondaryRead.bootstraps) {
          if (bootstrap.transport !== "wsl-bearer") continue;
          const signature = `${bootstrap.httpBaseUrl}|${bootstrap.wsBaseUrl}|${bootstrap.wslBearerToken}`;
          const cached = previous.get(bootstrap.id);
          const registration =
            cached?.signature === signature
              ? Option.some(cached.registration)
              : yield* loadWslConnectionRegistration(bootstrap).pipe(
                  Effect.tapError((error) =>
                    Effect.logWarning("Could not connect a WSL backend.", {
                      id: bootstrap.id,
                      error,
                    }),
                  ),
                  Effect.option,
                );
          if (Option.isSome(registration)) {
            const entry = { signature, registration: registration.value };
            next.set(bootstrap.id, entry);
            registrations.push(registration.value);
          }
        }
      }

      yield* Ref.set(cacheRef, next);
      return registrations as ReadonlyArray<PlatformConnectionRegistration>;
    });

    return PlatformConnectionSource.of({
      registrations: Stream.tick(PLATFORM_POLL_INTERVAL).pipe(
        Stream.mapEffect(() => buildPlatformRegistrations),
      ),
    });
  }),
);

const environmentOwnedDataCleanupLayer = Layer.succeed(
  EnvironmentOwnedDataCleanup,
  EnvironmentOwnedDataCleanup.of({
    clear: (environmentId) => Effect.sync(() => clearComposerDraftsEnvironment(environmentId)),
  }),
);

const rpcRequestObserverLayer = Layer.succeed(
  EnvironmentRpcRequestObserver,
  EnvironmentRpcRequestObserver.of({
    observe: ({ environmentId, method }) =>
      Effect.sync(() => {
        nextObservedRpcRequestId += 1;
        const requestId = `${environmentId}:${nextObservedRpcRequestId}`;
        trackRpcRequestSent(requestId, `${method} · ${environmentId}`);
        return Effect.sync(() => acknowledgeRpcRequest(requestId));
      }),
  }),
);

type ConnectionPlatformLayerSource =
  | typeof connectionStorageLayer
  | typeof connectivityLayer
  | typeof wakeupsLayer
  | typeof platformConnectionSourceLayer
  | typeof environmentOwnedDataCleanupLayer
  | typeof rpcRequestObserverLayer;

export const connectionPlatformLayer: Layer.Layer<
  Layer.Success<ConnectionPlatformLayerSource>,
  Layer.Error<ConnectionPlatformLayerSource>,
  Layer.Services<ConnectionPlatformLayerSource>
> = Layer.mergeAll(
  connectionStorageLayer,
  connectivityLayer,
  wakeupsLayer,
  platformConnectionSourceLayer,
  environmentOwnedDataCleanupLayer,
  rpcRequestObserverLayer,
);
