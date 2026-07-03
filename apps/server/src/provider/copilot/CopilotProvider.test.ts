import * as NodeAssert from "node:assert/strict";
import { it } from "@effect/vitest";
import { CopilotSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe } from "vite-plus/test";

import { checkCopilotProviderStatus, makePendingCopilotProvider } from "./CopilotProvider.ts";

const decodeSettings = Schema.decodeSync(CopilotSettings);

describe("CopilotProvider", () => {
  it.effect("makePendingCopilotProvider reports a not-yet-checked warning when enabled", () =>
    Effect.gen(function* () {
      const draft = yield* makePendingCopilotProvider(decodeSettings({}));
      NodeAssert.equal(draft.enabled, true);
      NodeAssert.equal(draft.status, "warning");
      NodeAssert.equal(draft.installed, false);
    }),
  );

  it.effect("makePendingCopilotProvider reports disabled status when settings.enabled is false", () =>
    Effect.gen(function* () {
      const draft = yield* makePendingCopilotProvider(decodeSettings({ enabled: false }));
      NodeAssert.equal(draft.enabled, false);
      NodeAssert.equal(draft.status, "disabled");
      NodeAssert.equal(draft.message, "GitHub Copilot is disabled in T3 Code settings.");
    }),
  );

  it.effect("checkCopilotProviderStatus reports ready when authenticated", () =>
    Effect.gen(function* () {
      const client = {
        getStatus: () => Promise.resolve({ version: "1.2.3", protocolVersion: 2 }),
        getAuthStatus: () =>
          Promise.resolve({ isAuthenticated: true, authType: "gh-cli" as const, login: "octocat" }),
      };
      const draft = yield* checkCopilotProviderStatus(decodeSettings({}), client);
      NodeAssert.equal(draft.status, "ready");
      NodeAssert.equal(draft.installed, true);
      NodeAssert.equal(draft.version, "1.2.3");
      NodeAssert.equal(draft.auth.status, "authenticated");
      NodeAssert.equal(draft.auth.email, "octocat");
    }),
  );

  it.effect("checkCopilotProviderStatus reports an error status when not authenticated", () =>
    Effect.gen(function* () {
      const client = {
        getStatus: () => Promise.resolve({ version: "1.2.3", protocolVersion: 2 }),
        getAuthStatus: () => Promise.resolve({ isAuthenticated: false }),
      };
      const draft = yield* checkCopilotProviderStatus(decodeSettings({}), client);
      NodeAssert.equal(draft.status, "error");
      NodeAssert.equal(draft.auth.status, "unauthenticated");
    }),
  );

  it.effect("checkCopilotProviderStatus reports an error when the runtime cannot be reached", () =>
    Effect.gen(function* () {
      const client = {
        getStatus: () => Promise.reject(new Error("connection refused")),
        getAuthStatus: () => Promise.resolve({ isAuthenticated: true }),
      };
      const draft = yield* checkCopilotProviderStatus(decodeSettings({}), client);
      NodeAssert.equal(draft.status, "error");
      NodeAssert.equal(draft.installed, false);
    }),
  );

  it.effect("checkCopilotProviderStatus reports disabled without probing the client", () =>
    Effect.gen(function* () {
      let probed = false;
      const client = {
        getStatus: () => {
          probed = true;
          return Promise.resolve({ version: "1.2.3", protocolVersion: 2 });
        },
        getAuthStatus: () => Promise.resolve({ isAuthenticated: true }),
      };
      const draft = yield* checkCopilotProviderStatus(decodeSettings({ enabled: false }), client);
      NodeAssert.equal(draft.status, "disabled");
      NodeAssert.equal(probed, false);
    }),
  );
});
