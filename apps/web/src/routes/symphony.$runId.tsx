import { createFileRoute } from "@tanstack/react-router";

import { SymphonyRunDetailView } from "../components/symphony/SymphonyRunDetailView";

function SymphonyRunDetailRoute() {
  const { runId } = Route.useParams();
  return <SymphonyRunDetailView runId={runId} />;
}

export const Route = createFileRoute("/symphony/$runId")({
  component: SymphonyRunDetailRoute,
});
