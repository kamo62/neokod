import { expect, it } from "@effect/vitest";

import {
  formatHeadlessServeOutput,
  resolveHeadlessConnectionHost,
  resolveHeadlessConnectionString,
  resolveListeningPort,
} from "./startupAccess.ts";

it("formats headless serve output with the Neokod heading and local URL", () => {
  expect(
    formatHeadlessServeOutput({
      connectionString: "http://localhost:3773",
      accessTokenSource: undefined,
      accessTokenFilePath: undefined,
    }),
  ).toBe("Neokod server is ready.\nLocal URL: http://localhost:3773");
});

it("names the token source without ever printing the token", () => {
  const output = formatHeadlessServeOutput({
    connectionString: "http://localhost:3773",
    accessTokenSource: "generated",
    accessTokenFilePath: "/tmp/x/access-token",
  });
  expect(output).toBe(
    [
      "Neokod server is ready.",
      "Local URL: http://localhost:3773",
      "Access token: generated and stored in /tmp/x/access-token (mode 0600)",
      "Open the URL and paste the token when asked. Read it with: cat /tmp/x/access-token",
    ].join("\n"),
  );
  expect(output).not.toContain("sample-token-never-printed");
});

it("prefers localhost when no explicit host is configured", () => {
  expect(resolveHeadlessConnectionHost(undefined)).toBe("localhost");
  expect(resolveHeadlessConnectionString(undefined, 3773)).toBe("http://localhost:3773");
});

it("keeps explicit bind hosts in the connection string", () => {
  expect(resolveHeadlessConnectionString("127.0.0.1", 3773)).toBe("http://127.0.0.1:3773");
  expect(resolveHeadlessConnectionString("::1", 3773)).toBe("http://[::1]:3773");
});

it("resolves wildcard hosts to a concrete external interface when one is available", () => {
  const connectionString = resolveHeadlessConnectionString("0.0.0.0", 3773, {
    en0: [
      {
        address: "192.168.1.42",
        netmask: "255.255.255.0",
        family: "IPv4",
        mac: "00:00:00:00:00:00",
        internal: false,
        cidr: "192.168.1.42/24",
      },
    ],
    lo0: [
      {
        address: "127.0.0.1",
        netmask: "255.0.0.0",
        family: "IPv4",
        mac: "00:00:00:00:00:00",
        internal: true,
        cidr: "127.0.0.1/8",
      },
    ],
  });

  expect(connectionString).toBe("http://192.168.1.42:3773");
});

it("prefers the actual bound port when an http server address is available", () => {
  expect(resolveListeningPort({ port: 4123 }, 3773)).toBe(4123);
  expect(resolveListeningPort("pipe", 3773)).toBe(3773);
  expect(resolveListeningPort(null, 3773)).toBe(3773);
});
