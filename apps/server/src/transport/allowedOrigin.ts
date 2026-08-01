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
 * origins the operator says are theirs. Loopback is allowed implicitly;
 * anything else has to be named.
 *
 * Two rules follow from review findings against the first version of this
 * module:
 *
 * 1. The allowlist compares complete origins, not hostnames. Cookies are not
 *    port-scoped, so `https://neokod.example.com` must not also admit
 *    `http://neokod.example.com` or `https://neokod.example.com:8443`;
 *    attacker-controlled content on another port of the same host would
 *    otherwise reach the RPC surface with the proxy's cookies attached. Every
 *    comparison uses normalized scheme, hostname, and effective port.
 *
 * 2. Header values are validated against strict Host / serialized-origin
 *    grammar BEFORE any normalization. `new URL()` accepts syntax the header
 *    grammar forbids and normalizes it dangerously: `evil.example@localhost`
 *    parses with hostname `localhost`, and IDNA mapping turns homographs such
 *    as U+217C into ASCII `l`, so `ⅼocalhost` would become `localhost`.
 *    Anything that is not plain ASCII authority syntax is rejected outright.
 */

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

/**
 * Origins of the Electron renderer's privileged custom schemes. The desktop
 * page is served from these, so its direct WebSocket upgrade to the loopback
 * server carries them as `Origin`. A web page cannot forge them: a browser
 * derives `Origin` from the page's real URL, and web pages only exist on
 * http(s), so a rebinding page can only ever present an http(s) origin.
 * `Host` is still validated for these requests.
 */
export const DESKTOP_RENDERER_ORIGINS: ReadonlyArray<string> = ["neokod://app", "neokod-dev://app"];

/**
 * Strict grammar, applied before any normalization.
 *
 * A hostname is a dot-separated sequence of ASCII letter/digit/hyphen labels
 * (RFC 9112 `uri-host` restricted to what real hostnames use; the exotic
 * `reg-name` characters like `!$&'()*+,;=` and percent-escapes never appear in
 * legitimate traffic and only widen the attack surface, so they fail closed).
 * This rejects userinfo (`@`), paths (`/`), queries (`?`), fragments (`#`),
 * comma-folded duplicate header values, whitespace, non-ASCII homographs,
 * leading/trailing dots, and empty labels. Punycode `xn--` labels pass as the
 * ASCII names they are and match nothing unless explicitly allowlisted.
 */
const HOSTNAME_PATTERN = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/;
/** Inside brackets only; requires at least one colon so `[foo]` cannot pass. */
const IPV6_PATTERN = /^[0-9a-f:.]+$/;
const PORT_PATTERN = /^[0-9]{1,5}$/;
/** scheme "://" authority, per the RFC 6454 serialized-origin shape. */
const SERIALIZED_ORIGIN_PATTERN = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(.+)$/;

interface HostAuthority {
  readonly hostname: string;
  /** Explicit port, or null when the header omitted it. */
  readonly port: number | null;
}

interface ParsedOrigin {
  readonly scheme: string;
  readonly hostname: string;
  readonly port: number | null;
}

/** Trim only the optional whitespace HTTP allows around header values. */
function trimHeaderValue(value: string): string {
  return value.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
}

function parseStrictHostname(raw: string): string | null {
  const lowered = raw.toLowerCase();
  if (lowered.startsWith("[")) {
    if (!lowered.endsWith("]")) return null;
    const inner = lowered.slice(1, -1);
    if (!inner.includes(":") || !IPV6_PATTERN.test(inner)) return null;
    // Compare unbracketed, matching the loopback set's `::1`.
    return inner;
  }
  return HOSTNAME_PATTERN.test(lowered) ? lowered : null;
}

