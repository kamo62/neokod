import { it } from "@effect/vitest";

import { parseEvidenceFile } from "./HandoffFile.ts";

it("keeps the summary when an unknown heading follows it", () => {
  const parsed = parseEvidenceFile(
    "# Implementation Summary\nAdded caching.\n\n## Validation\n- ran npm test\n\n## Risks\n- [high] cold start regression\n",
  );
  if (parsed.implementationSummary !== "Added caching.") {
    throw new Error(`expected summary to survive, got ${JSON.stringify(parsed)}`);
  }
  if (parsed.risks.length !== 1 || parsed.risks[0]?.text !== "cold start regression") {
    throw new Error(`expected risks to parse, got ${JSON.stringify(parsed.risks)}`);
  }
  if (parsed.assumptions.length !== 0) {
    throw new Error(`expected no assumptions, got ${JSON.stringify(parsed.assumptions)}`);
  }
});

it("ignores bullets under an unknown heading", () => {
  const parsed = parseEvidenceFile(
    "# Implementation Summary\nDone.\n\n## Files changed\n- a.ts\n\n## Risks\n- [high] r\n",
  );
  const all = JSON.stringify(parsed);
  if (all.includes("a.ts")) {
    throw new Error(`unknown heading leaked: ${all}`);
  }
});

it("an unknown heading before any known heading is harmless", () => {
  const parsed = parseEvidenceFile("# Handoff\n\n# Implementation Summary\nDone.");
  if (parsed.implementationSummary !== "Done.") {
    throw new Error(`expected Done, got ${JSON.stringify(parsed)}`);
  }
});

it("parses the canonical shape", () => {
  const parsed = parseEvidenceFile(
    "# Implementation Summary\nImplemented the feature with caching.\n\n## Assumptions\n- Cache invalidation is out of scope\n\n## Risks\n- [high] New caching layer may regress cold starts\n\n## Unresolved\n- Benchmark cold-start latency\n",
  );
  if (!parsed.implementationSummary.includes("Implemented the feature")) {
    throw new Error(`bad summary: ${JSON.stringify(parsed)}`);
  }
  if (
    parsed.assumptions.length !== 1 ||
    parsed.risks.length !== 1 ||
    parsed.unresolved.length !== 1
  ) {
    throw new Error(`bad sections: ${JSON.stringify(parsed)}`);
  }
});
