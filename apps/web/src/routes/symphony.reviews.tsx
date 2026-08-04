import { GitPullRequestIcon } from "lucide-react";
import { createFileRoute } from "@tanstack/react-router";

import { SymphonyEmptyState } from "../components/symphony/SymphonyEmptyState";

function SymphonyReviewsRoute() {
  return (
    <SymphonyEmptyState
      icon={GitPullRequestIcon}
      title="No reviews ready"
      description="Review-ready Symphony runs will appear here after execution is connected."
    />
  );
}

export const Route = createFileRoute("/symphony/reviews")({
  component: SymphonyReviewsRoute,
});
