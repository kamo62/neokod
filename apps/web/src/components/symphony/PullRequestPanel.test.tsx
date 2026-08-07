import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { makeModelReview } from "./PullRequestPanel.test-fixtures.ts";
import { ModelReviewStrip } from "./PullRequestPanel.tsx";

describe("ModelReviewStrip", () => {
  it("renders the aggregate gate and compact reviewer chips", () => {
    const html = renderToStaticMarkup(<ModelReviewStrip modelReview={makeModelReview()} />);

    expect(html).toContain("Model review");
    expect(html).toContain("all approve");
    expect(html).toContain("Review blocked");
    expect(html).toContain("1 of 2 approve");
    expect(html).toContain('aria-label="gpt-5.6-sol: Approve"');
    expect(html).toContain('aria-label="claude-fable-5: Changes"');
    expect(html).toContain('aria-expanded="false"');
  });

  it("labels advisory review without presenting it as a merge approval", () => {
    const html = renderToStaticMarkup(
      <ModelReviewStrip
        modelReview={makeModelReview({ require: "advisory", verdict: "advisory", passed: true })}
      />,
    );

    expect(html).toContain("Advisory");
    expect(html).not.toContain("Review passed");
  });
});
