import { createFileRoute } from "@tanstack/react-router";

import { SymphonyAttentionView } from "../components/symphony/SymphonyAttentionView";

export const Route = createFileRoute("/symphony/attention")({
  component: SymphonyAttentionView,
});
