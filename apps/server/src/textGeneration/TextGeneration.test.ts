import { it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import {
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
  type ServerProviderModel,
  TextGenerationError,
} from "@neokod/contracts";
import { createModelSelection } from "@neokod/shared/model";

import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import * as TextGeneration from "./TextGeneration.ts";

const makeStubTextGeneration = (
  overrides: Partial<TextGeneration.TextGeneration["Service"]>,
): TextGeneration.TextGeneration["Service"] =>
  TextGeneration.TextGeneration.of({
    generateCommitMessage: () =>
      Effect.die("generateCommitMessage stub not configured for this test"),
    generatePrContent: () => Effect.die("generatePrContent stub not configured for this test"),
    generateCodeReview: () => Effect.die("generateCodeReview stub not configured for this test"),
    generateBranchName: () => Effect.die("generateBranchName stub not configured for this test"),
    generateThreadTitle: () => Effect.die("generateThreadTitle stub not configured for this test"),
    ...overrides,
  });

const model = (slug: string, isCustom = false): ServerProviderModel => ({
  slug,
  name: slug,
  isCustom,
  capabilities: isCustom ? null : {},
});

const makeSnapshot = (input: {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderInstance["driverKind"];
  readonly models?: ReadonlyArray<ServerProviderModel>;
  readonly enabled?: boolean;
  readonly installed?: boolean;
  readonly availability?: ServerProvider["availability"];
  readonly unavailableReason?: string;
  readonly status?: ServerProvider["status"];
  readonly auth?: ServerProvider["auth"];
}): ServerProvider => ({
  instanceId: input.instanceId,
  driver: input.driverKind,
  enabled: input.enabled ?? true,
  installed: input.installed ?? true,
  version: null,
  status: input.status ?? "ready",
  auth: input.auth ?? { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: input.models ?? [],
  slashCommands: [],
  skills: [],
  ...(input.availability !== undefined ? { availability: input.availability } : {}),
  ...(input.unavailableReason !== undefined ? { unavailableReason: input.unavailableReason } : {}),
});

const makeStubInstance = (
  instanceId: ProviderInstanceId,
  textGeneration: TextGeneration.TextGeneration["Service"],
  options?: {
    readonly driverKind?: ProviderInstance["driverKind"];
    readonly enabled?: boolean;
    readonly models?: ReadonlyArray<ServerProviderModel>;
    readonly getSnapshot?: Effect.Effect<ServerProvider>;
    readonly refresh?: Effect.Effect<ServerProvider>;
    readonly snapshotExtras?: Partial<ServerProvider>;
  },
): ProviderInstance => {
  const driverKind =
    options?.driverKind ?? (instanceId as unknown as ProviderInstance["driverKind"]);
  const snapshot: ServerProvider = {
    ...makeSnapshot({
      instanceId,
      driverKind,
      ...(options?.models !== undefined ? { models: options.models } : {}),
      ...(options?.enabled !== undefined ? { enabled: options.enabled } : {}),
    }),
    ...options?.snapshotExtras,
  };
  return {
    instanceId,
    driverKind,
    continuationIdentity: {
      driverKind,
      continuationKey: `${instanceId}:test`,
    },
    displayName: undefined,
    enabled: options?.enabled ?? true,
    snapshot: {
      maintenanceCapabilities: {} as ProviderInstance["snapshot"]["maintenanceCapabilities"],
      getSnapshot: options?.getSnapshot ?? Effect.succeed(snapshot),
      refresh: options?.refresh ?? Effect.succeed(snapshot),
      streamChanges: Stream.empty,
    },
    adapter: {} as ProviderInstance["adapter"],
    textGeneration,
  } satisfies ProviderInstance;
};

const makeStubRegistry = (
  instances: ReadonlyArray<ProviderInstance>,
): ProviderInstanceRegistry.ProviderInstanceRegistry["Service"] => {
  const byId = new Map(instances.map((instance) => [instance.instanceId, instance] as const));
  return {
    getInstance: (id) => Effect.succeed(byId.get(id)),
    listInstances: Effect.succeed(instances),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    // Tests never drive changes through this stub; acquire a throwaway
    // subscription on an unused PubSub so the shape is satisfied.
    subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
      PubSub.subscribe(pubsub),
    ),
  };
};

interface RecordedCall {
  readonly operation: string;
  readonly modelSelection: ModelSelection;
}

const makeRecordingTextGeneration = (calls: Array<RecordedCall>) =>
  makeStubTextGeneration({
    generateCommitMessage: (input) => {
      calls.push({ operation: "generateCommitMessage", modelSelection: input.modelSelection });
      return Effect.succeed({ subject: "recorded", body: "recorded" });
    },
    generatePrContent: (input) => {
      calls.push({ operation: "generatePrContent", modelSelection: input.modelSelection });
      return Effect.succeed({ title: "recorded", body: "recorded" });
    },
    generateCodeReview: (input) => {
      calls.push({ operation: "generateCodeReview", modelSelection: input.modelSelection });
      return Effect.succeed({ verdict: "approve", summary: "recorded", findings: [] });
    },
    generateBranchName: (input) => {
      calls.push({ operation: "generateBranchName", modelSelection: input.modelSelection });
      return Effect.succeed({ branch: "recorded-branch" });
    },
    generateThreadTitle: (input) => {
      calls.push({ operation: "generateThreadTitle", modelSelection: input.modelSelection });
      return Effect.succeed({ title: "Recorded title" });
    },
  });

describe("makeTextGenerationFromRegistry", () => {
  it.effect("delegates to the matching instance's textGeneration closure", () =>
    Effect.gen(function* () {
      const personalId = ProviderInstanceId.make("codex_personal");
      const personalCalls: string[] = [];
      const personal = makeStubInstance(
        personalId,
        makeStubTextGeneration({
          generateBranchName: (input) => {
            personalCalls.push(input.message);
            return Effect.succeed({ branch: "personal-branch" });
          },
        }),
        { models: [model("gpt-5")] },
      );

      const workId = ProviderInstanceId.make("codex_work");
      const work = makeStubInstance(
        workId,
        makeStubTextGeneration({
          generateBranchName: () => Effect.succeed({ branch: "work-branch" }),
        }),
        { models: [model("gpt-5")] },
      );

      const tg = TextGeneration.makeTextGenerationFromRegistry(makeStubRegistry([personal, work]));

      const result = yield* tg.generateBranchName({
        cwd: process.cwd(),
        message: "Refactor the routing layer",
        modelSelection: createModelSelection(ProviderInstanceId.make("codex_personal"), "gpt-5"),
      });

      expect(result.branch).toBe("personal-branch");
      expect(personalCalls).toEqual(["Refactor the routing layer"]);
    }),
  );

  it.effect("routes code reviews to the selected provider instance", () =>
    Effect.gen(function* () {
      const claudeId = ProviderInstanceId.make("claude_review");
      const calls: string[] = [];
      const claude = makeStubInstance(
        claudeId,
        makeStubTextGeneration({
          generateCodeReview: (input) => {
            calls.push(`${input.modelSelection.model}:${input.baseRef}..${input.headRef}`);
            return Effect.succeed({
              verdict: "approve",
              summary: "No blocking findings.",
              findings: [],
            });
          },
        }),
        { models: [model("claude-fable-5")] },
      );
      const tg = TextGeneration.makeTextGenerationFromRegistry(makeStubRegistry([claude]));

      const result = yield* tg.generateCodeReview({
        cwd: process.cwd(),
        objective: "Review provider fan-out",
        acceptanceCriteria: ["Use the selected reviewer model"],
        baseRef: "main",
        headRef: "HEAD",
        diffPatch: "diff --git a/a.ts b/a.ts",
        modelSelection: createModelSelection(claudeId, "claude-fable-5"),
      });

      expect(result.verdict).toBe("approve");
      expect(calls).toEqual(["claude-fable-5:main..HEAD"]);
    }),
  );

  it.effect("fails with TextGenerationError when the instance is unknown", () =>
    Effect.gen(function* () {
      const tg = TextGeneration.makeTextGenerationFromRegistry(makeStubRegistry([]));

      const result = yield* tg
        .generateBranchName({
          cwd: process.cwd(),
          message: "anything",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("missing_instance"),
            "gpt-5",
          ),
        })
        .pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("TextGenerationError");
        expect(result.failure.operation).toBe("generateBranchName");
        expect(result.failure.detail).toContain("missing_instance");
        expect(result.failure.detail).toContain("Text generation model");
      }
    }),
  );
});

