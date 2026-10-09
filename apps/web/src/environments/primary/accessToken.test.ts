import { afterEach, describe, expect, it, vi } from "@effect/vitest";

import {
  __resetPrimaryAccessTokenForTests,
  ACCESS_TOKEN_STORAGE_KEY,
  checkPrimaryAccessToken,
  clearPrimaryAccessToken,
  initializePrimaryAccessToken,
  readPrimaryAccessGate,
  readPrimaryAccessToken,
  reportPrimaryAccessResult,
  storePrimaryAccessToken,
  subscribePrimaryAccessGate,
  subscribePrimaryAccessToken,
} from "./accessToken";

const TOKEN = "t".repeat(40);

function stubWindow(location: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const replaceState = vi.fn();
  vi.stubGlobal("window", {
    location,
    history: { state: null, replaceState },
    ...extra,
  });
  return replaceState;
}

function stubStorage(initial: Record<string, string> = {}) {
  const data = new Map<string, string>(Object.entries(initial));
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  });
  return data;
}

afterEach(() => {
  __resetPrimaryAccessTokenForTests();
  vi.unstubAllGlobals();
});

describe("primary access token", () => {
  it("stores a ?loopbackAuthToken value and strips it from the address", () => {
    const data = stubStorage();
    const replaceState = stubWindow({
      href: "http://h:3773/chat?loopbackAuthToken=tok&x=1#a",
      origin: "http://h:3773",
    });

    initializePrimaryAccessToken();

    expect(replaceState).toHaveBeenCalledWith(null, "", "/chat?x=1#a");
    expect(data.get(ACCESS_TOKEN_STORAGE_KEY)).toBe("tok");
    expect(readPrimaryAccessToken()).toBe("tok");
  });

  it("reads #access-token= and keeps other fragment keys", () => {
    const data = stubStorage();
    const replaceState = stubWindow({
      href: "http://h:3773/chat?x=1#foo=bar&access-token=fragtok",
      origin: "http://h:3773",
    });

    initializePrimaryAccessToken();

    expect(replaceState).toHaveBeenCalledWith(null, "", "/chat?x=1#foo=bar");
    expect(data.get(ACCESS_TOKEN_STORAGE_KEY)).toBe("fragtok");
    expect(readPrimaryAccessToken()).toBe("fragtok");
  });

  it("falls back to the stored token", () => {
    stubStorage({ [ACCESS_TOKEN_STORAGE_KEY]: "stored" });
    stubWindow({ href: "http://h:3773/chat", origin: "http://h:3773" });

    initializePrimaryAccessToken();

    expect(readPrimaryAccessToken()).toBe("stored");
  });

  it("a URL token replaces a stored token", () => {
    stubStorage({ [ACCESS_TOKEN_STORAGE_KEY]: "old" });
    stubWindow({ href: "http://h:3773/chat", origin: "http://h:3773" });
    storePrimaryAccessToken("old");
    expect(readPrimaryAccessToken()).toBe("old");

    __resetPrimaryAccessTokenForTests();
    const data = stubStorage({ [ACCESS_TOKEN_STORAGE_KEY]: "old" });
    stubWindow({
      href: "http://h:3773/chat?loopbackAuthToken=newtok",
      origin: "http://h:3773",
    });

    expect(readPrimaryAccessToken()).toBe("newtok");
    expect(data.get(ACCESS_TOKEN_STORAGE_KEY)).toBe("newtok");
  });

  it("ignores URL and storage when window.desktopBridge exists", () => {
    const data = stubStorage({ [ACCESS_TOKEN_STORAGE_KEY]: "stored" });
    const replaceState = stubWindow(
      {
        href: "http://h:3773/chat?loopbackAuthToken=urltok",
        origin: "http://h:3773",
      },
      { desktopBridge: {} },
    );

    initializePrimaryAccessToken();

    expect(readPrimaryAccessToken()).toBeUndefined();
    expect(replaceState).not.toHaveBeenCalled();
    expect(data.get(ACCESS_TOKEN_STORAGE_KEY)).toBe("stored");
  });

  it("keeps the token in memory when localStorage throws", () => {
    stubWindow({ href: "http://h:3773/chat", origin: "http://h:3773" });
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    });

    storePrimaryAccessToken(TOKEN);

    expect(readPrimaryAccessToken()).toBe(TOKEN);
  });

  it("clear removes storage and notifies subscribers", () => {
    const data = stubStorage();
    stubWindow({ href: "http://h:3773/chat", origin: "http://h:3773" });
    const seen: Array<string | undefined> = [];
    const unsubscribe = subscribePrimaryAccessToken(() => {
      seen.push(readPrimaryAccessToken());
    });

    storePrimaryAccessToken(TOKEN);
    clearPrimaryAccessToken();
    unsubscribe();
    storePrimaryAccessToken(TOKEN);

    expect(data.get(ACCESS_TOKEN_STORAGE_KEY)).toBe(TOKEN);
    expect(readPrimaryAccessToken()).toBe(TOKEN);
    expect(seen).toEqual([TOKEN, undefined]);
  });

  it("reportPrimaryAccessResult maps unauthorized to required without a token and rejected with one", () => {
    stubStorage();
    stubWindow({ href: "http://h:3773/chat", origin: "http://h:3773" });
    const gates: Array<string> = [];
    subscribePrimaryAccessGate(() => {
      gates.push(readPrimaryAccessGate());
    });

    expect(readPrimaryAccessGate()).toBe("unknown");
    reportPrimaryAccessResult("unauthorized");
    expect(readPrimaryAccessGate()).toBe("required");
    storePrimaryAccessToken(TOKEN);
    reportPrimaryAccessResult("unauthorized");
    expect(readPrimaryAccessGate()).toBe("rejected");
    reportPrimaryAccessResult("unauthorized");
    reportPrimaryAccessResult("ok");
    expect(readPrimaryAccessGate()).toBe("ok");

    expect(gates).toEqual(["required", "rejected", "ok"]);
  });
});

