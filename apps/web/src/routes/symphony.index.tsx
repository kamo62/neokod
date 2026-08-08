import { createFileRoute } from "@tanstack/react-router";

import { SymphonyOverviewView } from "../components/symphony/SymphonyOverviewView";

export const Route = createFileRoute("/symphony/")({
  component: SymphonyOverviewView,
});
