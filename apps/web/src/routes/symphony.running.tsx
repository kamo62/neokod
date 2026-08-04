import { PlayCircleIcon } from "lucide-react";
import { createFileRoute } from "@tanstack/react-router";

import { SymphonyEmptyState } from "../components/symphony/SymphonyEmptyState";

function SymphonyRunningRoute() {
  return (
    <SymphonyEmptyState
      icon={PlayCircleIcon}
      title="Nothing is running"
      description="Active Symphony runs will appear here when work is dispatched."
    />
  );
}

export const Route = createFileRoute("/symphony/running")({
  component: SymphonyRunningRoute,
});
