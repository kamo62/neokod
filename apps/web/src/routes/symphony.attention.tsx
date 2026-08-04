import { TriangleAlertIcon } from "lucide-react";
import { createFileRoute } from "@tanstack/react-router";

import { SymphonyEmptyState } from "../components/symphony/SymphonyEmptyState";

function SymphonyAttentionRoute() {
  return (
    <SymphonyEmptyState
      icon={TriangleAlertIcon}
      title="Nothing needs your attention"
      description="Approvals and blocked runs will appear here when a human action is needed."
    />
  );
}

export const Route = createFileRoute("/symphony/attention")({
  component: SymphonyAttentionRoute,
});
