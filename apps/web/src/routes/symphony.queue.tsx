import { createFileRoute } from "@tanstack/react-router";

import { SymphonyQueueView } from "../components/symphony/SymphonyQueueView";

export const Route = createFileRoute("/symphony/queue")({
  component: SymphonyQueueView,
});
