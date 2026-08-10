import { createFileRoute } from "@tanstack/react-router";
import { SymphonyProjectId } from "@neokod/contracts";

import { SymphonyProjectView } from "../components/symphony/SymphonyProjectView";

function ProjectRoute() {
  const { projectId } = Route.useParams();
  return <SymphonyProjectView projectId={SymphonyProjectId.make(projectId)} />;
}

export const Route = createFileRoute("/symphony/projects/$projectId")({
  component: ProjectRoute,
});
