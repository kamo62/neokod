import { createFileRoute } from "@tanstack/react-router";

import { SymphonyRunningView } from "../components/symphony/SymphonyRunningView";

export const Route = createFileRoute("/symphony/running")({
  component: SymphonyRunningView,
});