describe("checkPrimaryAccessToken", () => {
  it("accepts a 200 and sends the bearer to the environment endpoint", async () => {
    stubStorage();
    stubWindow({
      href: "http://127.0.0.1:3773/chat",
      origin: "http://127.0.0.1:3773",
    });
    const seen: Array<{ url: string; authorization: string | null }> = [];
    const fetchImpl = async (url: string, init?: { headers?: Record<string, string> }) => {
      seen.push({
        url,
        authorization: init?.headers?.["authorization"] ?? null,
      });
      return new Response(null, { status: 200 });
    };

    await expect(checkPrimaryAccessToken(TOKEN, fetchImpl as typeof fetch)).resolves.toBe(
      "accepted",
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("http://127.0.0.1:3773/.well-known/neokod/environment");
    expect(seen[0]?.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("rejects a 401", async () => {
    stubStorage();
    stubWindow({
      href: "http://127.0.0.1:3773/chat",
      origin: "http://127.0.0.1:3773",
    });
    const fetchImpl = async () => new Response(null, { status: 401 });

    await expect(checkPrimaryAccessToken(TOKEN, fetchImpl as typeof fetch)).resolves.toBe(
      "rejected",
    );
  });

  it("reports unreachable for other statuses and thrown fetches", async () => {
    stubStorage();
    stubWindow({
      href: "http://127.0.0.1:3773/chat",
      origin: "http://127.0.0.1:3773",
    });

    await expect(
      checkPrimaryAccessToken(
        TOKEN,
        (async () => new Response(null, { status: 500 })) as typeof fetch,
      ),
    ).resolves.toBe("unreachable");
    await expect(
      checkPrimaryAccessToken(TOKEN, (async () => {
        throw new Error("down");
      }) as typeof fetch),
    ).resolves.toBe("unreachable");
  });
});
