import * as NodeAssert from "node:assert/strict";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe } from "vite-plus/test";
import { ProviderInstanceId } from "@neokod/contracts";
import { createModelSelection } from "@neokod/shared/model";

import { makeCopilotTextGeneration } from "./CopilotTextGeneration.ts";

const modelSelection = createModelSelection(ProviderInstanceId.make("githubCopilot"), "gpt-5");
const miniModelSelection = createModelSelection(
  ProviderInstanceId.make("githubCopilot"),
  "gpt-5-mini",
);

interface FakeSession {
  readonly sendAndWait: (options: { prompt: string }) => Promise<{ data: { content: string } }>;
  readonly disconnect: () => Promise<void>;
}

function makeFakeClient(input: {
  readonly reply: string;
  readonly onCreateSession?: (config: Record<string, unknown>) => void;
}) {
  const disconnectCalls: Array<true> = [];
  const client = {
    createSession: async (config: Record<string, unknown>) => {
      input.onCreateSession?.(config);
      const session: FakeSession = {
        sendAndWait: async () => ({ data: { content: input.reply } }),
        disconnect: async () => {
          disconnectCalls.push(true);
        },
      };
      return session as unknown as Awaited<
        ReturnType<Parameters<typeof makeCopilotTextGeneration>[0]["createSession"]>
      >;
    },
  };
  return { client, disconnectCalls };
}

describe("CopilotTextGeneration", () => {
  it.effect("generates a commit message from GitHub Copilot's JSON reply", () =>
    Effect.gen(function* () {
      const { client, disconnectCalls } = makeFakeClient({
        reply: '{"subject": "Fix the bug", "body": "Details here."}',
      });
      const textGeneration = yield* makeCopilotTextGeneration(client);

      const result = yield* textGeneration.generateCommitMessage({
        cwd: "/tmp/project",
        branch: "main",
        stagedSummary: "1 file changed",
        stagedPatch: "diff --git a/a b/a",
        modelSelection,
      });

      NodeAssert.equal(result.subject, "Fix the bug");
      NodeAssert.equal(result.body, "Details here.");
      NodeAssert.equal(disconnectCalls.length, 1);
    }),
  );

  it.effect("extracts a JSON object embedded in extra prose", () =>
    Effect.gen(function* () {
      const { client } = makeFakeClient({
        reply: 'Sure thing!\n{"title": "Add feature", "body": "Adds the feature."}\nDone.',
      });
      const textGeneration = yield* makeCopilotTextGeneration(client);

      const result = yield* textGeneration.generatePrContent({
        cwd: "/tmp/project",
        baseBranch: "main",
        headBranch: "feature",
        commitSummary: "1 commit",
        diffSummary: "1 file changed",
        diffPatch: "diff --git a/a b/a",
        modelSelection,
      });

      NodeAssert.equal(result.title, "Add feature");
    }),
  );

  it.effect("fails with a TextGenerationError when the model returns empty output", () =>
    Effect.gen(function* () {
      const { client } = makeFakeClient({ reply: "" });
      const textGeneration = yield* makeCopilotTextGeneration(client);

      const error = yield* textGeneration
        .generateThreadTitle({
          cwd: "/tmp/project",
          message: "hello",
          modelSelection,
        })
        .pipe(Effect.flip);

      NodeAssert.equal(error._tag, "TextGenerationError");
      NodeAssert.equal(error.detail, "GitHub Copilot returned empty output.");
    }),
  );

  it.effect(
    "fails with a TextGenerationError when the reply is not valid JSON for the schema",
    () =>
      Effect.gen(function* () {
        const { client } = makeFakeClient({ reply: "not json at all" });
        const textGeneration = yield* makeCopilotTextGeneration(client);

        const error = yield* textGeneration
          .generateBranchName({
            cwd: "/tmp/project",
            message: "hello",
            modelSelection,
          })
          .pipe(Effect.flip);

        NodeAssert.equal(error._tag, "TextGenerationError");
        NodeAssert.equal(error.detail, "GitHub Copilot returned invalid structured output.");
      }),
  );

  it.effect("passes the requested model and working directory to createSession", () =>
    Effect.gen(function* () {
      const capturedConfigs: Array<Record<string, unknown>> = [];
      const { client } = makeFakeClient({
        reply: '{"title": "T"}',
        onCreateSession: (config) => capturedConfigs.push(config),
      });
      const textGeneration = yield* makeCopilotTextGeneration(client);

      yield* textGeneration.generateThreadTitle({
        cwd: "/tmp/some-project",
        message: "hello",
        modelSelection: miniModelSelection,
      });

      NodeAssert.equal(capturedConfigs[0]?.model, "gpt-5-mini");
      NodeAssert.equal(capturedConfigs[0]?.workingDirectory, "/tmp/some-project");
      NodeAssert.equal(capturedConfigs[0]?.streaming, false);
    }),
  );
});