/** Parses an RFC 9112 `Host` value: `uri-host [":" port]`, nothing else. */
export function parseHostAuthority(value: string): HostAuthority | null {
  const trimmed = trimHeaderValue(value);
  if (trimmed.length === 0) return null;
  // Reject anything outside printable ASCII before it can reach normalization.
  if (!/^[\x21-\x7e]+$/.test(trimmed)) return null;

  let hostPart: string;
  let portPart: string | null = null;
  if (trimmed.startsWith("[")) {
    const closingBracket = trimmed.indexOf("]");
    if (closingBracket === -1) return null;
    hostPart = trimmed.slice(0, closingBracket + 1);
    const rest = trimmed.slice(closingBracket + 1);
    if (rest.length > 0) {
      if (!rest.startsWith(":")) return null;
      portPart = rest.slice(1);
    }
  } else {
    const colon = trimmed.indexOf(":");
    if (colon === -1) {
      hostPart = trimmed;
    } else {
      hostPart = trimmed.slice(0, colon);
      portPart = trimmed.slice(colon + 1);
      // A second colon means an unbracketed IPv6 literal, which the Host
      // grammar forbids.
      if (portPart.includes(":")) return null;
    }
  }

  const hostname = parseStrictHostname(hostPart);
  if (hostname === null) return null;
  if (portPart === null) return { hostname, port: null };
  if (!PORT_PATTERN.test(portPart)) return null;
  const port = Number(portPart);
  if (port < 1 || port > 65535) return null;
  return { hostname, port };
}

/** Parses an RFC 6454 serialized origin: `scheme "://" host [":" port]`. */
export function parseSerializedOrigin(value: string): ParsedOrigin | null {
  const trimmed = trimHeaderValue(value);
  // "null" (the opaque origin of a sandboxed frame) is not a parseable origin
  // and must not be confused with an absent header.
  const match = SERIALIZED_ORIGIN_PATTERN.exec(trimmed);
  if (match === null) return null;
  const rawScheme = match[1];
  const rawAuthority = match[2];
  if (rawScheme === undefined || rawAuthority === undefined) return null;
  const authority = parseHostAuthority(rawAuthority);
  if (authority === null) return null;
  return { scheme: rawScheme.toLowerCase(), hostname: authority.hostname, port: authority.port };
}

function defaultPortForScheme(scheme: string): number | null {
  switch (scheme) {
    case "http":
    case "ws":
      return 80;
    case "https":
    case "wss":
      return 443;
    default:
      return null;
  }
}

/**
 * Canonical comparison key: scheme, hostname, and effective port. Origins that
 * differ only in default-port spelling (`https://h` vs `https://h:443`)
 * produce the same key; everything else stays distinct.
 */
function originKeyOf(origin: ParsedOrigin): string {
  const port = origin.port ?? defaultPortForScheme(origin.scheme);
  return port === null
    ? `${origin.scheme}://${origin.hostname}`
    : `${origin.scheme}://${origin.hostname}:${port}`;
}

function formatHostAuthority(authority: HostAuthority): string {
  const host = authority.hostname.includes(":") ? `[${authority.hostname}]` : authority.hostname;
  return authority.port === null ? host : `${host}:${authority.port}`;
}

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(
    hostname
      .trim()
      .toLowerCase()
      .replace(/^\[(.*)\]$/, "$1"),
  );
}

/**
 * Parses the operator's allowlist into canonical origin keys.
 *
 * Entries are complete origins (`https://neokod.example.com:8443`). A bare
 * hostname carries no scheme and is therefore ambiguous; treating it as both
 * schemes would re-open the port/scheme hole this allowlist exists to close.
 * The deliberate choice is to default a bare hostname to `https` with its
 * default port, because a reverse proxy that needs this setting terminates TLS
 * in every supported deployment. An operator who really serves plain http must
 * write `http://` explicitly.
 *
 * Entries that fail strict origin grammar are dropped rather than raised: this
 * runs inside pure config parsing with nowhere to surface an error, dropping
 * fails closed, and the runtime rejection message tells the operator the exact
 * value to set. One trailing slash is tolerated because pasting
 * `https://host/` is common and unambiguous.
 */
export function parseAllowedOrigins(raw: string | undefined): ReadonlySet<string> {
  const allowed = new Set<string>();
  for (const entry of (raw ?? "").split(",")) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    const withoutTrailingSlash = trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
    const candidate = withoutTrailingSlash.includes("://")
      ? withoutTrailingSlash
      : `https://${withoutTrailingSlash}`;
    const parsed = parseSerializedOrigin(candidate);
    if (parsed !== null) allowed.add(originKeyOf(parsed));
  }
  return allowed;
}

export type OriginDecision =
  | { readonly _tag: "Allowed" }
  | { readonly _tag: "Rejected"; readonly value: string; readonly header: "Host" | "Origin" };

