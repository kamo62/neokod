import type { ModelReviewArtefact } from "@neokod/contracts";

export const makeModelReview = (
  overrides: Partial<ModelReviewArtefact> = {},
): ModelReviewArtefact => ({
  provenance: "model",
  target: "baseBranch",
  baseRef: "main",
  headRef: "HEAD",
  baseSha: "base-sha",
  headSha: "head-sha",
  sourceHashes: ["diff-hash"],
  require: "all-approve",
  verdict: "request_changes",
  passed: false,
  reviewers: [
    {
      provenance: "model",
      provider: "codex_review",
      model: "gpt-5.6-sol",
      status: "completed",
      verdict: "approve",
      summary: "No blocking findings.",
      findings: [],
      reviewedAt: "2026-08-07T12:00:00.000Z",
    },
    {
      provenance: "model",
      provider: "claude_review",
      model: "claude-fable-5",
      status: "completed",
      verdict: "request_changes",
      summary: "A blocking issue remains.",
      findings: [
        {
          severity: "blocking",
          title: "Guard the fallback",
          detail: "The fallback bypasses the gate.",
          path: "src/gate.ts",
        },
      ],
      reviewedAt: "2026-08-07T12:00:00.000Z",
    },
  ],
  reviewedAt: "2026-08-07T12:00:00.000Z",
  ...overrides,
});
