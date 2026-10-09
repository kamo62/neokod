import Mime from "@effect/platform-node/Mime";
import * as NodeCrypto from "node:crypto";
import { EnvironmentHttpApi } from "@neokod/contracts";
import { decodeOtlpTraceRecords } from "@neokod/shared/observability";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { cast } from "effect/Function";
import {
  HttpBody,
  HttpClient,
  HttpClientResponse,
  HttpMiddleware,
  HttpRouter,
  HttpServerResponse,
  HttpServerRequest,
  HttpServerRespondable,
} from "effect/unstable/http";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as Headers from "effect/unstable/http/Headers";
import { OtlpTracer } from "effect/unstable/observability";

import * as ServerConfig from "./config.ts";
import { ASSET_ROUTE_PREFIX, resolveAsset } from "./assets/AssetAccess.ts";
import * as BrowserTraceCollector from "./observability/BrowserTraceCollector.ts";
import { annotateEnvironmentRequest } from "./transport/EnvironmentHttp.ts";
import * as WslBearerAuth from "./transport/WslBearerAuth.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import { browserApiCorsAllowedHeaders, browserApiCorsAllowedMethods } from "./httpCors.ts";

const OTLP_TRACES_PROXY_PATH = "/api/observability/v1/traces";
const OTLP_TRACES_MAX_BODY_BYTES = 1024 * 1024;
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);
const DESKTOP_RENDERER_ORIGINS = ["neokod://app", "neokod-dev://app"];

export const browserApiCorsLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const devOrigin = config.devUrl?.origin;
    // Dev uses credentialed requests from Vite or the Electron custom origin, so both must be
    // explicit. Packaged desktop omits credentials and uses Effect's default wildcard origin.
    if (typeof config.loopbackAuthToken === "string" && config.loopbackAuthToken.length > 0) {
      return HttpRouter.middleware(
        HttpMiddleware.cors({
          allowedOrigins: makeBrowserOriginPredicate(config),
          allowedMethods: browserApiCorsAllowedMethods,
          allowedHeaders: browserApiCorsAllowedHeaders,
          credentials: devOrigin !== undefined,
          maxAge: 600,
        }),
        { global: true },
      );
    }
    return HttpRouter.cors({
      ...(devOrigin
        ? { allowedOrigins: [devOrigin, ...DESKTOP_RENDERER_ORIGINS], credentials: true }
        : {}),
      allowedMethods: browserApiCorsAllowedMethods,
      allowedHeaders: browserApiCorsAllowedHeaders,
      maxAge: 600,
    });
  }),
);

export const makeBrowserOriginPredicate =
  (config: Pick<ServerConfig.ServerConfig["Service"], "devUrl" | "publicOrigins">) =>
  (origin: string): boolean => {
    if (origin === config.devUrl?.origin || DESKTOP_RENDERER_ORIGINS.includes(origin)) return true;
    if ((config.publicOrigins ?? []).includes(origin)) return true;
    try {
      const url = new URL(origin);
      return (
        (url.protocol === "http:" || url.protocol === "https:") && isLoopbackHostname(url.hostname)
      );
    } catch {
      return false;
    }
  };

export function isLoopbackHostname(hostname: string): boolean {
  const normalizedHostname = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  return LOOPBACK_HOSTNAMES.has(normalizedHostname);
}

export function resolveDevRedirectUrl(devUrl: URL, requestUrl: URL): string {
  const redirectUrl = new URL(devUrl.toString());
  redirectUrl.pathname = requestUrl.pathname;
  redirectUrl.search = requestUrl.search;
  redirectUrl.hash = requestUrl.hash;
  return redirectUrl.toString();
}

export const serverEnvironmentHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "metadata",
  Effect.fnUntraced(function* (handlers) {
    const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
    const wslBearerAuth = yield* WslBearerAuth.WslBearerAuth;
    return handlers.handle(
      "descriptor",
      Effect.fn("environment.metadata.descriptor")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        yield* wslBearerAuth.authorizeHttpRequest;
        return yield* serverEnvironment.getDescriptor;
      }),
    );
  }),
);

const payloadTooLargeResponse = HttpServerResponse.text("Payload too large.", {
  status: 413,
  headers: { connection: "close" },
});

class OtlpTracesBodyTooLargeError extends Data.TaggedError("OtlpTracesBodyTooLargeError")<{
  readonly maxBytes: number;
}> {}

class OtlpTracesBodyInvalidError extends Data.TaggedError("OtlpTracesBodyInvalidError")<{
  readonly reason: "invalid_json";
}> {}

class DecodeOtlpTraceRecordsError extends Data.TaggedError("DecodeOtlpTraceRecordsError")<{
  readonly cause: unknown;
}> {}

