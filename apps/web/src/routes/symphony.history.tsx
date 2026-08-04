import { HistoryIcon } from "lucide-react";
import { createFileRoute } from "@tanstack/react-router";

import { SymphonyEmptyState } from "../components/symphony/SymphonyEmptyState";

function SymphonyHistoryRoute() {
  return (
    <SymphonyEmptyState
      icon={HistoryIcon}
      title="No run history yet"
      description="Completed and failed Symphony runs will appear here once the mode has activity."
    />
  );
}

export const Route = createFileRoute("/symphony/history")({
  component: SymphonyHistoryRoute,
});