describe("auxiliary text generation admission", () => {
  const INSTANCE_ID = ProviderInstanceId.make("codex_textgen");
  const EXACT_SELECTION = createModelSelection(INSTANCE_ID, "gpt-5", [
    { id: "reasoningEffort", value: "high" },
  ]);

  it.effect("admits every auxiliary operation with the exact instance, model, and options", () =>
    Effect.gen(function* () {
      const calls: Array<RecordedCall> = [];
      const instance = makeStubInstance(INSTANCE_ID, makeRecordingTextGeneration(calls), {
        models: [model("gpt-5")],
      });
      const tg = TextGeneration.makeTextGenerationFromRegistry(makeStubRegistry([instance]));

      const cases: ReadonlyArray<{
        readonly operation: RecordedCall["operation"];
        readonly run: (
          service: TextGeneration.TextGeneration["Service"],
        ) => Effect.Effect<unknown, TextGenerationError>;
      }> = [
        {
          operation: "generateCommitMessage",
          run: (service) =>
            service.generateCommitMessage({
              cwd: process.cwd(),
              branch: null,
              stagedSummary: "staged",
              stagedPatch: "patch",
              modelSelection: EXACT_SELECTION,
            }),
        },
        {
          operation: "generatePrContent",
          run: (service) =>
            service.generatePrContent({
              cwd: process.cwd(),
              baseBranch: "main",
              headBranch: "feature",
              commitSummary: "summary",
              diffSummary: "diff summary",
              diffPatch: "diff patch",
              modelSelection: EXACT_SELECTION,
            }),
        },
        {
          operation: "generateCodeReview",
          run: (service) =>
            service.generateCodeReview({
              cwd: process.cwd(),
              objective: "objective",
              acceptanceCriteria: [],
              baseRef: "main",
              headRef: "HEAD",
              diffPatch: "diff patch",
              modelSelection: EXACT_SELECTION,
            }),
        },
        {
          operation: "generateBranchName",
          run: (service) =>
            service.generateBranchName({
              cwd: process.cwd(),
              message: "message",
              modelSelection: EXACT_SELECTION,
            }),
        },
        {
          operation: "generateThreadTitle",
          run: (service) =>
            service.generateThreadTitle({
              cwd: process.cwd(),
              message: "message",
              modelSelection: EXACT_SELECTION,
            }),
        },
      ];

      yield* Effect.forEach(cases, (testCase) =>
        Effect.gen(function* () {
          calls.length = 0;
          yield* testCase.run(tg);
          expect(calls).toEqual([
            { operation: testCase.operation, modelSelection: EXACT_SELECTION },
          ]);
        }),
      );
    }),
  );

  it.effect("admits a configured custom model with null capabilities", () =>
    Effect.gen(function* () {
      const calls: Array<RecordedCall> = [];
      const instance = makeStubInstance(INSTANCE_ID, makeRecordingTextGeneration(calls), {
        models: [model("gpt-5"), model("team-custom-model", true)],
      });
      const tg = TextGeneration.makeTextGenerationFromRegistry(makeStubRegistry([instance]));
      const selection = createModelSelection(INSTANCE_ID, "team-custom-model");

      const result = yield* tg.generateThreadTitle({
        cwd: process.cwd(),
        message: "custom model",
        modelSelection: selection,
      });

      expect(result.title).toBe("Recorded title");
      expect(calls).toEqual([{ operation: "generateThreadTitle", modelSelection: selection }]);
    }),
  );

  it.effect("never admits a model that is only advertised by another instance", () =>
    Effect.gen(function* () {
      const instanceCalls: Array<RecordedCall> = [];
      const otherCalls: Array<RecordedCall> = [];
      const snapshot = makeSnapshot({
        instanceId: INSTANCE_ID,
        driverKind: INSTANCE_ID as unknown as ProviderInstance["driverKind"],
        models: [model("gpt-5")],
      });
      let refreshCount = 0;
      const instance = makeStubInstance(INSTANCE_ID, makeRecordingTextGeneration(instanceCalls), {
        models: [model("gpt-5")],
        refresh: Effect.sync(() => {
          refreshCount += 1;
          return snapshot;
        }),
      });
      const otherId = ProviderInstanceId.make("codex_other");
      const other = makeStubInstance(otherId, makeRecordingTextGeneration(otherCalls), {
        models: [model("gpt-6")],
      });
      const tg = TextGeneration.makeTextGenerationFromRegistry(makeStubRegistry([instance, other]));

      const result = yield* tg
        .generateThreadTitle({
          cwd: process.cwd(),
          message: "wrong instance",
          modelSelection: createModelSelection(INSTANCE_ID, "gpt-6"),
        })
        .pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure.detail).toContain("not advertised");
        expect(result.failure.detail).toContain("Text generation model");
      }
      expect(refreshCount).toBe(1);
      expect(instanceCalls).toEqual([]);
      expect(otherCalls).toEqual([]);
    }),
  );

  it.effect("uses one exact-instance refresh to discover a newly listed model", () =>
    Effect.gen(function* () {
      const calls: Array<RecordedCall> = [];
      const driverKind = INSTANCE_ID as unknown as ProviderInstance["driverKind"];
      const refreshedSnapshot = makeSnapshot({
        instanceId: INSTANCE_ID,
        driverKind,
        models: [model("gpt-5"), model("gpt-5.4-mini")],
      });
      let refreshCount = 0;
      const instance = makeStubInstance(INSTANCE_ID, makeRecordingTextGeneration(calls), {
        models: [model("gpt-5")],
        refresh: Effect.sync(() => {
          refreshCount += 1;
          return refreshedSnapshot;
        }),
      });
      const tg = TextGeneration.makeTextGenerationFromRegistry(makeStubRegistry([instance]));
      const selection = createModelSelection(INSTANCE_ID, "gpt-5.4-mini", [
        { id: "reasoningEffort", value: "low" },
      ]);

      const result = yield* tg.generateBranchName({
        cwd: process.cwd(),
        message: "refresh once",
        modelSelection: selection,
      });

      expect(result.branch).toBe("recorded-branch");
      expect(refreshCount).toBe(1);
      expect(calls).toEqual([{ operation: "generateBranchName", modelSelection: selection }]);
    }),
  );

  it.effect("refuses persistent absence after one refresh without running generation", () =>
    Effect.gen(function* () {
      const calls: Array<RecordedCall> = [];
      const driverKind = INSTANCE_ID as unknown as ProviderInstance["driverKind"];
      const snapshot = makeSnapshot({
        instanceId: INSTANCE_ID,
        driverKind,
        models: [model("gpt-5")],
      });
      let refreshCount = 0;
      const instance = makeStubInstance(INSTANCE_ID, makeRecordingTextGeneration(calls), {
        models: [model("gpt-5")],
        refresh: Effect.sync(() => {
          refreshCount += 1;
          return snapshot;
        }),
      });
      const tg = TextGeneration.makeTextGenerationFromRegistry(makeStubRegistry([instance]));

      const result = yield* tg
        .generateCommitMessage({
          cwd: process.cwd(),
          branch: null,
          stagedSummary: "staged",
          stagedPatch: "patch",
          modelSelection: createModelSelection(INSTANCE_ID, "gpt-retired"),
        })
        .pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure.detail).toContain("'gpt-retired'");
        expect(result.failure.detail).toContain("not advertised");
      }
      expect(refreshCount).toBe(1);
      expect(calls).toEqual([]);
    }),
  );

  it.effect("treats failed or empty probes as unavailable evidence, not unsupported", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<{
        readonly name: string;
        readonly options: Parameters<typeof makeStubInstance>[2];
        readonly expected: string;
      }> = [
        {
          name: "refresh defect",
          options: {
            models: [model("gpt-5")],
            refresh: Effect.die(new Error("refresh crashed")),
          },
          expected: "could not be refreshed",
        },
        {
          name: "empty refreshed catalogue",
          options: {
            models: [model("gpt-5")],
            refresh: Effect.succeed(
              makeSnapshot({
                instanceId: INSTANCE_ID,
                driverKind: INSTANCE_ID as unknown as ProviderInstance["driverKind"],
                models: [],
              }),
            ),
          },
          expected: "empty or incomplete",
        },
        {
          name: "empty initial catalogue",
          options: {
            models: [],
          },
          expected: "empty or incomplete",
        },
        {
          name: "snapshot read defect",
          options: {
            getSnapshot: Effect.die(new Error("snapshot crashed")),
          },
          expected: "evidence",
        },
      ];

      yield* Effect.forEach(cases, (testCase) =>
        Effect.gen(function* () {
          const calls: Array<RecordedCall> = [];
          const instance = makeStubInstance(
            INSTANCE_ID,
            makeRecordingTextGeneration(calls),
            testCase.options,
          );
          const tg = TextGeneration.makeTextGenerationFromRegistry(makeStubRegistry([instance]));

          const result = yield* tg
            .generateThreadTitle({
              cwd: process.cwd(),
              message: "unverified",
              modelSelection: createModelSelection(INSTANCE_ID, "gpt-retired"),
            })
            .pipe(Effect.result);

          expect(Result.isFailure(result), testCase.name).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure.detail, testCase.name).toContain(testCase.expected);
            expect(result.failure.detail, testCase.name).not.toContain("not advertised");
            expect(result.failure.detail, testCase.name).not.toContain("unsupported");
          }
          expect(calls, testCase.name).toEqual([]);
        }),
      );
    }),
  );

  it.effect("uses the single refresh to repair an empty initial catalogue", () =>
    Effect.gen(function* () {
      const calls: Array<RecordedCall> = [];
      let refreshCount = 0;
      const instance = makeStubInstance(INSTANCE_ID, makeRecordingTextGeneration(calls), {
        models: [],
        refresh: Effect.sync(() => {
          refreshCount += 1;
          return makeSnapshot({
            instanceId: INSTANCE_ID,
            driverKind: INSTANCE_ID as unknown as ProviderInstance["driverKind"],
            models: [model("gpt-5")],
          });
        }),
      });
      const tg = TextGeneration.makeTextGenerationFromRegistry(makeStubRegistry([instance]));
      const selection = createModelSelection(INSTANCE_ID, "gpt-5");

      const result = yield* tg.generateThreadTitle({
        cwd: process.cwd(),
        message: "no initial catalogue",
        modelSelection: selection,
      });

      expect(result.title).toBe("Recorded title");
      expect(refreshCount).toBe(1);
      expect(calls).toEqual([{ operation: "generateThreadTitle", modelSelection: selection }]);
    }),
  );

  it.effect("reports an empty catalogue after refresh as unverified without generating", () =>
    Effect.gen(function* () {
      const calls: Array<RecordedCall> = [];
      let refreshCount = 0;
      const instance = makeStubInstance(INSTANCE_ID, makeRecordingTextGeneration(calls), {
        models: [],
        refresh: Effect.sync(() => {
          refreshCount += 1;
          return makeSnapshot({
            instanceId: INSTANCE_ID,
            driverKind: INSTANCE_ID as unknown as ProviderInstance["driverKind"],
            models: [],
          });
        }),
      });
      const tg = TextGeneration.makeTextGenerationFromRegistry(makeStubRegistry([instance]));

      const result = yield* tg
        .generateThreadTitle({
          cwd: process.cwd(),
          message: "no catalogue after refresh",
          modelSelection: createModelSelection(INSTANCE_ID, "gpt-5"),
        })
        .pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure.detail).toContain("empty or incomplete");
        expect(result.failure.detail).not.toContain("not advertised");
      }
      expect(refreshCount).toBe(1);
      expect(calls).toEqual([]);
    }),
  );

  it.effect("refuses a disabled instance without probing or generating", () =>
    Effect.gen(function* () {
      const calls: Array<RecordedCall> = [];
      const instance = makeStubInstance(INSTANCE_ID, makeRecordingTextGeneration(calls), {
        enabled: false,
        models: [model("gpt-5")],
        getSnapshot: Effect.die("disabled instances must not be probed"),
      });
      const tg = TextGeneration.makeTextGenerationFromRegistry(makeStubRegistry([instance]));

      const result = yield* tg
        .generateThreadTitle({
          cwd: process.cwd(),
          message: "disabled",
          modelSelection: createModelSelection(INSTANCE_ID, "gpt-5"),
        })
        .pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure.detail).toContain("disabled");
      }
      expect(calls).toEqual([]);
    }),
  );

  it.effect("reports an unavailable snapshot with its safe reason", () =>
    Effect.gen(function* () {
      const calls: Array<RecordedCall> = [];
      const instance = makeStubInstance(INSTANCE_ID, makeRecordingTextGeneration(calls), {
        enabled: true,
        snapshotExtras: {
          enabled: false,
          availability: "unavailable",
          unavailableReason: "Driver is not shipped in this build.",
          models: [],
        },
      });
      const tg = TextGeneration.makeTextGenerationFromRegistry(makeStubRegistry([instance]));

      const result = yield* tg
        .generateThreadTitle({
          cwd: process.cwd(),
          message: "unavailable",
          modelSelection: createModelSelection(INSTANCE_ID, "gpt-5"),
        })
        .pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure.detail).toContain("unavailable");
        expect(result.failure.detail).toContain("Driver is not shipped in this build.");
      }
      expect(calls).toEqual([]);
    }),
  );

  it.effect("requires exact slug membership and rejects aliases and display names", () =>
    Effect.gen(function* () {
      const selections = ["gpt-5-codex", "GPT-5.4", "GPT 5.4"] as const;
      yield* Effect.forEach(selections, (selectedModel) =>
        Effect.gen(function* () {
          const calls: Array<RecordedCall> = [];
          let refreshCount = 0;
          const driverKind = INSTANCE_ID as unknown as ProviderInstance["driverKind"];
          const snapshot = makeSnapshot({
            instanceId: INSTANCE_ID,
            driverKind,
            models: [model("gpt-5.4")],
          });
          const instance = makeStubInstance(INSTANCE_ID, makeRecordingTextGeneration(calls), {
            models: [model("gpt-5.4")],
            refresh: Effect.sync(() => {
              refreshCount += 1;
              return snapshot;
            }),
          });
          const tg = TextGeneration.makeTextGenerationFromRegistry(makeStubRegistry([instance]));

          const result = yield* tg
            .generateThreadTitle({
              cwd: process.cwd(),
              message: selectedModel,
              modelSelection: createModelSelection(INSTANCE_ID, selectedModel),
            })
            .pipe(Effect.result);

          expect(Result.isFailure(result), selectedModel).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure.detail, selectedModel).toContain("not advertised");
          }
          expect(refreshCount, selectedModel).toBe(1);
          expect(calls, selectedModel).toEqual([]);
        }),
      );
    }),
  );

  it.effect("treats invalid evidence as unverified before membership and never probes", () =>
    Effect.gen(function* () {
      const invalidCases: ReadonlyArray<{
        readonly name: string;
        readonly options: Parameters<typeof makeStubInstance>[2];
        readonly selection: string;
      }> = [
        {
          name: "error snapshot with a custom-only catalogue",
          options: {
            models: [model("team-custom", true)],
            snapshotExtras: { status: "error" },
          },
          selection: "team-custom",
        },
        {
          name: "explicitly unauthenticated",
          options: {
            models: [model("gpt-5")],
            snapshotExtras: { auth: { status: "unauthenticated" } },
          },
          selection: "gpt-5",
        },
        {
          name: "not installed",
          options: {
            models: [model("gpt-5")],
            snapshotExtras: { installed: false },
          },
          selection: "gpt-5",
        },
      ];

      yield* Effect.forEach(invalidCases, (testCase) =>
        Effect.gen(function* () {
          const calls: Array<RecordedCall> = [];
          let refreshCount = 0;
          const instance = makeStubInstance(INSTANCE_ID, makeRecordingTextGeneration(calls), {
            ...testCase.options,
            refresh: Effect.sync(() => {
              refreshCount += 1;
              return makeSnapshot({
                instanceId: INSTANCE_ID,
                driverKind: INSTANCE_ID as unknown as ProviderInstance["driverKind"],
                models: [],
              });
            }),
          });
          const tg = TextGeneration.makeTextGenerationFromRegistry(makeStubRegistry([instance]));

          const result = yield* tg
            .generateThreadTitle({
              cwd: process.cwd(),
              message: testCase.name,
              modelSelection: createModelSelection(INSTANCE_ID, testCase.selection),
            })
            .pipe(Effect.result);

          expect(Result.isFailure(result), testCase.name).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure.detail, testCase.name).toContain("evidence");
            expect(result.failure.detail, testCase.name).not.toContain("not advertised");
          }
          expect(refreshCount, testCase.name).toBe(0);
          expect(calls, testCase.name).toEqual([]);
        }),
      );
    }),
  );

  it.effect("admits warning snapshots with installed catalogue evidence", () =>
    Effect.gen(function* () {
      const calls: Array<RecordedCall> = [];
      const instance = makeStubInstance(INSTANCE_ID, makeRecordingTextGeneration(calls), {
        models: [model("gpt-5")],
        snapshotExtras: { status: "warning", auth: { status: "unknown" } },
      });
      const tg = TextGeneration.makeTextGenerationFromRegistry(makeStubRegistry([instance]));
      const selection = createModelSelection(INSTANCE_ID, "gpt-5");

      const result = yield* tg.generateThreadTitle({
        cwd: process.cwd(),
        message: "warning evidence",
        modelSelection: selection,
      });

      expect(result.title).toBe("Recorded title");
      expect(calls).toEqual([{ operation: "generateThreadTitle", modelSelection: selection }]);
    }),
  );

  it.effect("reports a valid custom-only catalogue as unverified, not not-listed", () =>
    Effect.gen(function* () {
      const calls: Array<RecordedCall> = [];
      let refreshCount = 0;
      const instance = makeStubInstance(INSTANCE_ID, makeRecordingTextGeneration(calls), {
        models: [model("team-custom", true)],
        refresh: Effect.sync(() => {
          refreshCount += 1;
          return makeSnapshot({
            instanceId: INSTANCE_ID,
            driverKind: INSTANCE_ID as unknown as ProviderInstance["driverKind"],
            models: [model("team-custom", true)],
          });
        }),
      });
      const tg = TextGeneration.makeTextGenerationFromRegistry(makeStubRegistry([instance]));

      const result = yield* tg
        .generateThreadTitle({
          cwd: process.cwd(),
          message: "custom-only catalogue",
          modelSelection: createModelSelection(INSTANCE_ID, "gpt-5"),
        })
        .pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure.detail).toContain("empty or incomplete");
        expect(result.failure.detail).not.toContain("not advertised");
      }
      expect(refreshCount).toBe(1);
      expect(calls).toEqual([]);
    }),
  );

  it.effect("preserves interruption-only probe causes instead of typed failures", () =>
    Effect.gen(function* () {
      const interruptionCases: ReadonlyArray<{
        readonly name: string;
        readonly options: Parameters<typeof makeStubInstance>[2];
        readonly selection: string;
      }> = [
        {
          name: "snapshot interrupted",
          options: {
            models: [model("gpt-5")],
            getSnapshot: Effect.interrupt,
          },
          selection: "gpt-5",
        },
        {
          name: "refresh interrupted",
          options: {
            models: [model("gpt-5")],
            refresh: Effect.interrupt,
          },
          selection: "gpt-missing",
        },
      ];

      yield* Effect.forEach(interruptionCases, (testCase) =>
        Effect.gen(function* () {
          const calls: Array<RecordedCall> = [];
          const instance = makeStubInstance(
            INSTANCE_ID,
            makeRecordingTextGeneration(calls),
            testCase.options,
          );
          const tg = TextGeneration.makeTextGenerationFromRegistry(makeStubRegistry([instance]));

          const exit = yield* tg
            .generateThreadTitle({
              cwd: process.cwd(),
              message: testCase.name,
              modelSelection: createModelSelection(INSTANCE_ID, testCase.selection),
            })
            .pipe(Effect.exit);

          expect(Exit.isFailure(exit), testCase.name).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Cause.hasInterruptsOnly(exit.cause), testCase.name).toBe(true);
          }
          expect(calls, testCase.name).toEqual([]);
        }),
      );
    }),
  );
});