const readBoundedRequestText = (request: HttpServerRequest.HttpServerRequest, maxBytes: number) =>
  Effect.gen(function* () {
    const decoder = new TextDecoder();
    let received = 0;
    let text = "";
    yield* Stream.runForEach(request.stream, (chunk) => {
      received += chunk.byteLength;
      if (received > maxBytes) {
        return Effect.fail(new OtlpTracesBodyTooLargeError({ maxBytes }));
      }
      text += decoder.decode(chunk, { stream: true });
      return Effect.void;
    });
    return text + decoder.decode();
  });

export const otlpTracesProxyRouteLayer = HttpRouter.add(
  "POST",
  OTLP_TRACES_PROXY_PATH,
  Effect.gen(function* () {
    const wslBearerAuth = yield* WslBearerAuth.WslBearerAuth;
    yield* wslBearerAuth.authorizeHttpRequest;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* ServerConfig.ServerConfig;
    const otlpTracesUrl = config.otlpTracesUrl;
    const browserTraceCollector = yield* BrowserTraceCollector.BrowserTraceCollector;
    const httpClient = yield* HttpClient.HttpClient;
    const declaredLength = Number(
      Headers.get(request.headers, "content-length").pipe(Option.getOrUndefined),
    );
    if (Number.isFinite(declaredLength) && declaredLength > OTLP_TRACES_MAX_BODY_BYTES) {
      return payloadTooLargeResponse;
    }
    const bodyText = yield* readBoundedRequestText(request, OTLP_TRACES_MAX_BODY_BYTES);
    const bodyJson = yield* Effect.try({
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      try: () => (bodyText === "" ? null : JSON.parse(bodyText)),
      catch: () => new OtlpTracesBodyInvalidError({ reason: "invalid_json" }),
    }).pipe(Effect.map((parsed) => cast<unknown, OtlpTracer.TraceData>(parsed)));

    yield* Effect.try({
      try: () => decodeOtlpTraceRecords(bodyJson),
      catch: (cause) => new DecodeOtlpTraceRecordsError({ cause }),
    }).pipe(
      Effect.flatMap((records) => browserTraceCollector.record(records)),
      Effect.catch((error) =>
        Effect.logWarning("Failed to decode browser OTLP traces", {
          errorName: error.cause instanceof Error ? error.cause.name : "unknown",
          bodyBytes: bodyText.length,
        }),
      ),
    );

    if (otlpTracesUrl === undefined) {
      return HttpServerResponse.empty({ status: 204 });
    }

    return yield* httpClient
      .post(otlpTracesUrl, {
        body: HttpBody.jsonUnsafe(bodyJson),
      })
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.as(HttpServerResponse.empty({ status: 204 })),
        Effect.tapError((cause) =>
          Effect.logWarning("Failed to export browser OTLP traces", {
            reason: cause.reason._tag,
            status: cause.response?.status,
            otlpTracesUrl,
          }),
        ),
        Effect.orElseSucceed(() =>
          HttpServerResponse.text("Trace export failed.", { status: 502 }),
        ),
      );
  }).pipe(
    Effect.catchTags({
      EnvironmentWslBearerInvalidError: HttpServerRespondable.toResponse,
      OtlpTracesBodyTooLargeError: () => Effect.succeed(payloadTooLargeResponse),
      OtlpTracesBodyInvalidError: () =>
        Effect.succeed(HttpServerResponse.text("Invalid JSON.", { status: 400 })),
    }),
  ),
);

const ASSET_BASE_HEADERS = {
  "Cache-Control": "private, max-age=3600",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
} as const;

export function assetResponseHeaders(filePath: string): Record<string, string> {
  const dot = filePath.lastIndexOf(".");
  const extension = dot < 0 ? "" : filePath.slice(dot).toLowerCase();
  if (extension === ".pdf") return { ...ASSET_BASE_HEADERS };
  if (extension === ".html" || extension === ".htm") {
    return {
      ...ASSET_BASE_HEADERS,
      "Content-Security-Policy": "sandbox",
      "Content-Disposition": "attachment",
    };
  }
  if (extension === ".svg") {
    return {
      ...ASSET_BASE_HEADERS,
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Disposition": "attachment",
    };
  }
  return { ...ASSET_BASE_HEADERS, "Content-Security-Policy": "default-src 'none'; sandbox" };
}

