import { PlayCircleIcon } from "lucide-react";
import { createFileRoute } from "@tanstack/react-router";

import { SymphonyEmptyState } from "../components/symphony/SymphonyEmptyState";

function SymphonyRunDetailRoute() {
  const { runId } = Route.useParams();
  return (
    <SymphonyEmptyState
      icon={PlayCircleIcon}
      title="Run details are not ready"
      description={`Run ${runId} will have a detail view when Symphony execution is connected.`}
    />
  );
}

export const Route = createFileRoute("/symphony/$runId")({
  component: SymphonyRunDetailRoute,
});
