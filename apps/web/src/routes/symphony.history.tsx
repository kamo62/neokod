import { createFileRoute } from "@tanstack/react-router";

import { SymphonyHistoryView } from "../components/symphony/SymphonyHistoryView";

export const Route = createFileRoute("/symphony/history")({
  component: SymphonyHistoryView,
});