export function inlineScriptHashes(html: string): ReadonlyArray<string> {
  const hashes: Array<string> = [];
  for (const match of html.matchAll(/<script(?![^>]*\ssrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    const source = match[1] ?? "";
    if (source.trim().length === 0) continue;
    hashes.push(
      `'sha256-${NodeCrypto.createHash("sha256").update(source, "utf8").digest("base64")}'`,
    );
  }
  return hashes;
}

export function appShellContentSecurityPolicy(scriptHashes: ReadonlyArray<string>): string {
  return [
    "default-src 'self'",
    ["script-src 'self' 'wasm-unsafe-eval'", ...scriptHashes].join(" "),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https: http:",
    "font-src 'self' data:",
    "connect-src 'self' ws: wss: https: http:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

const STATIC_BASE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
} as const;

export const appShellHeaders = (html: string): Record<string, string> => ({
  ...STATIC_BASE_HEADERS,
  "Content-Security-Policy": appShellContentSecurityPolicy(inlineScriptHashes(html)),
  "X-Frame-Options": "DENY",
});

export const assetRouteLayer = HttpRouter.add(
  "GET",
  `${ASSET_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const suffix = url.value.pathname.slice(`${ASSET_ROUTE_PREFIX}/`.length);
    const separatorIndex = suffix.indexOf("/");
    if (separatorIndex <= 0) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    const asset = yield* resolveAsset(
      suffix.slice(0, separatorIndex),
      suffix.slice(separatorIndex + 1),
    );
    if (!asset) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    return yield* HttpServerResponse.file(asset.path, {
      status: 200,
      headers: assetResponseHeaders(asset.path),
    }).pipe(
      Effect.orElseSucceed(() => HttpServerResponse.text("Internal Server Error", { status: 500 })),
    );
  }),
);

export const staticAndDevRouteLayer = HttpRouter.add(
  "GET",
  "*",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);

    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const config = yield* ServerConfig.ServerConfig;
    if (config.devUrl && isLoopbackHostname(url.value.hostname)) {
      return HttpServerResponse.redirect(resolveDevRedirectUrl(config.devUrl, url.value), {
        status: 302,
      });
    }

    const staticDir =
      config.staticDir ?? (config.devUrl ? yield* ServerConfig.resolveStaticDir() : undefined);
    if (!staticDir) {
      return HttpServerResponse.text("No static directory configured and no dev URL set.", {
        status: 503,
      });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const staticRoot = path.resolve(staticDir);
    const staticRequestPath = url.value.pathname === "/" ? "/index.html" : url.value.pathname;
    const rawStaticRelativePath = staticRequestPath.replace(/^[/\\]+/, "");
    const hasRawLeadingParentSegment = rawStaticRelativePath.startsWith("..");
    const staticRelativePath = path.normalize(rawStaticRelativePath).replace(/^[/\\]+/, "");
    const hasPathTraversalSegment = staticRelativePath.startsWith("..");
    if (
      staticRelativePath.length === 0 ||
      hasRawLeadingParentSegment ||
      hasPathTraversalSegment ||
      staticRelativePath.includes("\0")
    ) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const isWithinStaticRoot = (candidate: string) =>
      candidate === staticRoot ||
      candidate.startsWith(staticRoot.endsWith(path.sep) ? staticRoot : `${staticRoot}${path.sep}`);

    let filePath = path.resolve(staticRoot, staticRelativePath);
    if (!isWithinStaticRoot(filePath)) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const ext = path.extname(filePath);
    if (!ext) {
      filePath = path.resolve(filePath, "index.html");
      if (!isWithinStaticRoot(filePath)) {
        return HttpServerResponse.text("Invalid static file path", { status: 400 });
      }
    }

    const fileInfo = yield* fileSystem.stat(filePath).pipe(Effect.orElseSucceed(() => null));
    if (!fileInfo || fileInfo.type !== "File") {
      const indexPath = path.resolve(staticRoot, "index.html");
      const indexData = yield* fileSystem
        .readFile(indexPath)
        .pipe(Effect.orElseSucceed(() => null));
      if (!indexData) {
        return HttpServerResponse.text("Not Found", { status: 404 });
      }
      return HttpServerResponse.uint8Array(indexData, {
        status: 200,
        contentType: "text/html; charset=utf-8",
        headers: appShellHeaders(new TextDecoder().decode(indexData)),
      });
    }

    const contentType = Mime.getType(filePath) ?? "application/octet-stream";
    const data = yield* fileSystem.readFile(filePath).pipe(Effect.orElseSucceed(() => null));
    if (!data) {
      return HttpServerResponse.text("Internal Server Error", { status: 500 });
    }

    if (contentType.startsWith("text/html")) {
      return HttpServerResponse.uint8Array(data, {
        status: 200,
        contentType,
        headers: appShellHeaders(new TextDecoder().decode(data)),
      });
    }

    return HttpServerResponse.uint8Array(data, {
      status: 200,
      contentType,
      headers: { ...STATIC_BASE_HEADERS },
    });
  }),
);