/**
 * `Host` carries no scheme, so it is compared as an authority: the hostname
 * must match an allowed origin exactly, and the port must match that origin's
 * effective port. A portless `Host` means the scheme-default port and only
 * matches an origin listening on its scheme's default.
 */
function hostMatchesAllowedOrigin(
  host: HostAuthority,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  for (const key of allowedOrigins) {
    const origin = parseSerializedOrigin(key);
    if (origin === null || origin.hostname !== host.hostname) continue;
    const effectivePort = origin.port ?? defaultPortForScheme(origin.scheme);
    if (host.port === null) {
      if (effectivePort !== null && effectivePort === defaultPortForScheme(origin.scheme)) {
        return true;
      }
    } else if (host.port === effectivePort) {
      return true;
    }
  }
  return false;
}

/**
 * A request is allowed when everything it claims is either loopback or
 * explicitly allowlisted. Loopback needs no configuration: any port and, for
 * `Origin`, any scheme, because a page served from loopback is already local.
 *
 * A missing `Host` is rejected: HTTP/1.1 requires it, and a browser always
 * sends one, so its absence is not a case worth being permissive about.
 *
 * A missing `Origin` is allowed. Non-browser clients (the CLI, curl, a health
 * check) do not send one, and they are not the threat here: the attack depends
 * on a browser being tricked into making the request. `Host` still has to
 * pass, which is what stops the same-origin rebinding page whose fetches
 * carry no `Origin` at all.
 */
export function decideOrigin(input: {
  readonly host: string | undefined;
  readonly origin: string | undefined;
  readonly allowedOrigins: ReadonlySet<string>;
}): OriginDecision {
  const hostAuthority = input.host === undefined ? null : parseHostAuthority(input.host);
  if (hostAuthority === null) {
    return { _tag: "Rejected", value: input.host ?? "", header: "Host" };
  }
  if (
    !LOOPBACK_HOSTNAMES.has(hostAuthority.hostname) &&
    !hostMatchesAllowedOrigin(hostAuthority, input.allowedOrigins)
  ) {
    return { _tag: "Rejected", value: formatHostAuthority(hostAuthority), header: "Host" };
  }

  if (input.origin !== undefined) {
    const origin = parseSerializedOrigin(input.origin);
    // An unparseable or opaque Origin ("null", as sent from a sandboxed frame)
    // is not evidence of a local peer, so it does not get the benefit of the
    // absent-Origin allowance.
    if (origin === null) {
      return { _tag: "Rejected", value: input.origin, header: "Origin" };
    }
    if (
      !LOOPBACK_HOSTNAMES.has(origin.hostname) &&
      !input.allowedOrigins.has(originKeyOf(origin))
    ) {
      return { _tag: "Rejected", value: originKeyOf(origin), header: "Origin" };
    }
  }

  return { _tag: "Allowed" };
}

/**
 * The gate every transport entry point uses: `decideOrigin` with the desktop
 * renderer allowance applied. The renderer's privileged custom-scheme origin,
 * which no web page can present (see DESKTOP_RENDERER_ORIGINS), is treated
 * like the absent Origin of a non-browser client: trusted as a sender, with
 * its Host still validated.
 */
export function decideRequestOrigin(input: {
  readonly host: string | undefined;
  readonly origin: string | undefined;
  readonly allowedOrigins: ReadonlySet<string>;
}): OriginDecision {
  const origin =
    input.origin !== undefined && DESKTOP_RENDERER_ORIGINS.includes(input.origin)
      ? undefined
      : input.origin;
  return decideOrigin({ host: input.host, origin, allowedOrigins: input.allowedOrigins });
}

export function rejectionMessage(decision: Extract<OriginDecision, { _tag: "Rejected" }>): string {
  const suggestion = decision.value.includes("://") ? decision.value : `https://${decision.value}`;
  return [
    `Refused a connection whose ${decision.header} is '${decision.value}'.`,
    "Neokod only accepts loopback, plus origins you list explicitly.",
    "If you reach this server through a reverse proxy, set NEOKOD_PUBLIC_ORIGIN",
    `to its public origin, for example NEOKOD_PUBLIC_ORIGIN=${suggestion}`,
  ].join(" ");
}
