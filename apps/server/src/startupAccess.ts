import * as NodeOS from "node:os";

import * as Effect from "effect/Effect";
import { HttpServer } from "effect/unstable/http";

import type { AccessTokenSource } from "./accessToken.ts";
import { ServerConfig } from "./config.ts";

export interface HeadlessServeAccessInfo {
  readonly connectionString: string;
  readonly accessTokenSource: AccessTokenSource | undefined;
  readonly accessTokenFilePath: string | undefined;
}

type NetworkInterfacesMap = ReturnType<typeof NodeOS.networkInterfaces>;

export const isLoopbackHost = (host: string | undefined): boolean => {
  if (!host || host.length === 0) {
    return true;
  }

  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host.startsWith("127.")
  );
};

export const isWildcardHost = (host: string | undefined): boolean =>
  host === "0.0.0.0" || host === "::" || host === "[::]";

export const formatHostForUrl = (host: string): string =>
  host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;

const normalizeHost = (host: string): string =>
  host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

const isIpv4Family = (family: string | number): boolean => family === "IPv4" || family === 4;

const isIpv6Family = (family: string | number): boolean => family === "IPv6" || family === 6;

export const resolveHeadlessConnectionHost = (
  host: string | undefined,
  interfaces: NetworkInterfacesMap = NodeOS.networkInterfaces(),
): string => {
  if (!host) {
    return "localhost";
  }

  if (!isWildcardHost(host)) {
    return normalizeHost(host);
  }

  const interfaceEntries = Object.values(interfaces).flatMap((entries) => entries ?? []);
  const externalIpv4 = interfaceEntries.find(
    (entry) => !entry.internal && isIpv4Family(entry.family),
  );
  if (externalIpv4) {
    return externalIpv4.address;
  }

  const externalIpv6 = interfaceEntries.find(
    (entry) => !entry.internal && isIpv6Family(entry.family),
  );
  return externalIpv6 ? normalizeHost(externalIpv6.address) : "localhost";
};

export const resolveHeadlessConnectionString = (
  host: string | undefined,
  port: number,
  interfaces: NetworkInterfacesMap = NodeOS.networkInterfaces(),
): string => {
  const connectionHost = resolveHeadlessConnectionHost(host, interfaces);
  return `http://${formatHostForUrl(connectionHost)}:${port}`;
};

export const resolveListeningPort = (address: unknown, fallbackPort: number): number => {
  if (
    typeof address === "object" &&
    address !== null &&
    "port" in address &&
    typeof address.port === "number"
  ) {
    return address.port;
  }
  return fallbackPort;
};

export const formatHeadlessServeOutput = (accessInfo: HeadlessServeAccessInfo): string => {
  const lines = ["Neokod server is ready.", `Local URL: ${accessInfo.connectionString}`];
  if (accessInfo.accessTokenSource !== undefined) {
    const filePath = accessInfo.accessTokenFilePath;
    const sourceLine =
      accessInfo.accessTokenSource === "generated" && filePath !== undefined
        ? `generated and stored in ${filePath} (mode 0600)`
        : accessInfo.accessTokenSource === "default-file" && filePath !== undefined
          ? `stored in ${filePath}`
          : accessInfo.accessTokenSource === "flag-file" && filePath !== undefined
            ? `read from ${filePath}`
            : "from NEOKOD_ACCESS_TOKEN";
    lines.push(`Access token: ${sourceLine}`);
    lines.push(
      `Open the URL and paste the token when asked.${filePath !== undefined ? ` Read it with: cat ${filePath}` : ""}`,
    );
  }
  return lines.join("\n");
};

export const issueHeadlessServeAccessInfo = Effect.fn("issueHeadlessServeAccessInfo")(function* () {
  const serverConfig = yield* ServerConfig;
  const httpServer = yield* HttpServer.HttpServer;
  const connectionString = resolveHeadlessConnectionString(
    serverConfig.host,
    resolveListeningPort(httpServer.address, serverConfig.port),
  );
  return {
    connectionString,
    accessTokenSource: serverConfig.accessTokenSource,
    accessTokenFilePath: serverConfig.accessTokenFilePath,
  } satisfies HeadlessServeAccessInfo;
});
