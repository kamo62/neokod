/**
 * Primary access token for the browser client.
 *
 * Storage decision: `localStorage` under ACCESS_TOKEN_STORAGE_KEY plus an
 * in-memory copy. Every read site is synchronous
 * (`readPrimaryEnvironmentTarget` runs on each poll and on each HTTP
 * request), and IndexedDB is asynchronous. `sessionStorage` would force
 * re-entry on every new tab and browser restart, which defeats a stable
 * token. A cookie would add CSRF exposure. The residual risk is that any XSS
 * on the UI origin can read the token, which is the same exposure as
 * IndexedDB; this is documented, not mitigated. The token is per origin by
 * construction of `localStorage`.
 */
import { resolvePrimaryEnvironmentHttpUrl } from "./target";

export const ACCESS_TOKEN_STORAGE_KEY = "neokod:primary-access-token:v1";

export type PrimaryAccessTokenCheck = "accepted" | "rejected" | "unreachable";
export type PrimaryAccessGate = "unknown" | "ok" | "required" | "rejected";

let memoryToken: string | undefined;
let initialized = false;
let gate: PrimaryAccessGate = "unknown";
const tokenListeners = new Set<() => void>();
const gateListeners = new Set<() => void>();

function notify(listeners: ReadonlySet<() => void>): void {
  for (const listener of listeners) {
    listener();
  }
}

function readStoredToken(): string | undefined {
  try {
    if (typeof localStorage === "undefined") return undefined;
    return localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function writeStoredToken(token: string): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, token);
  } catch {
    // Storage can be unavailable (private mode, blocked cookies). The
    // in-memory copy keeps this tab working.
  }
}

function removeStoredToken(): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY);
  } catch {
    // Same as above: the in-memory copy is the source of truth for this tab.
  }
}

function isDesktopWindow(): boolean {
  return (
    typeof window !== "undefined" &&
    (window as { desktopBridge?: unknown }).desktopBridge !== undefined
  );
}

function stripTokenFromAddress(url: URL, queryKey: string | null, fragmentKey: boolean): void {
  if (typeof window === "undefined" || typeof window.history?.replaceState !== "function") return;
  if (queryKey !== null) url.searchParams.delete(queryKey);
  if (fragmentKey) {
    const params = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
    params.delete("access-token");
    const rest = params.toString();
    url.hash = rest.length > 0 ? `#${rest}` : "";
  }
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

/**
 * Read the token from the page address once per address change and load the
 * stored token on first run. Idempotent and safe without `window`. The
 * desktop shell supplies its own credential through the bootstrap, so URL
 * and storage are ignored there.
 */
export function initializePrimaryAccessToken(): void {
  if (typeof window === "undefined" || isDesktopWindow()) return;
  const href = typeof window.location?.href === "string" ? window.location.href : undefined;
  if (href !== undefined) {
    const url = new URL(href);
    const queryToken = url.searchParams.get("loopbackAuthToken");
    const fragmentParams = new URLSearchParams(
      url.hash.startsWith("#") ? url.hash.slice(1) : url.hash,
    );
    const fragmentToken = fragmentParams.get("access-token");
    const urlToken =
      queryToken !== null && queryToken.length > 0
        ? { value: queryToken, queryKey: "loopbackAuthToken" as const, fragmentKey: false }
        : fragmentToken !== null && fragmentToken.length > 0
          ? { value: fragmentToken, queryKey: null, fragmentKey: true }
          : undefined;
    if (urlToken !== undefined) {
      storePrimaryAccessToken(urlToken.value);
      stripTokenFromAddress(url, urlToken.queryKey, urlToken.fragmentKey);
      initialized = true;
      return;
    }
  }
  if (!initialized) {
    initialized = true;
    const stored = readStoredToken();
    if (stored !== undefined && stored.length > 0) {
      memoryToken = stored;
    }
  }
}

/** Calls initialize first, so a freshly loaded page picks up URL and storage. */
export function readPrimaryAccessToken(): string | undefined {
  initializePrimaryAccessToken();
  return memoryToken;
}

/** Trims, ignores empty values, persists to storage and notifies subscribers. */
export function storePrimaryAccessToken(token: string): void {
  const trimmed = token.trim();
  if (trimmed.length === 0) return;
  memoryToken = trimmed;
  writeStoredToken(trimmed);
  notify(tokenListeners);
}

export function clearPrimaryAccessToken(): void {
  memoryToken = undefined;
  removeStoredToken();
  notify(tokenListeners);
}

export function subscribePrimaryAccessToken(listener: () => void): () => void {
  tokenListeners.add(listener);
  return () => {
    tokenListeners.delete(listener);
  };
}

export function readPrimaryAccessGate(): PrimaryAccessGate {
  return gate;
}

export function reportPrimaryAccessResult(result: "ok" | "unauthorized"): void {
  const next: PrimaryAccessGate =
    result === "ok" ? "ok" : memoryToken === undefined ? "required" : "rejected";
  if (next === gate) return;
  gate = next;
  notify(gateListeners);
}

export function subscribePrimaryAccessGate(listener: () => void): () => void {
  gateListeners.add(listener);
  return () => {
    gateListeners.delete(listener);
  };
}

export async function checkPrimaryAccessToken(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PrimaryAccessTokenCheck> {
  try {
    const url = resolvePrimaryEnvironmentHttpUrl("/.well-known/neokod/environment");
    const response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (response.status === 200) return "accepted";
    if (response.status === 401) return "rejected";
    return "unreachable";
  } catch {
    return "unreachable";
  }
}

export function __resetPrimaryAccessTokenForTests(): void {
  memoryToken = undefined;
  initialized = false;
  gate = "unknown";
  tokenListeners.clear();
  gateListeners.clear();
}
