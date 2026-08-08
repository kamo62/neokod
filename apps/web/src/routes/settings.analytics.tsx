import { createFileRoute } from "@tanstack/react-router";

import { AnalyticsSettingsPanel } from "../components/settings/AnalyticsSettings";

export const Route = createFileRoute("/settings/analytics")({
  component: AnalyticsSettingsPanel,
});
