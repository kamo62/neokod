import { createFileRoute } from "@tanstack/react-router";

import { SymphonySettingsView } from "../components/symphony/SymphonySettingsView";

export const Route = createFileRoute("/symphony/settings")({
  component: SymphonySettingsView,
});
