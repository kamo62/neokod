import { SettingsIcon } from "lucide-react";
import { createFileRoute } from "@tanstack/react-router";

import { SymphonyEmptyState } from "../components/symphony/SymphonyEmptyState";

function SymphonySettingsRoute() {
  return (
    <SymphonyEmptyState
      icon={SettingsIcon}
      title="Symphony settings are not ready"
      description="Operating controls will appear here when Symphony settings are available."
    />
  );
}

export const Route = createFileRoute("/symphony/settings")({
  component: SymphonySettingsRoute,
});
