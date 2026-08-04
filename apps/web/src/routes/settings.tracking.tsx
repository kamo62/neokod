import { createFileRoute } from "@tanstack/react-router";

import { TrackingSettingsPanel } from "../components/settings/TrackingSettings";

export const Route = createFileRoute("/settings/tracking")({
  component: TrackingSettingsPanel,
});
