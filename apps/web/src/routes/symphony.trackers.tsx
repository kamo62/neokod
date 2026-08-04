import { TagsIcon } from "lucide-react";
import { createFileRoute } from "@tanstack/react-router";

import { SymphonyEmptyState } from "../components/symphony/SymphonyEmptyState";

function SymphonyTrackersRoute() {
  return (
    <SymphonyEmptyState
      icon={TagsIcon}
      title="No trackers connected"
      description="Tracker connections will appear here when a Symphony tracker is configured."
    />
  );
}

export const Route = createFileRoute("/symphony/trackers")({
  component: SymphonyTrackersRoute,
});
