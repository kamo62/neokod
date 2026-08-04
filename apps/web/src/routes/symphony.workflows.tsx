import { WorkflowIcon } from "lucide-react";
import { createFileRoute } from "@tanstack/react-router";

import { SymphonyEmptyState } from "../components/symphony/SymphonyEmptyState";

function SymphonyWorkflowsRoute() {
  return (
    <SymphonyEmptyState
      icon={WorkflowIcon}
      title="No workflows configured"
      description="Workflow definitions will appear here when Symphony workflow support is connected."
    />
  );
}

export const Route = createFileRoute("/symphony/workflows")({
  component: SymphonyWorkflowsRoute,
});
