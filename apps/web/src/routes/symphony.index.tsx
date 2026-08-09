import { createFileRoute } from "@tanstack/react-router";

import { SymphonyProjectsView } from "../components/symphony/SymphonyProjectsView";

export const Route = createFileRoute("/symphony/")({
  component: SymphonyProjectsView,
});
