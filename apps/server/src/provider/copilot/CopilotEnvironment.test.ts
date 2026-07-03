import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  makeCopilotContinuationGroupKey,
  resolveCopilotBaseDirectory,
} from "./CopilotEnvironment.ts";

it.layer(NodeServices.layer)("CopilotEnvironment", (it) => {
  describe("Copilot base-directory resolution", () => {
    it.effect("leaves baseDirectory undefined when unset, letting the SDK use ~/.copilot", () =>
      Effect.gen(function* () {
        expect(yield* resolveCopilotBaseDirectory({ baseDirectory: "" })).toBe(undefined);
        expect(yield* makeCopilotContinuationGroupKey({ baseDirectory: "" })).toBe(
          "githubCopilot:base:default",
        );
      }),
    );

    it.effect("expands and resolves a configured base directory", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const baseDirectory = "~/.copilot-work";
        const resolved = path.resolve(NodeOS.homedir(), ".copilot-work");

        expect(yield* resolveCopilotBaseDirectory({ baseDirectory })).toBe(resolved);
        expect(yield* makeCopilotContinuationGroupKey({ baseDirectory })).toBe(
          `githubCopilot:base:${resolved}`,
        );
      }),
    );

    it.effect("gives two instances with the same base directory the same continuation key", () =>
      Effect.gen(function* () {
        const baseDirectory = "/srv/copilot-shared";
        const first = yield* makeCopilotContinuationGroupKey({ baseDirectory });
        const second = yield* makeCopilotContinuationGroupKey({ baseDirectory });
        expect(first).toBe(second);
      }),
    );
  });
});
