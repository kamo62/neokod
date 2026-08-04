import type { NormalizedIssue } from "@neokod/contracts";
import { NormalizedIssueSchema } from "@neokod/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { TrackerAdapterRegistry } from "./Adapter.ts";
import { unsupportedTrackerKind } from "./Errors.ts";
import { makeMemoryTrackerAdapter } from "./MemoryAdapter.ts";
import { TrackerRegistryWithFactories } from "./Registry.ts";
import type { AdapterFactories } from "./Registry.ts";

const makeIssue = (id: string, state = "open"): NormalizedIssue =>
  NormalizedIssueSchema.make({
    id,
    identifier: `#${id}`,
    title: `Issue ${id}`,
    description: null,
    priority: null,
    state,
    nativeRef: null,
    branchName: null,
    url: null,
    assigneeId: null,
    labels: [],
    blockedBy: [],
    dispatchable: true,
    createdAt: null,
    updatedAt: null,
  });

const memoryFactory = (_provider: Readonly<Record<string, unknown>>) =>
  makeMemoryTrackerAdapter({
    issues: [makeIssue("1"), makeIssue("2"), makeIssue("3", "closed")],
    activeStates: ["open"],
    terminalStates: ["closed"],
  });

const memoryFactories: AdapterFactories = new Map([["github", memoryFactory]]);

const layer = it.layer(TrackerRegistryWithFactories(memoryFactories));

layer("TrackerAdapterRegistry", (it) => {
  it.effect("resolves a registered adapter and lists candidate issues", () =>
    Effect.gen(function* () {
      const registry = yield* TrackerAdapterRegistry;
      const adapter = yield* registry.resolve("github", {}, { repositoryPath: "/repo" });
      const issues = yield* adapter.listCandidateIssues();
      expect(issues.map((i) => i.id)).toEqual(["1", "2"]);
    }),
  );

  it.effect("refreshIssues returns only requested ids", () =>
    Effect.gen(function* () {
      const registry = yield* TrackerAdapterRegistry;
      const adapter = yield* registry.resolve("github", {}, { repositoryPath: "/repo" });
      const issues = yield* adapter.refreshIssues(["1", "3"]);
      expect(issues.map((i) => i.id).sort()).toEqual(["1", "3"]);
    }),
  );

  it.effect("unregistered kind fails with unsupported_tracker_kind", () =>
    Effect.gen(function* () {
      const registry = yield* TrackerAdapterRegistry;
      const result = yield* Effect.result(registry.resolve("jira", {}));
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure).toEqual(unsupportedTrackerKind("jira"));
      }
    }),
  );
});
