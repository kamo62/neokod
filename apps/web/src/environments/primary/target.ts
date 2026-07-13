import { PRIMARY_LOCAL_ENVIRONMENT_ID, type DesktopEnvironmentBootstrap } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const PrimaryEnvironmentTargetSource = Schema.Literals([
  "configured",
  "window-origin",
  "desktop-managed",
]);
type PrimaryEnvironmentTargetSource = typeof PrimaryEnvironmentTargetSource.Type;

const PrimaryEnvironmentUrlKind = Schema.Literals([
  "http-base-url",
  "websocket-base-url",
  "development-server-url",
  "window-location-url",
]);
type PrimaryEnvironmentUrlKind = typeof PrimaryEnvironmentUrlKind.Type;

export class PrimaryEnvironmentUrlInvalidError extends Schema.TaggedErrorClass<PrimaryEnvironmentUrlInvalidError>()(
  "PrimaryEnvironmentUrlInvalidError",
  {
    source: PrimaryEnvironmentTargetSource,
    urlKind: PrimaryEnvironmentUrlKind,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not parse ${this.urlKind} for the ${this.source} primary environment target.`;
  }
}

export class PrimaryEnvironmentProtocolUnsupportedError extends Schema.TaggedErrorClass<PrimaryEnvironmentProtocolUnsupportedError>()(
  "PrimaryEnvironmentProtocolUnsupportedError",
  {
    source: PrimaryEnvironmentTargetSource,
    protocol: Schema.String,
  },
) {
  override get message(): string {
    return `The ${this.source} primary environment target uses unsupported protocol ${this.protocol}.`;
  }
}

export class DesktopEnvironmentBootstrapIncompleteError extends Schema.TaggedErrorClass<DesktopEnvironmentBootstrapIncompleteError>()(
  "DesktopEnvironmentBootstrapIncompleteError",
  {
    hasHttpBaseUrl: Schema.Boolean,
    hasWsBaseUrl: Schema.Boolean,
  },
) {
  override get message(): string {
    const missing = [
      ...(this.hasHttpBaseUrl ? [] : ["httpBaseUrl"]),
      ...(this.hasWsBaseUrl ? [] : ["wsBaseUrl"]),
    ];
    return `Desktop bootstrap is missing ${missing.join(" and ")} for the local environment.`;
  }
}

const PrimaryEnvironmentTargetRejectedReason = Schema.Literals([
  "credentials",
  "endpoint-mismatch",
  "non-loopback",
  "wsl-authentication",
]);

export class PrimaryEnvironmentTargetRejectedError extends Schema.TaggedErrorClass<PrimaryEnvironmentTargetRejectedError>()(
  "PrimaryEnvironmentTargetRejectedError",
  {
    source: PrimaryEnvironmentTargetSource,
    reason: PrimaryEnvironmentTargetRejectedReason,
  },
) {
  override get message(): string {
    return `The ${this.source} primary environment target was rejected (${this.reason}).`;
  }
}

export const isPrimaryEnvironmentUrlInvalidError = Schema.is(PrimaryEnvironmentUrlInvalidError);
export const isPrimaryEnvironmentProtocolUnsupportedError = Schema.is(
  PrimaryEnvironmentProtocolUnsupportedError,
);
export const isDesktopEnvironmentBootstrapIncompleteError = Schema.is(
  DesktopEnvironmentBootstrapIncompleteError,
);
export const isPrimaryEnvironmentTargetRejectedError = Schema.is(
  PrimaryEnvironmentTargetRejectedError,
);

export interface PrimaryEnvironmentTarget {
  readonly source: PrimaryEnvironmentTargetSource;
  readonly target: {
    readonly httpBaseUrl: string;
    readonly wsBaseUrl: string;
  };
}

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);

function getDesktopLocalEnvironmentBootstrap(): DesktopEnvironmentBootstrap | null {
  // The primary (Windows-native) backend keeps the "primary" id. The
  // plural list may include a second WSL entry; the primary-target
  // resolver only cares about the primary, so just find it.
  const bootstraps = window.desktopBridge?.getLocalEnvironmentBootstraps() ?? [];
  return bootstraps.find((entry) => entry.id === PRIMARY_LOCAL_ENVIRONMENT_ID) ?? null;
}

function parseTargetUrl(input: {
  readonly rawValue: string;
  readonly baseUrl?: string;
  readonly source: PrimaryEnvironmentTargetSource;
  readonly urlKind: PrimaryEnvironmentUrlKind;
}): URL {
  try {
    return input.baseUrl === undefined
      ? new URL(input.rawValue)
      : new URL(input.rawValue, input.baseUrl);
  } catch (cause) {
    throw new PrimaryEnvironmentUrlInvalidError({
      source: input.source,
      urlKind: input.urlKind,
      cause,
    });
  }
}

function normalizeBaseUrl(
  rawValue: string,
  source: PrimaryEnvironmentTargetSource,
  urlKind: PrimaryEnvironmentUrlKind,
): string {
  return parseTargetUrl({
    rawValue,
    baseUrl: window.location.origin,
    source,
    urlKind,
  }).toString();
}

function swapBaseUrlProtocol(
  rawValue: string,
  nextProtocol: "http:" | "https:" | "ws:" | "wss:",
  urlKind: PrimaryEnvironmentUrlKind,
): string {
  const url = parseTargetUrl({
    rawValue,
    baseUrl: window.location.origin,
    source: "configured",
    urlKind,
  });
  url.protocol = nextProtocol;
  return url.toString();
}

function normalizeHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
}

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(normalizeHostname(hostname));
}

function effectivePort(url: URL): string {
  if (url.port !== "") return url.port;
  return url.protocol === "https:" || url.protocol === "wss:" ? "443" : "80";
}

function validateTargetUrls(input: {
  readonly source: PrimaryEnvironmentTargetSource;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly desktopBootstrap?: DesktopEnvironmentBootstrap;
}): PrimaryEnvironmentTarget {
  const httpUrl = parseTargetUrl({
    rawValue: input.httpBaseUrl,
    source: input.source,
    urlKind: "http-base-url",
  });
  const wsUrl = parseTargetUrl({
    rawValue: input.wsBaseUrl,
    source: input.source,
    urlKind: "websocket-base-url",
  });
  if (httpUrl.protocol !== "http:" && httpUrl.protocol !== "https:") {
    throw new PrimaryEnvironmentProtocolUnsupportedError({
      source: input.source,
      protocol: httpUrl.protocol,
    });
  }
  if (wsUrl.protocol !== "ws:" && wsUrl.protocol !== "wss:") {
    throw new PrimaryEnvironmentProtocolUnsupportedError({
      source: input.source,
      protocol: wsUrl.protocol,
    });
  }
  if (httpUrl.username || httpUrl.password || wsUrl.username || wsUrl.password) {
    throw new PrimaryEnvironmentTargetRejectedError({
      source: input.source,
      reason: "credentials",
    });
  }
  const protocolsMatch =
    (httpUrl.protocol === "http:" && wsUrl.protocol === "ws:") ||
    (httpUrl.protocol === "https:" && wsUrl.protocol === "wss:");
  if (
    !protocolsMatch ||
    normalizeHostname(httpUrl.hostname) !== normalizeHostname(wsUrl.hostname) ||
    effectivePort(httpUrl) !== effectivePort(wsUrl)
  ) {
    throw new PrimaryEnvironmentTargetRejectedError({
      source: input.source,
      reason: "endpoint-mismatch",
    });
  }

  const httpIsLoopback = isLoopbackHostname(httpUrl.hostname);
  const wsIsLoopback = isLoopbackHostname(wsUrl.hostname);
  if (httpIsLoopback && wsIsLoopback) {
    return {
      source: input.source,
      target: { httpBaseUrl: httpUrl.toString(), wsBaseUrl: wsUrl.toString() },
    };
  }
  if (input.source !== "desktop-managed") {
    throw new PrimaryEnvironmentTargetRejectedError({
      source: input.source,
      reason: "non-loopback",
    });
  }

  const bootstrap = input.desktopBootstrap;
  const isWslId =
    bootstrap?.id === PRIMARY_LOCAL_ENVIRONMENT_ID || bootstrap?.id.startsWith("wsl:") === true;
  if (
    httpIsLoopback !== wsIsLoopback ||
    bootstrap?.transport !== "wsl-bearer" ||
    !isWslId ||
    !bootstrap?.runningDistro?.trim() ||
    !bootstrap.bootstrapToken?.trim()
  ) {
    throw new PrimaryEnvironmentTargetRejectedError({
      source: input.source,
      reason: "wsl-authentication",
    });
  }

  return {
    source: input.source,
    target: { httpBaseUrl: httpUrl.toString(), wsBaseUrl: wsUrl.toString() },
  };
}

export function resolveDesktopEnvironmentBootstrapTarget(
  desktopBootstrap: DesktopEnvironmentBootstrap,
): PrimaryEnvironmentTarget {
  if (!desktopBootstrap.httpBaseUrl || !desktopBootstrap.wsBaseUrl) {
    throw new DesktopEnvironmentBootstrapIncompleteError({
      hasHttpBaseUrl: Boolean(desktopBootstrap.httpBaseUrl),
      hasWsBaseUrl: Boolean(desktopBootstrap.wsBaseUrl),
    });
  }
  return validateTargetUrls({
    source: "desktop-managed",
    httpBaseUrl: normalizeBaseUrl(desktopBootstrap.httpBaseUrl, "desktop-managed", "http-base-url"),
    wsBaseUrl: normalizeBaseUrl(
      desktopBootstrap.wsBaseUrl,
      "desktop-managed",
      "websocket-base-url",
    ),
    desktopBootstrap,
  });
}

function resolveHttpRequestBaseUrl(primaryTarget: PrimaryEnvironmentTarget): string {
  const httpBaseUrl = primaryTarget.target.httpBaseUrl;
  const configuredDevServerUrl = import.meta.env.VITE_DEV_SERVER_URL?.trim();
  if (!configuredDevServerUrl) {
    return httpBaseUrl;
  }

  const currentUrl = parseTargetUrl({
    rawValue: window.location.href,
    source: "window-origin",
    urlKind: "window-location-url",
  });
  const targetUrl = parseTargetUrl({
    rawValue: httpBaseUrl,
    source: primaryTarget.source,
    urlKind: "http-base-url",
  });
  const devServerUrl = parseTargetUrl({
    rawValue: configuredDevServerUrl,
    baseUrl: currentUrl.origin,
    source: "configured",
    urlKind: "development-server-url",
  });
  if (
    (devServerUrl.protocol !== "http:" && devServerUrl.protocol !== "https:") ||
    !isLoopbackHostname(devServerUrl.hostname) ||
    devServerUrl.username !== "" ||
    devServerUrl.password !== ""
  ) {
    throw new PrimaryEnvironmentTargetRejectedError({
      source: "configured",
      reason: devServerUrl.username || devServerUrl.password ? "credentials" : "non-loopback",
    });
  }

  const isCurrentOriginDevServer =
    (currentUrl.protocol === "http:" || currentUrl.protocol === "https:") &&
    currentUrl.origin === devServerUrl.origin;

  if (
    !isCurrentOriginDevServer ||
    currentUrl.origin === targetUrl.origin ||
    !isLoopbackHostname(currentUrl.hostname) ||
    !isLoopbackHostname(targetUrl.hostname)
  ) {
    return httpBaseUrl;
  }

  return currentUrl.origin;
}

function resolveConfiguredPrimaryTarget(): PrimaryEnvironmentTarget | null {
  const configuredHttpBaseUrl = import.meta.env.VITE_HTTP_URL?.trim() || undefined;
  const configuredWsBaseUrl = import.meta.env.VITE_WS_URL?.trim() || undefined;

  if (!configuredHttpBaseUrl && !configuredWsBaseUrl) {
    return null;
  }

  const resolvedHttpBaseUrl =
    configuredHttpBaseUrl ??
    (configuredWsBaseUrl?.startsWith("wss:")
      ? swapBaseUrlProtocol(configuredWsBaseUrl, "https:", "websocket-base-url")
      : swapBaseUrlProtocol(configuredWsBaseUrl!, "http:", "websocket-base-url"));
  const resolvedWsBaseUrl =
    configuredWsBaseUrl ??
    (configuredHttpBaseUrl?.startsWith("https:")
      ? swapBaseUrlProtocol(configuredHttpBaseUrl, "wss:", "http-base-url")
      : swapBaseUrlProtocol(configuredHttpBaseUrl!, "ws:", "http-base-url"));

  return validateTargetUrls({
    source: "configured",
    httpBaseUrl: normalizeBaseUrl(resolvedHttpBaseUrl, "configured", "http-base-url"),
    wsBaseUrl: normalizeBaseUrl(resolvedWsBaseUrl, "configured", "websocket-base-url"),
  });
}

function resolveWindowOriginPrimaryTarget(): PrimaryEnvironmentTarget {
  const url = parseTargetUrl({
    rawValue: window.location.origin,
    source: "window-origin",
    urlKind: "http-base-url",
  });
  const httpBaseUrl = url.toString();
  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else {
    throw new PrimaryEnvironmentProtocolUnsupportedError({
      source: "window-origin",
      protocol: url.protocol,
    });
  }
  return validateTargetUrls({
    source: "window-origin",
    httpBaseUrl,
    wsBaseUrl: url.toString(),
  });
}

function resolveDesktopPrimaryTarget(): PrimaryEnvironmentTarget | null {
  const desktopBootstrap = getDesktopLocalEnvironmentBootstrap();
  if (!desktopBootstrap) {
    return null;
  }
  if (!desktopBootstrap.httpBaseUrl && !desktopBootstrap.wsBaseUrl) {
    return null;
  }
  return resolveDesktopEnvironmentBootstrapTarget(desktopBootstrap);
}

export function resolvePrimaryEnvironmentHttpUrl(
  pathname: string,
  searchParams?: Record<string, string>,
): string {
  const primaryTarget = readPrimaryEnvironmentTarget();

  const url = parseTargetUrl({
    rawValue: resolveHttpRequestBaseUrl(primaryTarget),
    source: primaryTarget.source,
    urlKind: "http-base-url",
  });
  url.pathname = pathname;
  if (searchParams) {
    url.search = new URLSearchParams(searchParams).toString();
  }
  return url.toString();
}

export function readPrimaryEnvironmentTarget(): PrimaryEnvironmentTarget {
  return (
    resolveDesktopPrimaryTarget() ??
    resolveConfiguredPrimaryTarget() ??
    resolveWindowOriginPrimaryTarget()
  );
}
