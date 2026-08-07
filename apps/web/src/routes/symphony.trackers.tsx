import { createFileRoute } from "@tanstack/react-router";

import { SymphonyTrackersView } from "../components/symphony/SymphonyTrackersView";

export const Route = createFileRoute("/symphony/trackers")({
  component: SymphonyTrackersView,
});
