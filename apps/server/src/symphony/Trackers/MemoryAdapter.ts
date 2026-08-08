import type { NormalizedIssue, TrackerKind } from "@neokod/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import type { TrackerAdapter, AdapterProfile } from "./Adapter.ts";
import { invalidTrackerConfig } from "./Errors.ts";

/**
 * In-memory tracker adapter for tests and local development. Mirrors the
 * upstream `SymphonyElixir.Tracker.Memory` adapter: state-list and ID-refresh
 * reads over a fixed issue set, no credentials, no tools.
 */
export const makeMemoryTrackerAdapter = (options: {
  readonly issues: ReadonlyArray<NormalizedIssue>;
  readonly activeStates?: ReadonlyArray<string>;
  readonly terminalStates?: ReadonlyArray<string>;
  readonly kind?: TrackerKind;
}): Effect.Effect<TrackerAdapter> =>
  Ref.make([...options.issues]).pipe(
    Effect.map((issuesRef) => {
      const activeStates = options.activeStates ?? ["open"];
      const terminalStates = options.terminalStates ?? ["closed"];
      const kind = options.kind ?? "github";

      const validateConfiguration = () =>
        Effect.sync(() => {
          if (activeStates.length === 0 || terminalStates.length === 0) {
            throw invalidTrackerConfig("active_states and terminal_states must be non-empty");
          }
        });

      const listCandidateIssues = () =>
        Ref.get(issuesRef).pipe(
          Effect.map((issues) =>
            issues.filter((issue) =>
              activeStates.some((s) => s.trim().toLowerCase() === issue.state.trim().toLowerCase()),
            ),
          ),
        );

      const refreshIssues = (ids: ReadonlyArray<string>) =>
        Ref.get(issuesRef).pipe(
          Effect.map((issues) => {
            const wanted = new Set(ids);
            return issues.filter((issue) => wanted.has(issue.id));
          }),
        );

      const getIssue = (id: string) =>
        Ref.get(issuesRef).pipe(
          Effect.flatMap((issues) => {
            const issue = issues.find((candidate) => candidate.id === id);
            return issue === undefined
              ? Effect.fail(invalidTrackerConfig(`Issue ${id} not found in memory tracker`))
              : Effect.succeed(issue);
          }),
        );

      const probe = () => Effect.void;

      const profile: AdapterProfile = {
        kind,
        displayName: "Memory (test)",
        activeStates,
        terminalStates,
        providerKeys: [],
        scopeSelection: "Fixed in-memory issue set",
        pagination: "None",
        idMapping: "id is the dispatch identity verbatim",
        normalization: "Per SPEC 11.3 via Normalize.ts",
        errorMapping: "invalid_tracker_config for missing issues",
        agentTools: [],
      };

      return {
        validateConfiguration,
        listCandidateIssues,
        refreshIssues,
        getIssue,
        secretEnvironmentNames: () => [],
        probe,
        profile: () => profile,
      } satisfies TrackerAdapter;
    }),
  );
