/**
 * Host and Origin validation for incoming connections.
 *
 * The server binds loopback and, on the loopback transport, authenticates
 * nothing: `WslBearerAuth` returns immediately for both the bearer header and
 * the WebSocket ticket. That is safe only while the peer really is local.
 *
 * DNS rebinding breaks that assumption without touching the server. A page the
 * user visits at `evil.example` repoints that hostname at `127.0.0.1`, then
 * opens a socket to it. The browser connects to our loopback listener and
 * sends `Host: evil.example`, and every authorization gate passes.
 *
 * Comparing `Origin` against `Host` does NOT stop this, which is worth stating
 * because it is the obvious first idea: the attacker's page is genuinely served
 * from `evil.example`, so it sends `Origin: http://evil.example` and
 * `Host: evil.example`, and the two agree. The check passes and the attack
 * succeeds.
 *
 * A legitimate reverse proxy and a rebinding attack are also identical at the
 * socket level: both arrive on loopback carrying a non-loopback `Host`. Nothing
 * observable separates them, so the only sound rule is an allowlist of the
 * hostnames the operator says are theirs. Loopback is allowed implicitly;
 * anything else has to be named.
 */

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

function normalizeHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
}

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(normalizeHostname(hostname));
}

/** Hostname of a `Host` header value, which carries no scheme. */
export function hostnameFromHostHeader(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  // `URL` needs a scheme, and it also gives us correct IPv6 bracket handling.
  try {
    return normalizeHostname(new URL(`http://${trimmed}`).hostname);
  } catch {
    return null;
  }
}

/** Hostname of an `Origin` header value, which carries one. */
export function hostnameFromOriginHeader(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed === "null") return null;
  try {
    return normalizeHostname(new URL(trimmed).hostname);
  } catch {
    return null;
  }
}

/**
 * Parses the operator's allowlist. Accepts full origins or bare hostnames, so
 * `https://neokod.example.com` and `neokod.example.com` both work; only the
 * hostname is compared, because the proxy terminates TLS and the scheme it
 * forwards is not ours to predict.
 */
export function parseAllowedOrigins(raw: string | undefined): ReadonlySet<string> {
  const allowed = new Set<string>();
  for (const entry of (raw ?? "").split(",")) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    const hostname = trimmed.includes("://")
      ? hostnameFromOriginHeader(trimmed)
      : hostnameFromHostHeader(trimmed);
    if (hostname !== null) allowed.add(hostname);
  }
  return allowed;
}

export type OriginDecision =
  | { readonly _tag: "Allowed" }
  | { readonly _tag: "Rejected"; readonly hostname: string; readonly header: "Host" | "Origin" };

/**
 * A request is allowed when every hostname it claims is either loopback or
 * explicitly allowlisted.
 *
 * A missing `Host` is rejected: HTTP/1.1 requires it, and a browser always
 * sends one, so its absence is not a case worth being permissive about.
 *
 * A missing `Origin` is allowed. Non-browser clients (the CLI, curl, a health
 * check) do not send one, and they are not the threat here: the attack depends
 * on a browser being tricked into making the request. `Host` still has to pass.
 */
export function decideOrigin(input: {
  readonly host: string | undefined;
  readonly origin: string | undefined;
  readonly allowedOrigins: ReadonlySet<string>;
}): OriginDecision {
  const hostHostname = input.host === undefined ? null : hostnameFromHostHeader(input.host);
  if (hostHostname === null) {
    return { _tag: "Rejected", hostname: input.host ?? "", header: "Host" };
  }
  if (!isLoopbackHostname(hostHostname) && !input.allowedOrigins.has(hostHostname)) {
    return { _tag: "Rejected", hostname: hostHostname, header: "Host" };
  }

  if (input.origin !== undefined) {
    const originHostname = hostnameFromOriginHeader(input.origin);
    // An unparseable or opaque Origin ("null", as sent from a sandboxed frame)
    // is not evidence of a local peer, so it does not get the benefit of the
    // absent-Origin allowance.
    if (originHostname === null) {
      return { _tag: "Rejected", hostname: input.origin, header: "Origin" };
    }
    if (!isLoopbackHostname(originHostname) && !input.allowedOrigins.has(originHostname)) {
      return { _tag: "Rejected", hostname: originHostname, header: "Origin" };
    }
  }

  return { _tag: "Allowed" };
}

export function rejectionMessage(decision: Extract<OriginDecision, { _tag: "Rejected" }>): string {
  return [
    `Refused a connection whose ${decision.header} is '${decision.hostname}'.`,
    "Neokod only accepts loopback, plus hostnames you list explicitly.",
    "If you reach this server through a reverse proxy, set NEOKOD_PUBLIC_ORIGIN",
    `to its public origin, for example NEOKOD_PUBLIC_ORIGIN=https://${decision.hostname}`,
  ].join(" ");
}
