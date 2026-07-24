import * as NodeAssert from "node:assert/strict";
import type { CopilotClient, ModelInfo } from "@github/copilot-sdk";
import { it } from "@effect/vitest";
import { CopilotSettings } from "@neokod/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Schema from "effect/Schema";
import { describe } from "vite-plus/test";

import { checkCopilotProviderStatus, makePendingCopilotProvider } from "./CopilotProvider.ts";

const decodeSettings = Schema.decodeSync(CopilotSettings);

const SDK_MODEL_CAPABILITIES: ModelInfo["capabilities"] = {
  supports: { vision: false, reasoningEffort: true },
  limits: { max_context_window_tokens: 128_000 },
};

const emptyQuotaRpc = {
  account: {
    getQuota: () => Promise.resolve({ quotaSnapshots: {} }),
  },
} as unknown as CopilotClient["rpc"];

describe("CopilotProvider", () => {
  it.effect("makePendingCopilotProvider reports a not-yet-checked warning when enabled", () =>
    Effect.gen(function* () {
      const draft = yield* makePendingCopilotProvider(decodeSettings({ enabled: true }));
      NodeAssert.equal(draft.enabled, true);
      NodeAssert.equal(draft.status, "warning");
      NodeAssert.equal(draft.installed, false);
    }),
  );

  it.effect(
    "makePendingCopilotProvider reports disabled status when settings.enabled is false",
    () =>
      Effect.gen(function* () {
        const draft = yield* makePendingCopilotProvider(decodeSettings({ enabled: false }));
        NodeAssert.equal(draft.enabled, false);
        NodeAssert.equal(draft.status, "disabled");
        NodeAssert.equal(draft.message, "GitHub Copilot is disabled in Neokod settings.");
      }),
  );

  it.effect("checkCopilotProviderStatus reports ready when authenticated", () =>
    Effect.gen(function* () {
      const client = {
        getStatus: () => Promise.resolve({ version: "1.2.3", protocolVersion: 2 }),
        getAuthStatus: () =>
          Promise.resolve({ isAuthenticated: true, authType: "gh-cli" as const, login: "octocat" }),
        listModels: () => Promise.resolve([]),
        rpc: {
          account: {
            getQuota: () =>
              Promise.resolve({
                quotaSnapshots: {
                  premium_interactions: {
                    isUnlimitedEntitlement: false,
                    entitlementRequests: 100,
                    usedRequests: 12,
                    usageAllowedWithExhaustedQuota: false,
                    remainingPercentage: 88,
                    overage: 0,
                    overageAllowedWithExhaustedQuota: false,
                  },
                },
              }),
          },
        } as unknown as CopilotClient["rpc"],
      };
      const draft = yield* checkCopilotProviderStatus(decodeSettings({ enabled: true }), client);
      NodeAssert.equal(draft.status, "ready");
      NodeAssert.equal(draft.installed, true);
      NodeAssert.equal(draft.version, "1.2.3");
      NodeAssert.equal(draft.auth.status, "authenticated");
      NodeAssert.equal(draft.auth.email, "octocat");
      NodeAssert.equal(draft.usage?.windows[0]?.bucketId, "premium_interactions");
      NodeAssert.equal(draft.usage?.windows[0]?.used, 12);
    }),
  );

  it.effect("checkCopilotProviderStatus forwards the GitHub token to quota lookup", () =>
    Effect.gen(function* () {
      let receivedToken: string | undefined;
      const client = {
        getStatus: () => Promise.resolve({ version: "1.2.3", protocolVersion: 2 }),
        getAuthStatus: () => Promise.resolve({ isAuthenticated: true }),
        listModels: () => Promise.resolve([]),
        rpc: {
          account: {
            getQuota: (params: { readonly gitHubToken?: string }) => {
              receivedToken = params.gitHubToken;
              return Promise.resolve({ quotaSnapshots: {} });
            },
          },
        } as unknown as CopilotClient["rpc"],
      };

      yield* checkCopilotProviderStatus(decodeSettings({ enabled: true }), client, "ghp_secret");

      NodeAssert.equal(receivedToken, "ghp_secret");
    }),
  );

  it.effect("checkCopilotProviderStatus reports an error status when not authenticated", () =>
    Effect.gen(function* () {
      let listModelsProbed = false;
      let quotaProbed = false;
      const client = {
        getStatus: () => Promise.resolve({ version: "1.2.3", protocolVersion: 2 }),
        getAuthStatus: () => Promise.resolve({ isAuthenticated: false }),
        listModels: () => {
          listModelsProbed = true;
          return Promise.resolve([]);
        },
        rpc: {
          account: {
            getQuota: () => {
              quotaProbed = true;
              return Promise.resolve({ quotaSnapshots: {} });
            },
          },
        } as unknown as CopilotClient["rpc"],
      };
      const draft = yield* checkCopilotProviderStatus(decodeSettings({ enabled: true }), client);
      NodeAssert.equal(draft.status, "error");
      NodeAssert.equal(draft.auth.status, "unauthenticated");
      NodeAssert.equal(listModelsProbed, false);
      NodeAssert.equal(quotaProbed, false);
    }),
  );

  it.effect("checkCopilotProviderStatus reports an error when the runtime cannot be reached", () =>
    Effect.gen(function* () {
      const client = {
        getStatus: () => Promise.reject(new Error("connection refused")),
        getAuthStatus: () => Promise.resolve({ isAuthenticated: true }),
        listModels: () => Promise.resolve([]),
        rpc: emptyQuotaRpc,
      };
      const draft = yield* checkCopilotProviderStatus(decodeSettings({ enabled: true }), client);
      NodeAssert.equal(draft.status, "error");
      NodeAssert.equal(draft.installed, false);
    }),
  );

  it.effect("checkCopilotProviderStatus reports disabled without probing the client", () =>
    Effect.gen(function* () {
      let probed = false;
      let listModelsProbed = false;
      const client = {
        getStatus: () => {
          probed = true;
          return Promise.resolve({ version: "1.2.3", protocolVersion: 2 });
        },
        getAuthStatus: () => Promise.resolve({ isAuthenticated: true }),
        listModels: () => {
          listModelsProbed = true;
          return Promise.resolve([]);
        },
        rpc: emptyQuotaRpc,
      };
      const draft = yield* checkCopilotProviderStatus(decodeSettings({ enabled: false }), client);
      NodeAssert.equal(draft.status, "disabled");
      NodeAssert.equal(probed, false);
      NodeAssert.equal(listModelsProbed, false);
    }),
  );

  it.effect("checkCopilotProviderStatus uses the authenticated live model list", () =>
    Effect.gen(function* () {
      const client = {
        getStatus: () => Promise.resolve({ version: "1.2.3", protocolVersion: 2 }),
        getAuthStatus: () => Promise.resolve({ isAuthenticated: true }),
        listModels: () =>
          Promise.resolve<ModelInfo[]>([
            {
              id: "gpt-live",
              name: "GPT Live",
              capabilities: SDK_MODEL_CAPABILITIES,
              supportedReasoningEfforts: ["low", "high"],
              defaultReasoningEffort: "high",
            },
            {
              id: "gpt-disabled",
              name: "Disabled",
              capabilities: SDK_MODEL_CAPABILITIES,
              policy: { state: "disabled", terms: "" },
            },
          ]),
        rpc: emptyQuotaRpc,
      };
      const draft = yield* checkCopilotProviderStatus(decodeSettings({ enabled: true }), client);

      NodeAssert.deepEqual(
        draft.models.map((model) => model.slug),
        ["gpt-live"],
      );
      const reasoningDescriptor = draft.models[0]?.capabilities?.optionDescriptors?.[0];
      NodeAssert.equal(reasoningDescriptor?.currentValue, "high");
      NodeAssert.equal(
        reasoningDescriptor?.options?.find((option) => option.id === "high")?.isDefault,
        true,
      );
    }),
  );

  it.effect(
    "checkCopilotProviderStatus falls back to the static model list on listModels failure",
    () =>
      Effect.gen(function* () {
        const client = {
          getStatus: () => Promise.resolve({ version: "1.2.3", protocolVersion: 2 }),
          getAuthStatus: () => Promise.resolve({ isAuthenticated: true }),
          listModels: () => Promise.reject(new Error("boom")),
          rpc: emptyQuotaRpc,
        };
        const draft = yield* checkCopilotProviderStatus(decodeSettings({ enabled: true }), client);

        NodeAssert.ok(draft.models.some((model) => model.slug === "gpt-5"));
      }),
  );

  it.effect(
    "checkCopilotProviderStatus falls back to the static model list on listModels timeout",
    () =>
      Effect.gen(function* () {
        const client = {
          getStatus: () => Promise.resolve({ version: "1.2.3", protocolVersion: 2 }),
          getAuthStatus: () => Promise.resolve({ isAuthenticated: true }),
          listModels: () => new Promise<never>(() => {}),
          rpc: emptyQuotaRpc,
        };
        const fiber = yield* checkCopilotProviderStatus(
          decodeSettings({ enabled: true }),
          client,
        ).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("8001 millis");
        const draft = yield* Fiber.join(fiber);

        NodeAssert.ok(draft.models.some((model) => model.slug === "gpt-5"));
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("quota failure does not change a healthy authenticated provider", () =>
    Effect.gen(function* () {
      const client = {
        getStatus: () => Promise.resolve({ version: "1.2.3", protocolVersion: 2 }),
        getAuthStatus: () => Promise.resolve({ isAuthenticated: true }),
        listModels: () => Promise.resolve([]),
        rpc: {
          account: {
            getQuota: () => Promise.reject(new Error("quota unavailable")),
          },
        } as unknown as CopilotClient["rpc"],
      };

      const draft = yield* checkCopilotProviderStatus(decodeSettings({ enabled: true }), client);

      NodeAssert.equal(draft.status, "ready");
      NodeAssert.equal(draft.auth.status, "authenticated");
      NodeAssert.equal(draft.usage, undefined);
    }),
  );
});
