/**
 * CopilotEnvironment — base-directory + continuation-key helpers for the
 * GitHub Copilot driver. Mirrors `Drivers/ClaudeHome.ts`: Claude keys its
 * continuation group on a resolved `HOME`, Copilot keys on its own
 * `baseDirectory` (the SDK's `COPILOT_HOME` equivalent) so two instances
 * pointed at different Copilot state directories never share sessions.
 *
 * @module provider/copilot/CopilotEnvironment
 */
import type { CopilotSettings } from "@neokod/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { expandHomePath } from "../../pathExpansion.ts";

export const resolveCopilotBaseDirectory = Effect.fn("resolveCopilotBaseDirectory")(function* (
  config: Pick<CopilotSettings, "baseDirectory">,
): Effect.fn.Return<string | undefined, never, Path.Path> {
  const path = yield* Path.Path;
  const baseDirectory = config.baseDirectory.trim();
  if (baseDirectory.length === 0) {
    return undefined;
  }
  return path.resolve(expandHomePath(baseDirectory));
});

export const makeCopilotContinuationGroupKey = Effect.fn("makeCopilotContinuationGroupKey")(
  function* (
    config: Pick<CopilotSettings, "baseDirectory">,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedBaseDirectory = yield* resolveCopilotBaseDirectory(config);
    return `githubCopilot:base:${resolvedBaseDirectory ?? "default"}`;
  },
);
